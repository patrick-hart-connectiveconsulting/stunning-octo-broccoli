// Streams API: user-defined data streams (events, posts, products…). Each stream
// has a dataset (fields) and an ordered log of items.
//
//   /api/streams                              list / create streams
//   /api/streams/:slug                        get / update / delete a stream; POST = new item
//   /api/streams/:slug/schema                 JSON Schema for the stream's item data
//   /api/streams/:slug/items                  list (filter, sort, paginate) / create items
//   /api/streams/:slug/items/:id              get / update / delete one item
//   /api/streams/:slug/items/:id/publish      publish (draft & publish streams)
//   /api/streams/:slug/items/:id/unpublish    back to draft
//   /api/streams/:slug/subscribe              live Server-Sent Events feed
//   /api/streams/:slug/webhooks/:id/test      send a test delivery
//
// `/events` is accepted everywhere `/items` is (the original name).

import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

import { HttpError, send, readJson, paginate } from './http.js';
import { EventLog } from './event-log.js';
import { normalizeFields, validateData, parseFilterValue, fieldJsonSchema, isEmptyValue } from './schema.js';
import { getTemplate } from './templates.js';
import { normalizeWebhooks, WebhookDispatcher } from './webhooks.js';

const SLUG = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/;
const MAX_BATCH = 1000;
const FILTER_KEY = /^filter\[([A-Za-z_][A-Za-z0-9_]*)\](?:\[(eq|ne|gt|gte|lt|lte|contains|in)\])?$/;
const DAY = 86400000;

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

const fail = (status, message, errors) => {
  throw new HttpError(status, message, errors ? { errors } : undefined);
};

function normalizeLabels(input) {
  if (input === undefined || input === null) return { singular: 'item', plural: 'items' };
  const errors = [];
  const out = {};
  for (const key of ['singular', 'plural']) {
    const v = typeof input[key] === 'string' ? input[key].trim() : '';
    if (!v || v.length > 40) errors.push({ path: `labels.${key}`, message: 'must be 1–40 characters' });
    out[key] = v;
  }
  return errors.length ? { errors } : { labels: out };
}

function normalizeRetention(input) {
  if (input === undefined || input === null) return { retention: { maxItems: null, maxAgeDays: null } };
  const errors = [];
  const maxItems = input.maxItems ?? null;
  const maxAgeDays = input.maxAgeDays ?? null;
  if (maxItems !== null && (!Number.isInteger(maxItems) || maxItems < 1 || maxItems > 10000000)) {
    errors.push({ path: 'retention.maxItems', message: 'must be an integer between 1 and 10000000, or null' });
  }
  if (maxAgeDays !== null && (typeof maxAgeDays !== 'number' || !(maxAgeDays > 0) || maxAgeDays > 36500)) {
    errors.push({ path: 'retention.maxAgeDays', message: 'must be a number of days between 0 and 36500, or null' });
  }
  return errors.length ? { errors } : { retention: { maxItems, maxAgeDays } };
}

/** Fills in properties added after a stream was first created. */
function upgradeStream(stream) {
  stream.labels ??= { singular: 'item', plural: 'items' };
  stream.template ??= 'blank';
  stream.draftAndPublish ??= false;
  stream.retention ??= { maxItems: null, maxAgeDays: null };
  stream.webhooks ??= [];
  return stream;
}

