// Streams API: user-defined event endpoints, each with its own dataset (fields).
//
//   /api/streams                         list / create streams
//   /api/streams/:slug                   get / update / delete a stream; POST = new event
//   /api/streams/:slug/schema            JSON Schema for the stream's event data
//   /api/streams/:slug/events            list (filter, sort, paginate) / create events
//   /api/streams/:slug/events/:id        get / update / delete one event
//   /api/streams/:slug/subscribe         live Server-Sent Events feed

import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

import { HttpError, send, readJson, paginate } from './http.js';
import { EventLog } from './event-log.js';
import { normalizeFields, validateData, parseFilterValue } from './schema.js';

const SLUG = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/;
const MAX_BATCH = 1000;
const FILTER_KEY = /^filter\[([A-Za-z_][A-Za-z0-9_]*)\](?:\[(eq|ne|gt|gte|lt|lte|contains|in)\])?$/;

export function slugify(text) {
  return String(text)
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64)
    .replace(/-+$/, '');
}

export async function createStreamsApi({ store, dataDir, authorize }) {
  const eventDir = join(dataDir, 'events');
  await mkdir(eventDir, { recursive: true });

  const logs = new Map(); // stream id -> EventLog
  for (const stream of store.data.streams) {
    logs.set(stream.id, await new EventLog(join(eventDir, `${stream.id}.jsonl`)).load());
  }

  const subscribers = new Map(); // stream id -> Set<res>
  let heartbeat = null;

  // ---- helpers -------------------------------------------------------------

  const fail = (status, message, errors) => {
    throw new HttpError(status, message, errors ? { errors } : undefined);
  };

  const getStreamOr404 = (slug) => {
    const stream = store.data.streams.find((s) => s.slug === slug);
    if (!stream) fail(404, `Stream "${slug}" not found`);
    return stream;
  };

  const summary = (stream) => {
    const log = logs.get(stream.id);
    let lastEventAt = null;
    for (const e of log.events.values()) if (!lastEventAt || e.timestamp > lastEventAt) lastEventAt = e.timestamp;
    return { ...stream, eventCount: log.size, lastEventAt };
  };

  const optionalText = (value, path, max) => {
    if (value === undefined) return undefined;
    if (value === null || value === '') return null;
    if (typeof value !== 'string') fail(400, `${path} must be a string`);
    if (value.length > max) fail(400, `${path} is too long (max ${max})`);
    return value.trim();
  };

  const parseTimestamp = (value, path) => {
    if (value === undefined || value === null) return new Date().toISOString();
    const d = typeof value === 'string' || typeof value === 'number' ? new Date(value) : null;
    if (!d || Number.isNaN(d.getTime())) fail(400, 'Validation failed', [{ path, message: 'must be an ISO 8601 date-time' }]);
    return d.toISOString();
  };

  const mediaExists = (id) => Boolean(store.getFile(id));

  const checkData = (stream, data, prefix = '') => {
    const result = validateData(stream.fields, data, { mediaExists });
    if (result.errors) {
      fail(400, 'Validation failed', result.errors.map((e) => ({ ...e, path: prefix + e.path })));
    }
    return result.data;
  };

  // ---- live subscriptions (SSE) --------------------------------------------

  function broadcast(stream, type, payload, id) {
    const subs = subscribers.get(stream.id);
    if (!subs?.size) return;
    const frame = `${id !== undefined ? `id: ${id}\n` : ''}event: ${type}\ndata: ${JSON.stringify(payload)}\n\n`;
    for (const res of subs) res.write(frame);
  }

  function subscribe(req, res, stream, url) {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.write('retry: 3000\n\n');

    // Replay anything the client missed since its last seen sequence number.
    const after = Number(req.headers['last-event-id'] ?? url.searchParams.get('after'));
    if (Number.isFinite(after) && after >= 0) {
      const missed = logs.get(stream.id).all().filter((e) => e.seq > after).sort((a, b) => a.seq - b.seq);
      for (const e of missed) res.write(`id: ${e.seq}\nevent: created\ndata: ${JSON.stringify(e)}\n\n`);
    }

    if (!subscribers.has(stream.id)) subscribers.set(stream.id, new Set());
    subscribers.get(stream.id).add(res);
    if (!heartbeat) {
      heartbeat = setInterval(() => {
        for (const subs of subscribers.values()) for (const r of subs) r.write(': ping\n\n');
      }, 25000);
      heartbeat.unref();
    }
    req.on('close', () => subscribers.get(stream.id)?.delete(res));
  }

  // ---- streams -------------------------------------------------------------

  async function listStreams(req, res, url) {
    const q = (url.searchParams.get('q') || '').toLowerCase();
    let items = store.data.streams;
    if (q) items = items.filter((s) => s.name.toLowerCase().includes(q) || s.slug.includes(q));
    items = [...items].sort((a, b) => a.name.localeCompare(b.name)).map(summary);
    send(res, 200, paginate(items, url, { defaultSize: 100, maxSize: 500 }));
  }

  async function createStream(req, res) {
    authorize(req);
    const body = await readJson(req);
    const name = optionalText(body.name, 'name', 100);
    if (!name) fail(400, 'Validation failed', [{ path: 'name', message: 'is required' }]);
    const slug = body.slug === undefined || body.slug === '' ? slugify(name) : body.slug;
    if (typeof slug !== 'string' || !SLUG.test(slug)) {
      fail(400, 'Validation failed', [{ path: 'slug', message: 'must be 1–64 lowercase letters, digits or hyphens, and not start or end with a hyphen' }]);
    }
    if (store.data.streams.some((s) => s.slug === slug)) fail(409, `A stream with slug "${slug}" already exists`);
    const { fields, errors } = normalizeFields(body.fields);
    if (errors) fail(400, 'Validation failed', errors);

    const stream = await store.addStream({
      slug,
      name,
      description: optionalText(body.description, 'description', 1000) ?? null,
      fields,
    });
    logs.set(stream.id, await new EventLog(join(eventDir, `${stream.id}.jsonl`)).load());
    send(res, 201, summary(stream));
  }

  async function updateStream(req, res, stream) {
    authorize(req);
    const body = await readJson(req);
    const patch = {};
    if (body.slug !== undefined && body.slug !== stream.slug) {
      fail(400, 'A stream slug cannot be changed — it is part of every client URL. Create a new stream instead.');
    }
    if (body.name !== undefined) {
      const name = optionalText(body.name, 'name', 100);
      if (!name) fail(400, 'Validation failed', [{ path: 'name', message: 'is required' }]);
      patch.name = name;
    }
    if (body.description !== undefined) patch.description = optionalText(body.description, 'description', 1000);
    if (body.fields !== undefined) {
      const { fields, errors } = normalizeFields(body.fields);
      if (errors) fail(400, 'Validation failed', errors);
      patch.fields = fields;
    }
    const updated = await store.updateStream(stream.id, patch);
    broadcast(stream, 'stream-updated', summary(updated));
    send(res, 200, summary(updated));
  }

  async function deleteStream(req, res, stream) {
    authorize(req);
    const result = summary(stream);
    await store.removeStream(stream.id);
    await logs.get(stream.id).destroy();
    logs.delete(stream.id);
    broadcast(stream, 'stream-deleted', { id: stream.id, slug: stream.slug });
    for (const r of subscribers.get(stream.id) || []) r.end();
    subscribers.delete(stream.id);
    send(res, 200, result);
  }

  function jsonSchema(stream) {
    const typeMap = {
      string: { type: 'string' },
      text: { type: 'string' },
      integer: { type: 'integer' },
      number: { type: 'number' },
      boolean: { type: 'boolean' },
      datetime: { type: 'string', format: 'date-time' },
      json: {},
      media: { type: 'string', format: 'uuid', description: 'Media file id' },
    };
    const properties = {};
    for (const f of stream.fields) {
      const base = f.type === 'enum' ? { type: 'string', enum: f.options } : { ...typeMap[f.type] };
      if (f.maxLength && f.type !== 'enum') base.maxLength = f.maxLength;
      if (f.min !== undefined) base.minimum = f.min;
      if (f.max !== undefined) base.maximum = f.max;
      if (f.description) base.description = [f.description, base.description].filter(Boolean).join(' — ');
      properties[f.name] = f.required ? base : { anyOf: [base, { type: 'null' }] };
    }
    return {
      $schema: 'https://json-schema.org/draft/2020-12/schema',
      title: stream.name,
      description: stream.description || undefined,
      type: 'object',
      ...(stream.fields.length
        ? { properties, required: stream.fields.filter((f) => f.required).map((f) => f.name), additionalProperties: false }
        : {}),
    };
  }

  // ---- events --------------------------------------------------------------

  const fieldValue = (event, name) => event.data?.[name];

  function buildFilters(stream, url) {
    const filters = [];
    const byName = new Map(stream.fields.map((f) => [f.name, f]));
    for (const [key, raw] of url.searchParams) {
      const m = FILTER_KEY.exec(key);
      if (!m) {
        if (key.startsWith('filter[')) fail(400, `Unsupported filter "${key}"`);
        continue;
      }
      const [, name, op = 'eq'] = m;
      const field = byName.get(name);
      if (stream.fields.length && !field) fail(400, `Unknown field "${name}" in filter`);
      filters.push({ name, op, raw, type: field?.type });
    }
    return (event) =>
      filters.every(({ name, op, raw, type }) => {
        const v = fieldValue(event, name);
        if (op === 'contains') return v != null && String(typeof v === 'object' ? JSON.stringify(v) : v).toLowerCase().includes(raw.toLowerCase());
        if (op === 'in') return raw.split(',').some((part) => parseFilterValue(type, part, v) === v);
        const x = parseFilterValue(type, raw, v);
        if (op === 'eq') return v === x;
        if (op === 'ne') return v !== x;
        if (v === null || v === undefined) return false;
        if (op === 'gt') return v > x;
        if (op === 'gte') return v >= x;
        if (op === 'lt') return v < x;
        return v <= x; // lte
      });
  }

  function listEvents(req, res, stream, url) {
    let items = logs.get(stream.id).all();

    const bound = (param) => {
      const raw = url.searchParams.get(param);
      if (raw === null) return null;
      const d = new Date(raw);
      if (Number.isNaN(d.getTime())) fail(400, `${param} must be an ISO 8601 date-time`);
      return d.toISOString();
    };
    const since = bound('since');
    const until = bound('until');
    if (since) items = items.filter((e) => e.timestamp >= since);
    if (until) items = items.filter((e) => e.timestamp < until);

    const after = url.searchParams.get('after');
    if (after !== null) {
      const n = Number(after);
      if (!Number.isInteger(n)) fail(400, 'after must be an integer sequence number');
      items = items.filter((e) => e.seq > n);
    }

    const match = buildFilters(stream, url);
    items = items.filter(match);

    const defaultSort = after !== null ? 'seq:asc' : 'timestamp:desc';
    const [key, dir = 'asc'] = (url.searchParams.get('sort') || defaultSort).split(':');
    const sign = dir === 'desc' ? -1 : 1;
    let get;
    if (['timestamp', 'createdAt', 'updatedAt', 'seq'].includes(key)) get = (e) => e[key];
    else if (key.startsWith('data.')) {
      const name = key.slice(5);
      if (stream.fields.length && !stream.fields.some((f) => f.name === name)) fail(400, `Cannot sort by unknown field "${name}"`);
      get = (e) => fieldValue(e, name);
    } else fail(400, 'sort must be timestamp, createdAt, updatedAt, seq or data.<field>, optionally with :asc or :desc');

    items.sort((a, b) => {
      const av = get(a);
      const bv = get(b);
      if (av == null && bv == null) return a.seq - b.seq;
      if (av == null) return 1; // nulls last regardless of direction
      if (bv == null) return -1;
      const cmp = typeof av === 'number' && typeof bv === 'number' ? av - bv : String(av).localeCompare(String(bv));
      return cmp * sign || (a.seq - b.seq) * sign;
    });

    send(res, 200, paginate(items, url, { defaultSize: 25, maxSize: 500 }));
  }

  async function createEvents(req, res, stream) {
    authorize(req);
    const body = await readJson(req, 10 * 1024 * 1024);
    const batch = Array.isArray(body);
    const inputs = batch ? body : [body];
    if (!inputs.length) fail(400, 'No events provided');
    if (inputs.length > MAX_BATCH) fail(400, `At most ${MAX_BATCH} events per request`);

    // Validate everything first so a batch is all-or-nothing.
    const prepared = inputs.map((input, i) => {
      const prefix = batch ? `[${i}].` : '';
      if (!input || typeof input !== 'object' || Array.isArray(input)) {
        fail(400, 'Validation failed', [{ path: `${prefix}`.replace(/\.$/, '') || 'body', message: 'must be an object like { "data": { … } }' }]);
      }
      if (!('data' in input)) fail(400, 'Validation failed', [{ path: `${prefix}data`, message: 'is required — wrap the event fields in { "data": { … } }' }]);
      return {
        data: checkData(stream, input.data, prefix),
        timestamp: parseTimestamp(input.timestamp, `${prefix}timestamp`),
      };
    });

    const log = logs.get(stream.id);
    const now = new Date().toISOString();
    const events = prepared.map(({ data, timestamp }) => ({
      id: randomUUID(),
      seq: log.nextSeq(),
      stream: stream.slug,
      timestamp,
      data,
      createdAt: now,
      updatedAt: now,
    }));
    await log.put(events);
    for (const e of events) broadcast(stream, 'created', e, e.seq);
    send(res, 201, batch ? events : events[0]);
  }

  async function updateEvent(req, res, stream, id, merge) {
    authorize(req);
    const log = logs.get(stream.id);
    const existing = log.get(id);
    if (!existing) fail(404, 'Event not found');
    const body = await readJson(req, 10 * 1024 * 1024);
    if (!body || typeof body !== 'object' || Array.isArray(body)) fail(400, 'Body must be an object like { "data": { … } }');
    if (!merge && !('data' in body)) fail(400, 'Validation failed', [{ path: 'data', message: 'is required for PUT (use PATCH for partial updates)' }]);

    let data = existing.data;
    if ('data' in body) {
      const incoming = body.data;
      if (merge && (!incoming || typeof incoming !== 'object' || Array.isArray(incoming))) {
        fail(400, 'Validation failed', [{ path: 'data', message: 'must be a JSON object' }]);
      }
      data = checkData(stream, merge ? { ...existing.data, ...incoming } : incoming);
    }
    const updated = {
      ...existing,
      data,
      timestamp: body.timestamp !== undefined ? parseTimestamp(body.timestamp, 'timestamp') : existing.timestamp,
      updatedAt: new Date().toISOString(),
    };
    await log.put([updated]);
    broadcast(stream, 'updated', updated);
    send(res, 200, updated);
  }

  async function deleteEvent(req, res, stream, id) {
    authorize(req);
    const log = logs.get(stream.id);
    const existing = log.get(id);
    if (!existing) fail(404, 'Event not found');
    await log.remove([id]);
    broadcast(stream, 'deleted', { id, seq: existing.seq });
    send(res, 200, existing);
  }

  // ---- router --------------------------------------------------------------

  const finish = async (pending) => {
    await pending;
    return true;
  };

  async function route(req, res, url) {
    let parts;
    try {
      parts = url.pathname.replace(/\/+$/, '').split('/').slice(3).map(decodeURIComponent); // after /api/streams
    } catch {
      fail(400, 'Malformed URL');
    }
    const m = req.method;

    if (parts.length === 0) {
      if (m === 'GET') return finish(listStreams(req, res, url));
      if (m === 'POST') return finish(createStream(req, res));
      fail(405, 'Method not allowed');
    }

    const stream = getStreamOr404(parts[0]);

    if (parts.length === 1) {
      if (m === 'GET') return finish(send(res, 200, summary(stream)));
      if (m === 'POST') return finish(createEvents(req, res, stream)); // shortcut: POST /api/streams/:slug
      if (m === 'PUT' || m === 'PATCH') return finish(updateStream(req, res, stream));
      if (m === 'DELETE') return finish(deleteStream(req, res, stream));
      fail(405, 'Method not allowed');
    }

    if (parts.length === 2 && parts[1] === 'schema' && m === 'GET') return finish(send(res, 200, jsonSchema(stream)));
    if (parts.length === 2 && parts[1] === 'subscribe' && m === 'GET') return finish(subscribe(req, res, stream, url));

    if (parts[1] === 'events') {
      if (parts.length === 2) {
        if (m === 'GET') return finish(listEvents(req, res, stream, url));
        if (m === 'POST') return finish(createEvents(req, res, stream));
        fail(405, 'Method not allowed');
      }
      if (parts.length === 3) {
        const id = parts[2];
        if (m === 'GET') {
          const event = logs.get(stream.id).get(id);
          if (!event) fail(404, 'Event not found');
          return finish(send(res, 200, event));
        }
        if (m === 'PUT') return finish(updateEvent(req, res, stream, id, false));
        if (m === 'PATCH') return finish(updateEvent(req, res, stream, id, true));
        if (m === 'DELETE') return finish(deleteEvent(req, res, stream, id));
        fail(405, 'Method not allowed');
      }
    }
    return false;
  }

  function close() {
    clearInterval(heartbeat);
    heartbeat = null;
    for (const subs of subscribers.values()) for (const r of subs) r.end();
    subscribers.clear();
  }

  return { route, close };
}