export async function createStreamsApi({ store, dataDir, authorize, isAuthorized, webhookOptions = {} }) {
  const eventDir = join(dataDir, 'events');
  await mkdir(eventDir, { recursive: true });

  const logs = new Map(); // stream id -> EventLog
  for (const stream of store.data.streams) {
    upgradeStream(stream);
    logs.set(stream.id, await new EventLog(join(eventDir, `${stream.id}.jsonl`)).load());
  }

  const subscribers = new Map(); // stream id -> Set<{ res, authed }>
  let heartbeat = null;

  const webhooks = new WebhookDispatcher({
    ...webhookOptions,
    onResult(streamId, hookId, result) {
      const hook = store.getStream(streamId)?.webhooks.find((w) => w.id === hookId);
      if (!hook) return;
      hook.lastDelivery = result;
      store.flush().catch(() => {});
    },
  });

  // Hourly sweep for age-based retention.
  const sweeper = setInterval(() => {
    for (const s of store.data.streams) if (s.retention.maxAgeDays) enforceRetention(s).catch(() => {});
  }, 3600000);
  sweeper.unref();

  // ---- helpers -------------------------------------------------------------

  const getStreamOr404 = (slug) => {
    const stream = store.data.streams.find((s) => s.slug === slug);
    if (!stream) fail(404, `Stream "${slug}" not found`);
    return stream;
  };

  const isVisible = (stream, item) => !stream.draftAndPublish || item.publishedAt != null;

  const summary = (stream, authed) => {
    const log = logs.get(stream.id);
    let itemCount = 0;
    let draftCount = 0;
    let lastItemAt = null;
    for (const item of log.events.values()) {
      const visible = isVisible(stream, item);
      if (!visible) draftCount++;
      if (!visible && !authed) continue;
      itemCount++;
      if (!lastItemAt || item.timestamp > lastItemAt) lastItemAt = item.timestamp;
    }
    const { webhooks: hooks, ...rest } = stream;
    return {
      ...rest,
      itemCount,
      ...(stream.draftAndPublish && authed ? { draftCount } : {}),
      lastItemAt,
      ...(authed ? { webhooks: hooks } : {}),
    };
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

  /** value -> item id, for every unique/uid field. Built once per request. */
  function uniqueIndex(stream) {
    const index = new Map();
    for (const f of stream.fields) if (f.unique || f.type === 'uid') index.set(f.name, new Map());
    if (!index.size) return index;
    for (const item of logs.get(stream.id).events.values()) {
      for (const [name, map] of index) {
        const v = item.data?.[name];
        if (v != null) map.set(v, item.id);
      }
    }
    return index;
  }

  /**
   * Validates item data: generates empty uid fields from their target field,
   * checks types/required, then enforces uniqueness (bumping generated uids
   * with -2, -3… instead of failing). Reserves the values in `index`.
   */
  function prepareData(stream, raw, { id, index, enforceRequired, prefix = '' }) {
    let data = raw;
    const generated = new Set();
    if (data && typeof data === 'object' && !Array.isArray(data)) {
      data = { ...data };
      for (const f of stream.fields) {
        if (f.type !== 'uid' || !f.targetField || !isEmptyValue(data[f.name])) continue;
        const source = data[f.targetField];
        const base = typeof source === 'string' ? slugify(source).slice(0, f.maxLength - 6).replace(/-+$/, '') : '';
        if (base) {
          data[f.name] = base;
          generated.add(f.name);
        }
      }
    }

    const result = validateData(stream.fields, data, { mediaExists, enforceRequired });
    if (result.errors) fail(400, 'Validation failed', result.errors.map((e) => ({ ...e, path: prefix + e.path })));
    const out = result.data;

    const errors = [];
    for (const [name, taken] of index) {
      const v = out[name];
      if (v == null) continue;
      const clash = (candidate) => taken.has(candidate) && taken.get(candidate) !== id;
      if (generated.has(name)) {
        let candidate = v;
        for (let n = 2; clash(candidate); n++) candidate = `${v}-${n}`;
        out[name] = candidate;
      } else if (clash(v)) {
        errors.push({ path: `${prefix}data.${name}`, message: 'must be unique — another item already uses this value' });
      }
    }
    if (errors.length) fail(400, 'Validation failed', errors);
    for (const [name, taken] of index) if (out[name] != null) taken.set(out[name], id);
    return out;
  }

  /** Keeps only keys that are fields of the stream (drops data of removed fields). */
  const currentKeys = (stream, data) =>
    stream.fields.length ? Object.fromEntries(stream.fields.filter((f) => f.name in data).map((f) => [f.name, data[f.name]])) : { ...data };

  // ---- change notifications (SSE + webhooks) -------------------------------

  /**
   * Notifies subscribers and webhooks of an item change. Anonymous subscribers
   * see the public view: drafts are hidden, publishing looks like `created`
   * and unpublishing like `deleted`.
   */
  function notify(stream, type, item, { wasVisible = false, webhook = true } = {}) {
    if (webhook) webhooks.dispatch(stream, type, item);
    const subs = subscribers.get(stream.id);
    if (!subs?.size) return;
    const nowVisible = isVisible(stream, item);
    const frame = (event, payload, id) => `${id !== undefined ? `id: ${id}\n` : ''}event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`;
    const ref = { id: item.id, seq: item.seq };

    const authedFrame = frame(type, type === 'deleted' ? ref : item, type === 'created' ? item.seq : undefined);
    let publicFrame = null;
    if (type === 'created' && nowVisible) publicFrame = frame('created', item, item.seq);
    else if (type === 'updated' && nowVisible) publicFrame = frame('updated', item);
    else if (type === 'published' && !wasVisible) publicFrame = frame('created', item);
    else if ((type === 'unpublished' || type === 'deleted') && wasVisible) publicFrame = frame('deleted', ref);

    for (const sub of subs) {
      if (sub.authed) sub.res.write(authedFrame);
      else if (publicFrame) sub.res.write(publicFrame);
    }
  }

  function notifyStream(stream, type, payload) {
    for (const sub of subscribers.get(stream.id) || []) {
      const body = type === 'stream-updated' ? summary(stream, sub.authed) : payload;
      sub.res.write(`event: ${type}\ndata: ${JSON.stringify(body)}\n\n`);
    }
  }

  function subscribe(req, res, stream, url) {
    const authed = isAuthorized(req, url);
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.write('retry: 3000\n\n');

    // Replay anything the client missed since its last seen sequence number.
    const rawAfter = req.headers['last-event-id'] ?? url.searchParams.get('after');
    const after = rawAfter === null || rawAfter === undefined || rawAfter === '' ? NaN : Number(rawAfter);
    if (Number.isInteger(after) && after >= 0) {
      const missed = logs.get(stream.id).all()
        .filter((e) => e.seq > after && (authed || isVisible(stream, e)))
        .sort((a, b) => a.seq - b.seq);
      for (const e of missed) res.write(`id: ${e.seq}\nevent: created\ndata: ${JSON.stringify(e)}\n\n`);
    }

    if (!subscribers.has(stream.id)) subscribers.set(stream.id, new Set());
    const sub = { res, authed };
    subscribers.get(stream.id).add(sub);
    if (!heartbeat) {
      heartbeat = setInterval(() => {
        for (const subs of subscribers.values()) for (const s of subs) s.res.write(': ping\n\n');
      }, 25000);
      heartbeat.unref();
    }
    req.on('close', () => subscribers.get(stream.id)?.delete(sub));
  }

  // ---- retention -----------------------------------------------------------

  async function enforceRetention(stream) {
    const { maxItems, maxAgeDays } = stream.retention;
    if (!maxItems && !maxAgeDays) return 0;
    const log = logs.get(stream.id);
    if (!log) return 0;
    let items = log.all();
    const victims = [];
    if (maxAgeDays) {
      const cutoff = new Date(Date.now() - maxAgeDays * DAY).toISOString();
      items = items.filter((i) => (i.timestamp < cutoff ? (victims.push(i), false) : true));
    }
    if (maxItems && items.length > maxItems) {
      items.sort((a, b) => (a.timestamp < b.timestamp ? -1 : a.timestamp > b.timestamp ? 1 : a.seq - b.seq));
      victims.push(...items.slice(0, items.length - maxItems));
    }
    if (!victims.length) return 0;
    await log.remove(victims.map((v) => v.id));
    for (const v of victims) notify(stream, 'deleted', v, { wasVisible: isVisible(stream, v), webhook: false });
    return victims.length;
  }

  // ---- streams -------------------------------------------------------------

  async function listStreams(req, res, url) {
    const authed = isAuthorized(req);
    const q = (url.searchParams.get('q') || '').toLowerCase();
    let items = store.data.streams;
    if (q) items = items.filter((s) => s.name.toLowerCase().includes(q) || s.slug.includes(q));
    items = [...items].sort((a, b) => a.name.localeCompare(b.name)).map((s) => summary(s, authed));
    send(res, 200, paginate(items, url, { defaultSize: 100, maxSize: 500 }));
  }

  function collect(results) {
    const errors = results.flatMap((r) => r.errors || []);
    if (errors.length) fail(400, 'Validation failed', errors);
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

    const templateId = body.template ?? 'blank';
    const template = getTemplate(templateId);
    if (!template) fail(400, 'Validation failed', [{ path: 'template', message: 'is not a known template (see GET /api/stream-templates)' }]);

    const f = normalizeFields(body.fields ?? template.fields);
    const l = normalizeLabels(body.labels ?? template.labels);
    const r = normalizeRetention(body.retention ?? template.retention);
    const w = normalizeWebhooks(body.webhooks);
    collect([f, l, r, w]);
    if (body.draftAndPublish !== undefined && typeof body.draftAndPublish !== 'boolean') fail(400, 'draftAndPublish must be a boolean');

    const stream = await store.addStream({
      slug,
      name,
      description: optionalText(body.description, 'description', 1000) ?? null,
      template: templateId,
      labels: l.labels,
      draftAndPublish: body.draftAndPublish ?? template.draftAndPublish,
      retention: r.retention,
      fields: f.fields,
      webhooks: w.webhooks,
    });
    logs.set(stream.id, await new EventLog(join(eventDir, `${stream.id}.jsonl`)).load());
    send(res, 201, summary(stream, true));
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
    const results = [];
    if (body.fields !== undefined) results.push(normalizeFields(body.fields));
    if (body.labels !== undefined) results.push(normalizeLabels(body.labels));
    if (body.retention !== undefined) results.push(normalizeRetention(body.retention));
    if (body.webhooks !== undefined) results.push(normalizeWebhooks(body.webhooks, stream.webhooks));
    collect(results);
    for (const r of results) Object.assign(patch, r);
    if (body.draftAndPublish !== undefined) {
      if (typeof body.draftAndPublish !== 'boolean') fail(400, 'draftAndPublish must be a boolean');
      patch.draftAndPublish = body.draftAndPublish;
    }

    // Turning draft & publish on: items written before it existed count as published.
    if (patch.draftAndPublish && !stream.draftAndPublish) {
      const legacy = logs.get(stream.id).all().filter((i) => i.publishedAt === undefined);
      if (legacy.length) await logs.get(stream.id).put(legacy.map((i) => ({ ...i, publishedAt: i.createdAt })));
    }

    const updated = await store.updateStream(stream.id, patch);
    if (patch.retention) await enforceRetention(updated);
    notifyStream(updated, 'stream-updated');
    send(res, 200, summary(updated, true));
  }

  async function deleteStream(req, res, stream) {
    authorize(req);
    const result = summary(stream, true);
    await store.removeStream(stream.id);
    await logs.get(stream.id).destroy();
    logs.delete(stream.id);
    notifyStream(stream, 'stream-deleted', { id: stream.id, slug: stream.slug });
    for (const sub of subscribers.get(stream.id) || []) sub.res.end();
    subscribers.delete(stream.id);
    send(res, 200, result);
  }

  function jsonSchema(stream) {
    const properties = {};
    for (const f of stream.fields) {
      const schema = fieldJsonSchema(f);
      properties[f.name] = f.required || f.type === 'tags' ? schema : { anyOf: [schema, { type: 'null' }] };
    }
    return {
      $schema: 'https://json-schema.org/draft/2020-12/schema',
      title: stream.name,
      description: stream.description || undefined,
      type: 'object',
      ...(stream.fields.length
        ? {
          properties,
          required: stream.fields.filter((f) => f.required).map((f) => f.name),
          additionalProperties: false,
        }
        : {}),
      ...(stream.draftAndPublish ? { $comment: 'Required fields are enforced when an item is published; drafts may leave them empty.' } : {}),
    };
  }

  async function testWebhook(req, res, stream, hookId) {
    authorize(req);
    const hook = stream.webhooks.find((w) => w.id === hookId);
    if (!hook) fail(404, 'Webhook not found');
    const result = await webhooks.test(stream, hook);
    hook.lastDelivery = result;
    await store.flush();
    send(res, 200, result);
  }

  // ---- items ---------------------------------------------------------------

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
    const compare = (v, op, raw, type) => {
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
    };
    return (item) =>
      filters.every(({ name, op, raw, type }) => {
        const v = item.data?.[name];
        // Arrays (tags): eq / in / contains match if any element matches; ne if none does.
        if (Array.isArray(v) && type !== 'json') {
          if (op === 'ne') return !v.some((el) => compare(el, 'eq', raw, 'string'));
          return v.some((el) => compare(el, op, raw, 'string'));
        }
        return compare(v, op, raw, type);
      });
  }

  function listItems(req, res, stream, url) {
    const authed = isAuthorized(req);
    let items = logs.get(stream.id).all();

    if (stream.draftAndPublish) {
      const status = url.searchParams.get('status') || 'published';
      if (!['published', 'draft', 'all'].includes(status)) fail(400, 'status must be published, draft or all');
      if (status !== 'published' && !authed) fail(401, 'An API token is required to read drafts');
      if (status === 'published') items = items.filter((i) => i.publishedAt != null);
      if (status === 'draft') items = items.filter((i) => i.publishedAt == null);
    }

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

    items = items.filter(buildFilters(stream, url));

    const defaultSort = after !== null ? 'seq:asc' : 'timestamp:desc';
    const [key, dir = 'asc'] = (url.searchParams.get('sort') || defaultSort).split(':');
    const sign = dir === 'desc' ? -1 : 1;
    let get;
    if (['timestamp', 'createdAt', 'updatedAt', 'publishedAt', 'seq'].includes(key)) get = (e) => e[key];
    else if (key.startsWith('data.')) {
      const name = key.slice(5);
      if (stream.fields.length && !stream.fields.some((f) => f.name === name)) fail(400, `Cannot sort by unknown field "${name}"`);
      get = (e) => e.data?.[name];
    } else fail(400, 'sort must be timestamp, createdAt, updatedAt, publishedAt, seq or data.<field>, optionally with :asc or :desc');

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

  function getItemOr404(stream, id, req) {
    const item = logs.get(stream.id).get(id);
    if (!item || (!isVisible(stream, item) && !isAuthorized(req))) fail(404, 'Item not found');
    return item;
  }

  async function createItems(req, res, stream) {
    authorize(req);
    const body = await readJson(req, 10 * 1024 * 1024);
    const batch = Array.isArray(body);
    const inputs = batch ? body : [body];
    if (!inputs.length) fail(400, 'No items provided');
    if (inputs.length > MAX_BATCH) fail(400, `At most ${MAX_BATCH} items per request`);

    // Validate everything first so a batch is all-or-nothing.
    const index = uniqueIndex(stream);
    const now = new Date().toISOString();
    const prepared = inputs.map((input, i) => {
      const prefix = batch ? `[${i}].` : '';
      if (!input || typeof input !== 'object' || Array.isArray(input)) {
        fail(400, 'Validation failed', [{ path: batch ? `[${i}]` : 'body', message: 'must be an object like { "data": { … } }' }]);
      }
      if (!('data' in input)) fail(400, 'Validation failed', [{ path: `${prefix}data`, message: 'is required — wrap the item fields in { "data": { … } }' }]);
      if (input.publish !== undefined && typeof input.publish !== 'boolean') {
        fail(400, 'Validation failed', [{ path: `${prefix}publish`, message: 'must be true or false' }]);
      }
      const publish = !stream.draftAndPublish || input.publish === true;
      const id = randomUUID();
      return {
        id,
        data: prepareData(stream, input.data, { id, index, enforceRequired: publish, prefix }),
        timestamp: parseTimestamp(input.timestamp, `${prefix}timestamp`),
        publishedAt: publish ? now : null,
      };
    });

    const log = logs.get(stream.id);
    const items = prepared.map(({ id, data, timestamp, publishedAt }) => ({
      id,
      seq: log.nextSeq(),
      stream: stream.slug,
      timestamp,
      data,
      publishedAt,
      createdAt: now,
      updatedAt: now,
    }));
    await log.put(items);
    for (const item of items) notify(stream, 'created', item);
    await enforceRetention(stream);
    send(res, 201, batch ? items : items[0]);
  }

  async function updateItem(req, res, stream, id, merge) {
    authorize(req);
    const log = logs.get(stream.id);
    const existing = log.get(id);
    if (!existing) fail(404, 'Item not found');
    const body = await readJson(req, 10 * 1024 * 1024);
    if (!body || typeof body !== 'object' || Array.isArray(body)) fail(400, 'Body must be an object like { "data": { … } }');
    if (!merge && !('data' in body)) fail(400, 'Validation failed', [{ path: 'data', message: 'is required for PUT (use PATCH for partial updates)' }]);
    if (body.publish !== undefined && typeof body.publish !== 'boolean') fail(400, 'Validation failed', [{ path: 'publish', message: 'must be true or false' }]);

    const wasVisible = isVisible(stream, existing);
    let publishedAt = existing.publishedAt ?? existing.createdAt;
    if (stream.draftAndPublish) {
      publishedAt = existing.publishedAt ?? null;
      if (body.publish === true) publishedAt ??= new Date().toISOString();
      if (body.publish === false) publishedAt = null;
    }

    let incoming = existing.data;
    if ('data' in body) {
      if (merge && (!body.data || typeof body.data !== 'object' || Array.isArray(body.data))) {
        fail(400, 'Validation failed', [{ path: 'data', message: 'must be a JSON object' }]);
      }
      incoming = merge ? { ...currentKeys(stream, existing.data), ...body.data } : body.data;
    } else {
      incoming = currentKeys(stream, existing.data);
    }
    const data = prepareData(stream, incoming, { id, index: uniqueIndex(stream), enforceRequired: publishedAt != null });

    const updated = {
      ...existing,
      data,
      publishedAt,
      timestamp: body.timestamp !== undefined ? parseTimestamp(body.timestamp, 'timestamp') : existing.timestamp,
      updatedAt: new Date().toISOString(),
    };
    await log.put([updated]);
    const nowVisible = isVisible(stream, updated);
    const type = stream.draftAndPublish && wasVisible !== nowVisible ? (nowVisible ? 'published' : 'unpublished') : 'updated';
    notify(stream, type, updated, { wasVisible });
    send(res, 200, updated);
  }

  async function setPublished(req, res, stream, id, publish) {
    authorize(req);
    if (!stream.draftAndPublish) fail(400, 'Draft & publish is not enabled for this stream');
    const log = logs.get(stream.id);
    const existing = log.get(id);
    if (!existing) fail(404, 'Item not found');
    const wasVisible = existing.publishedAt != null;
    if (wasVisible === publish) return send(res, 200, existing); // already in that state

    if (publish) {
      const check = validateData(stream.fields, currentKeys(stream, existing.data), { mediaExists, enforceRequired: true });
      if (check.errors) fail(400, 'Cannot publish: validation failed', check.errors);
    }
    const now = new Date().toISOString();
    const updated = { ...existing, publishedAt: publish ? now : null, updatedAt: now };
    await log.put([updated]);
    notify(stream, publish ? 'published' : 'unpublished', updated, { wasVisible });
    send(res, 200, updated);
  }

  async function deleteItem(req, res, stream, id) {
    authorize(req);
    const log = logs.get(stream.id);
    const existing = log.get(id);
    if (!existing) fail(404, 'Item not found');
    await log.remove([id]);
    notify(stream, 'deleted', existing, { wasVisible: isVisible(stream, existing) });
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
      if (m === 'GET') return finish(send(res, 200, summary(stream, isAuthorized(req))));
      if (m === 'POST') return finish(createItems(req, res, stream)); // shortcut: POST /api/streams/:slug
      if (m === 'PUT' || m === 'PATCH') return finish(updateStream(req, res, stream));
      if (m === 'DELETE') return finish(deleteStream(req, res, stream));
      fail(405, 'Method not allowed');
    }

    if (parts.length === 2 && parts[1] === 'schema' && m === 'GET') return finish(send(res, 200, jsonSchema(stream)));
    if (parts.length === 2 && parts[1] === 'subscribe' && m === 'GET') return finish(subscribe(req, res, stream, url));
    if (parts.length === 4 && parts[1] === 'webhooks' && parts[3] === 'test' && m === 'POST') {
      return finish(testWebhook(req, res, stream, parts[2]));
    }

    if (parts[1] === 'items' || parts[1] === 'events') {
      if (parts.length === 2) {
        if (m === 'GET') return finish(listItems(req, res, stream, url));
        if (m === 'POST') return finish(createItems(req, res, stream));
        fail(405, 'Method not allowed');
      }
      const id = parts[2];
      if (parts.length === 3) {
        if (m === 'GET') return finish(send(res, 200, getItemOr404(stream, id, req)));
        if (m === 'PUT') return finish(updateItem(req, res, stream, id, false));
        if (m === 'PATCH') return finish(updateItem(req, res, stream, id, true));
        if (m === 'DELETE') return finish(deleteItem(req, res, stream, id));
        fail(405, 'Method not allowed');
      }
      if (parts.length === 4 && (parts[3] === 'publish' || parts[3] === 'unpublish')) {
        if (m !== 'POST') fail(405, 'Method not allowed');
        return finish(setPublished(req, res, stream, id, parts[3] === 'publish'));
      }
    }
    return false;
  }

  function close() {
    clearInterval(heartbeat);
    clearInterval(sweeper);
    heartbeat = null;
    webhooks.close();
    for (const subs of subscribers.values()) for (const s of subs) s.res.end();
    subscribers.clear();
  }

  return { route, close };
}
