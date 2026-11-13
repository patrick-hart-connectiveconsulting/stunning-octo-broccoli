// Streams API: user-defined data streams (events, posts, products…). Each stream
// has a dataset (fields) and an ordered log of items.
//
//   /api/streams                              list / create streams
//   /api/streams/:slug                        get / update / delete a stream; POST = new item
//   /api/streams/:slug/schema                 JSON Schema for the stream's item data
//   /api/streams/:slug/items                  list (filter, sort, populate, paginate) / create items
//   /api/streams/:slug/items/:id              get / update / delete one item
//   /api/streams/:slug/items/:id/publish      publish (draft & publish streams)
//   /api/streams/:slug/items/:id/unpublish    back to draft
//   /api/streams/:slug/subscribe              live Server-Sent Events feed
//   /api/streams/:slug/webhooks/:id/test      send a test delivery
//   /api/streams/:slug/keys[/:id]             per-stream API keys
//
// `/events` is accepted everywhere `/items` is (the original name).

import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID, randomBytes, createHash } from 'node:crypto';

import { HttpError, send, readJson, readJsonObject, paginate } from './http.js';
import { EventLog } from './event-log.js';
import { normalizeFields, validateData, parseFilterValue, fieldJsonSchema, isEmptyValue } from './schema.js';
import { getTemplate } from './templates.js';
import { normalizeWebhooks, WebhookDispatcher } from './webhooks.js';
import { toICS, toRSS, toJSONFeed, toGeoJSON, toCSV } from './formats.js';

const SLUG = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/;
const MAX_BATCH = 1000;
const FILTER_KEY = /^filter\[([A-Za-z_][A-Za-z0-9_]*)\](?:\[(eq|ne|gt|gte|lt|lte|contains|in|within|near)\])?$/;
const SCHEMA_TYPE = /^[A-Z][A-Za-z]{1,59}$/;
const EARTH_KM = 6371;
const DAY = 86400000;
const KEY_PREFIX = 'mmk_';
export const KEY_SCOPES = ['read', 'create', 'update', 'delete'];
const MAX_KEYS = 50;
const MAX_IN_VALUES = 500; // values in one filter[…][in] list
const MAX_SSE_BUFFER = 1024 * 1024; // bytes queued for one slow live-feed client before it is dropped
const HOST_HEADER = /^(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)*|\[[0-9A-Fa-f:.]+\])(?::\d{1,5})?$/;

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
const nowIso = () => new Date().toISOString();
const hashKey = (key) => createHash('sha256').update(key).digest('hex');

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

function normalizeSchemaType(input) {
  if (input === undefined || input === null || input === '') return { schemaType: null };
  if (typeof input !== 'string' || !SCHEMA_TYPE.test(input)) {
    return { errors: [{ path: 'schemaType', message: 'must be a schema.org type name such as Event or BlogPosting, or null' }] };
  }
  return { schemaType: input };
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
  stream.apiKeys ??= [];
  stream.schemaType ??= null;
  return stream;
}

export async function createStreamsApi({ store, dataDir, isMaster, bearer, webhookOptions = {}, schedulerIntervalMs = 15000, publicUrl = null, maxSubscribers = 1000, maxReplay = 1000 }) {
  const eventDir = join(dataDir, 'events');
  await mkdir(eventDir, { recursive: true });

  const logs = new Map(); // stream id -> EventLog
  const scheduled = new Map(); // "streamId:itemId" -> { streamId, id }, items with publishAt/unpublishAt
  for (const stream of store.data.streams) {
    upgradeStream(stream);
    const log = await new EventLog(join(eventDir, `${stream.id}.jsonl`)).load();
    logs.set(stream.id, log);
    for (const item of log.events.values()) track(stream, item);
  }

  const subscribers = new Map(); // stream id -> Set<{ res, authed(): boolean }>
  let subscriberCount = 0;

  /** Writes a frame; drops a client whose unread data passes MAX_SSE_BUFFER (it reconnects and resumes). */
  function sendFrame(streamId, sub, frame) {
    if (sub.res.writableLength > MAX_SSE_BUFFER) {
      sub.res.destroy();
      dropSubscriber(streamId, sub);
      return;
    }
    sub.res.write(frame);
  }
  function dropSubscriber(streamId, sub) {
    if (subscribers.get(streamId)?.delete(sub)) subscriberCount--;
  }
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

  // ---- auth: main token or per-stream API keys -----------------------------

  let keyIndex = new Map(); // sha256(key) -> { streamId, keyId }
  const rebuildKeyIndex = () => {
    keyIndex = new Map();
    for (const s of store.data.streams) for (const k of s.apiKeys) keyIndex.set(k.hash, { streamId: s.id, keyId: k.id });
  };
  rebuildKeyIndex();

  // lastUsedAt is updated in memory and flushed at most every 30 s.
  let touchTimer = null;
  const touchKey = (key) => {
    key.lastUsedAt = nowIso();
    if (touchTimer) return;
    touchTimer = setTimeout(() => {
      touchTimer = null;
      store.flush().catch(() => {});
    }, 30000);
    touchTimer.unref();
  };

  /** The API key presented with this request, if it is valid for `stream`. */
  function keyFor(req, url, stream) {
    const token = bearer(req) || url?.searchParams.get('access_token') || '';
    if (!token.startsWith(KEY_PREFIX)) return null;
    const hit = keyIndex.get(hashKey(token));
    if (!hit || hit.streamId !== stream.id) return null;
    const key = stream.apiKeys.find((k) => k.id === hit.keyId);
    if (!key || (key.expiresAt && key.expiresAt <= nowIso())) return null;
    touchKey(key);
    return key;
  }

  /** True if the request holds the main token, or a key for this stream with `scope`. */
  const can = (req, stream, scope, url) => isMaster(req, url) || Boolean(keyFor(req, url, stream)?.scopes.includes(scope));

  function requireScope(req, stream, scope) {
    if (isMaster(req)) return;
    const key = keyFor(req, null, stream);
    if (!key) fail(401, 'Missing or invalid API token or key');
    if (!key.scopes.includes(scope)) fail(403, `This API key does not have the "${scope}" scope`);
  }

  function requireMaster(req) {
    if (!isMaster(req)) fail(401, 'This action needs the main API token (MEDIA_API_TOKEN), not a stream key');
  }

  const publicKey = ({ hash, ...key }) => key;

  // ---- helpers -------------------------------------------------------------

  const getStreamOr404 = (slug) => {
    const stream = store.data.streams.find((s) => s.slug === slug);
    if (!stream) fail(404, `Stream "${slug}" not found`);
    return stream;
  };

  const isVisible = (stream, item) => !stream.draftAndPublish || item.publishedAt != null;

  /** The public view of an item: scheduling details (e.g. when it will be taken down) are for editors only. */
  const publicItem = (item) => {
    if (!('publishAt' in item) && !('unpublishAt' in item) && !('scheduleError' in item)) return item;
    const { publishAt, unpublishAt, scheduleError, ...rest } = item;
    return rest;
  };

  const summary = (stream, { master = false, read = master } = {}) => {
    const log = logs.get(stream.id);
    let itemCount = 0;
    let draftCount = 0;
    let scheduledCount = 0;
    let lastItemAt = null;
    for (const item of log.events.values()) {
      const visible = isVisible(stream, item);
      if (!visible) draftCount++;
      if (!visible && item.publishAt) scheduledCount++;
      if (!visible && !read) continue;
      itemCount++;
      if (!lastItemAt || item.timestamp > lastItemAt) lastItemAt = item.timestamp;
    }
    const { webhooks: hooks, apiKeys, ...rest } = stream;
    return {
      ...rest,
      itemCount,
      ...(stream.draftAndPublish && read ? { draftCount, scheduledCount } : {}),
      lastItemAt,
      ...(master ? { webhooks: hooks, apiKeys: apiKeys.map(publicKey) } : {}),
    };
  };
  const summaryFor = (req, stream) => summary(stream, { master: isMaster(req), read: can(req, stream, 'read') });

  const optionalText = (value, path, max) => {
    if (value === undefined) return undefined;
    if (value === null || value === '') return null;
    if (typeof value !== 'string') fail(400, `${path} must be a string`);
    if (value.length > max) fail(400, `${path} is too long (max ${max})`);
    return value.trim();
  };

  const parseDate = (value, path, { nullable = false } = {}) => {
    if (value === null && nullable) return null;
    const d = typeof value === 'string' || typeof value === 'number' ? new Date(value) : null;
    if (!d || Number.isNaN(d.getTime())) fail(400, 'Validation failed', [{ path, message: `must be an ISO 8601 date-time${nullable ? ' or null' : ''}` }]);
    return d.toISOString();
  };
  const parseTimestamp = (value, path) => (value === undefined || value === null ? nowIso() : parseDate(value, path));

  const mediaExists = (id) => Boolean(store.getFile(id));
  const relationExists = (field, id) => {
    const target = store.data.streams.find((s) => s.slug === field.target);
    return Boolean(target && logs.get(target.id)?.get(id));
  };

  /** Relation targets must be existing streams (or the stream itself). */
  function checkRelationTargets(fields, selfSlug) {
    const errors = [];
    fields.forEach((f, i) => {
      if (f.type !== 'relation') return;
      if (f.target !== selfSlug && !store.data.streams.some((s) => s.slug === f.target)) {
        errors.push({ path: `fields[${i}].target`, message: `stream "${f.target}" does not exist` });
      }
    });
    return errors.length ? { errors } : {};
  }

  /** Streams (other than itself) with a relation field pointing at `stream`. */
  const referencingStreams = (stream) =>
    store.data.streams.filter((s) => s.id !== stream.id && s.fields.some((f) => f.type === 'relation' && f.target === stream.slug));

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
   * checks types/required/relations, then enforces uniqueness (bumping
   * generated uids with -2, -3… instead of failing). Reserves values in `index`.
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

    const result = validateData(stream.fields, data, { mediaExists, relationExists, enforceRequired });
    if (result.errors) fail(400, 'Validation failed', result.errors.map((e) => ({ ...e, path: prefix + e.path })));
    const out = result.data;

    const errors = [];
    for (const [name, taken] of index) {
      const v = out[name];
      if (v == null) continue;
      const clash = (candidate) => taken.has(candidate) && taken.get(candidate) !== id;
      if (generated.has(name)) {
        const max = stream.fields.find((f) => f.name === name)?.maxLength ?? 255;
        let candidate = v;
        for (let n = 2; clash(candidate); n++) {
          const suffix = `-${n}`;
          candidate = `${v.slice(0, max - suffix.length).replace(/-+$/, '')}${suffix}`; // stays within maxLength
        }
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

  // ---- writing items -------------------------------------------------------

  function track(stream, item) {
    const key = `${stream.id}:${item.id}`;
    if (item.publishAt || item.unpublishAt) scheduled.set(key, { streamId: stream.id, id: item.id });
    else scheduled.delete(key);
  }

  async function putItems(stream, items) {
    await logs.get(stream.id).put(items);
    for (const item of items) track(stream, item);
  }

  /** Deletes items, notifies, and clears references to them from other items. */
  async function removeItems(stream, items, { webhook = true } = {}) {
    if (!items.length) return;
    await logs.get(stream.id).remove(items.map((i) => i.id));
    for (const item of items) {
      scheduled.delete(`${stream.id}:${item.id}`);
      notify(stream, 'deleted', item, { wasVisible: isVisible(stream, item), webhook });
    }
    await cleanupReferences(stream, items.map((i) => i.id), { webhook });
  }

  /** Removes deleted ids from relation fields that point at `target` (single → null, multiple → filtered). */
  async function cleanupReferences(target, ids, { webhook }) {
    const gone = new Set(ids);
    for (const s of store.data.streams) {
      const rel = s.fields.filter((f) => f.type === 'relation' && f.target === target.slug);
      if (!rel.length) continue;
      const changed = [];
      for (const item of logs.get(s.id).events.values()) {
        if (s.id === target.id && gone.has(item.id)) continue;
        let data = null;
        for (const f of rel) {
          const v = item.data?.[f.name];
          if (f.multiple && Array.isArray(v) && v.some((id) => gone.has(id))) {
            data ??= { ...item.data };
            data[f.name] = v.filter((id) => !gone.has(id));
          } else if (!f.multiple && typeof v === 'string' && gone.has(v)) {
            data ??= { ...item.data };
            data[f.name] = null;
          }
        }
        if (data) changed.push({ ...item, data, updatedAt: nowIso() });
      }
      if (!changed.length) continue;
      await putItems(s, changed);
      for (const c of changed) notify(s, 'updated', c, { wasVisible: isVisible(s, c), webhook });
    }
  }

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
    const pub = publicItem(item);
    if (type === 'created' && nowVisible) publicFrame = frame('created', pub, item.seq);
    else if (type === 'updated' && nowVisible) publicFrame = frame('updated', pub);
    else if (type === 'published' && !wasVisible) publicFrame = frame('created', pub);
    else if ((type === 'unpublished' || type === 'deleted') && wasVisible) publicFrame = frame('deleted', ref);

    for (const sub of [...subs]) {
      // Access is re-checked on every change, so a revoked or expired key stops seeing drafts at once.
      if (sub.authed()) sendFrame(stream.id, sub, authedFrame);
      else if (publicFrame) sendFrame(stream.id, sub, publicFrame);
    }
  }

  function notifyStream(stream, type, payload) {
    for (const sub of [...(subscribers.get(stream.id) || [])]) {
      const body = type === 'stream-updated' ? summary(stream, { read: sub.authed() }) : payload;
      sendFrame(stream.id, sub, `event: ${type}\ndata: ${JSON.stringify(body)}\n\n`);
    }
  }

  function subscribe(req, res, stream, url) {
    if (subscriberCount >= maxSubscribers) {
      res.writeHead(503, { 'Retry-After': '30', 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ error: { status: 503, message: 'Too many live connections. Try again later.' } }));
      return;
    }
    // The main token stays valid for the life of the server; a key is looked up again on every write.
    const master = isMaster(req, url);
    const key = master ? null : keyFor(req, url, stream);
    const keyId = key?.scopes.includes('read') ? key.id : null;
    const authed = () => {
      if (master) return true;
      if (!keyId) return false;
      const k = stream.apiKeys.find((x) => x.id === keyId);
      return Boolean(k && k.scopes.includes('read') && !(k.expiresAt && k.expiresAt <= nowIso()));
    };
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
        .filter((e) => e.seq > after && (authed() || isVisible(stream, e)))
        .sort((a, b) => a.seq - b.seq);
      if (missed.length > maxReplay) {
        // Too much to replay over a live connection: tell the client to reload the list instead.
        res.write(`event: reset\ndata: ${JSON.stringify({ reason: 'too many missed items', missed: missed.length, list: `/api/streams/${stream.slug}/items?after=${after}` })}\n\n`);
      } else {
        for (const e of missed) res.write(`id: ${e.seq}\nevent: created\ndata: ${JSON.stringify(authed() ? e : publicItem(e))}\n\n`);
      }
    }

    if (!subscribers.has(stream.id)) subscribers.set(stream.id, new Set());
    const sub = { res, authed };
    subscribers.get(stream.id).add(sub);
    subscriberCount++;
    if (!heartbeat) {
      heartbeat = setInterval(() => {
        for (const [streamId, subs] of subscribers) for (const s of [...subs]) sendFrame(streamId, s, ': ping\n\n');
      }, 25000);
      heartbeat.unref();
    }
    req.on('close', () => dropSubscriber(stream.id, sub));
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
    await removeItems(stream, victims, { webhook: false });
    return victims.length;
  }

  // ---- scheduled publishing ------------------------------------------------

  /**
   * Applies publishAt / unpublishAt from a request body to an item's status
   * fields. Times in the past take effect immediately.
   */
  function applySchedule(stream, body, status, prefix = '') {
    const out = { ...status };
    const has = (k) => body[k] !== undefined;
    if (!has('publishAt') && !has('unpublishAt')) return out;
    if (!stream.draftAndPublish) fail(400, 'Scheduling needs draft & publish to be enabled for this stream');
    const now = nowIso();
    const bad = (path, message) => fail(400, 'Validation failed', [{ path: prefix + path, message }]);

    if (has('publishAt')) {
      const at = parseDate(body.publishAt, `${prefix}publishAt`, { nullable: true });
      if (at && body.publish === true) bad('publishAt', 'use either publish or publishAt, not both');
      if (at && out.publishedAt) bad('publishAt', 'the item is already published — unpublish it first, or set unpublishAt');
      if (at && at <= now) {
        out.publishedAt = now;
        out.publishAt = null;
      } else {
        out.publishAt = at;
      }
      if (at) out.scheduleError = null;
    }
    if (has('unpublishAt')) {
      const at = parseDate(body.unpublishAt, `${prefix}unpublishAt`, { nullable: true });
      if (at) {
        if (!out.publishedAt && !out.publishAt) bad('unpublishAt', 'needs an item that is published or scheduled to publish');
        if (out.publishAt && at <= out.publishAt) bad('unpublishAt', 'must be after publishAt');
        if (at <= now) {
          out.publishedAt = null;
          out.unpublishAt = null;
        } else {
          out.unpublishAt = at;
        }
      } else {
        out.unpublishAt = null;
      }
    }
    return out;
  }

  let schedulerBusy = false;
  async function runScheduler() {
    if (schedulerBusy) return;
    schedulerBusy = true;
    try {
      const now = nowIso();
      for (const [key, ref] of [...scheduled]) {
        const stream = store.getStream(ref.streamId);
        let item = stream && logs.get(stream.id)?.get(ref.id);
        if (!item) {
          scheduled.delete(key);
          continue;
        }
        if (!stream.draftAndPublish) continue;

        if (item.publishAt && item.publishAt <= now) {
          const wasVisible = isVisible(stream, item);
          const check = validateData(stream.fields, currentKeys(stream, item.data), { mediaExists, relationExists, enforceRequired: true });
          if (check.errors) {
            item = {
              ...item,
              publishAt: null,
              scheduleError: `Scheduled publish failed: ${check.errors.map((e) => `${e.path} ${e.message}`).join('; ')}`,
              updatedAt: now,
            };
            await putItems(stream, [item]);
            notify(stream, 'updated', item, { wasVisible });
            continue;
          }
          item = { ...item, publishedAt: now, publishAt: null, scheduleError: null, updatedAt: now };
          await putItems(stream, [item]);
          notify(stream, 'published', item, { wasVisible });
          // A request may have changed or deleted the item while that write was saved.
          item = logs.get(stream.id)?.get(ref.id);
          if (!item) continue;
        }
        if (item.unpublishAt && item.unpublishAt <= now) {
          const wasVisible = isVisible(stream, item);
          item = { ...item, publishedAt: null, unpublishAt: null, updatedAt: now };
          await putItems(stream, [item]);
          notify(stream, wasVisible ? 'unpublished' : 'updated', item, { wasVisible });
        }
      }
    } finally {
      schedulerBusy = false;
    }
  }
  const scheduler = setInterval(() => runScheduler().catch((err) => console.error('scheduler', err)), schedulerIntervalMs);
  scheduler.unref();
  runScheduler().catch(() => {}); // catch up on anything that fell due while the server was down

  // ---- streams -------------------------------------------------------------

  async function listStreams(req, res, url) {
    const q = (url.searchParams.get('q') || '').toLowerCase();
    let items = store.data.streams;
    if (q) items = items.filter((s) => s.name.toLowerCase().includes(q) || s.slug.includes(q));
    items = [...items].sort((a, b) => a.name.localeCompare(b.name)).map((s) => summaryFor(req, s));
    send(res, 200, paginate(items, url, { defaultSize: 100, maxSize: 500 }));
  }

  function collect(results) {
    const errors = results.flatMap((r) => r.errors || []);
    if (errors.length) fail(400, 'Validation failed', errors);
  }

  async function createStream(req, res) {
    requireMaster(req);
    const body = await readJsonObject(req);
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
    const t = normalizeSchemaType(body.schemaType !== undefined ? body.schemaType : template.schemaType);
    collect([f, l, r, w, t]);
    collect([checkRelationTargets(f.fields, slug)]);
    if (body.draftAndPublish !== undefined && typeof body.draftAndPublish !== 'boolean') fail(400, 'draftAndPublish must be a boolean');

    const stream = await store.addStream({
      slug,
      name,
      description: optionalText(body.description, 'description', 1000) ?? null,
      template: templateId,
      schemaType: t.schemaType,
      labels: l.labels,
      draftAndPublish: body.draftAndPublish ?? template.draftAndPublish,
      retention: r.retention,
      fields: f.fields,
      webhooks: w.webhooks,
      apiKeys: [],
    });
    logs.set(stream.id, await new EventLog(join(eventDir, `${stream.id}.jsonl`)).load());
    send(res, 201, summary(stream, { master: true }));
  }

  async function updateStream(req, res, stream) {
    requireMaster(req);
    const body = await readJsonObject(req);
    if (!store.data.streams.includes(stream)) fail(404, `Stream "${stream.slug}" not found`); // deleted while the body arrived
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
    if (body.schemaType !== undefined) results.push(normalizeSchemaType(body.schemaType));
    collect(results);
    for (const r of results) Object.assign(patch, r);
    if (patch.fields) collect([checkRelationTargets(patch.fields, stream.slug)]);
    if (body.draftAndPublish !== undefined) {
      if (typeof body.draftAndPublish !== 'boolean') fail(400, 'draftAndPublish must be a boolean');
      patch.draftAndPublish = body.draftAndPublish;
    }

    // Turning draft & publish on: items written before it existed count as published.
    if (patch.draftAndPublish && !stream.draftAndPublish) {
      const legacy = logs.get(stream.id).all().filter((i) => i.publishedAt === undefined);
      if (legacy.length) await putItems(stream, legacy.map((i) => ({ ...i, publishedAt: i.createdAt })));
    }

    const updated = await store.updateStream(stream.id, patch);
    if (patch.retention) await enforceRetention(updated);
    notifyStream(updated, 'stream-updated');
    send(res, 200, summary(updated, { master: true }));
  }

  async function deleteStream(req, res, stream) {
    requireMaster(req);
    const refs = referencingStreams(stream);
    if (refs.length) {
      const where = refs.map((s) => `"${s.slug}" (${s.fields.filter((f) => f.type === 'relation' && f.target === stream.slug).map((f) => f.name).join(', ')})`).join('; ');
      fail(409, `Other streams have relation fields pointing at this stream: ${where}. Remove those fields first.`);
    }
    const result = summary(stream, { master: true });
    await store.removeStream(stream.id);
    await logs.get(stream.id).destroy();
    logs.delete(stream.id);
    for (const key of [...scheduled.keys()]) if (key.startsWith(`${stream.id}:`)) scheduled.delete(key);
    rebuildKeyIndex();
    notifyStream(stream, 'stream-deleted', { id: stream.id, slug: stream.slug });
    for (const sub of [...(subscribers.get(stream.id) || [])]) {
      sub.res.end();
      dropSubscriber(stream.id, sub);
    }
    subscribers.delete(stream.id);
    send(res, 200, result);
  }

  function jsonSchema(stream) {
    const properties = {};
    for (const f of stream.fields) {
      const schema = fieldJsonSchema(f);
      const listLike = f.type === 'tags' || (f.type === 'relation' && f.multiple);
      properties[f.name] = f.required || listLike ? schema : { anyOf: [schema, { type: 'null' }] };
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
    requireMaster(req);
    const hook = stream.webhooks.find((w) => w.id === hookId);
    if (!hook) fail(404, 'Webhook not found');
    const result = await webhooks.test(stream, hook);
    hook.lastDelivery = result;
    await store.flush();
    send(res, 200, result);
  }

  // ---- API keys --------------------------------------------------------------

  function parseKeyInput(body, existing) {
    const out = {};
    const errors = [];
    if (body.name !== undefined || !existing) {
      const name = typeof body.name === 'string' ? body.name.trim() : '';
      if (!name || name.length > 100) errors.push({ path: 'name', message: 'must be 1–100 characters' });
      out.name = name;
    }
    if (body.scopes !== undefined || !existing) {
      const scopes = body.scopes;
      if (!Array.isArray(scopes) || !scopes.length || scopes.some((s) => !KEY_SCOPES.includes(s))) {
        errors.push({ path: 'scopes', message: `must be a non-empty list of: ${KEY_SCOPES.join(', ')}` });
      } else {
        out.scopes = KEY_SCOPES.filter((s) => scopes.includes(s));
      }
    }
    if (body.expiresAt !== undefined) {
      if (body.expiresAt === null) out.expiresAt = null;
      else {
        const d = new Date(body.expiresAt);
        if (Number.isNaN(d.getTime()) || d.toISOString() <= nowIso()) errors.push({ path: 'expiresAt', message: 'must be a future ISO 8601 date-time, or null' });
        else out.expiresAt = d.toISOString();
      }
    }
    if (errors.length) fail(400, 'Validation failed', errors);
    return out;
  }

  async function keysRoute(req, res, stream, parts, m) {
    requireMaster(req);
    if (parts.length === 2) {
      if (m === 'GET') return send(res, 200, { data: stream.apiKeys.map(publicKey) });
      if (m !== 'POST') fail(405, 'Method not allowed');
      if (stream.apiKeys.length >= MAX_KEYS) fail(400, `At most ${MAX_KEYS} API keys per stream`);
      const input = parseKeyInput(await readJsonObject(req));
      if (!store.data.streams.includes(stream)) fail(404, `Stream "${stream.slug}" not found`);
      const secret = KEY_PREFIX + randomBytes(24).toString('base64url');
      const key = {
        id: randomUUID(),
        name: input.name,
        prefix: secret.slice(0, 12),
        scopes: input.scopes,
        expiresAt: input.expiresAt ?? null,
        createdAt: nowIso(),
        lastUsedAt: null,
        hash: hashKey(secret),
      };
      stream.apiKeys.push(key);
      await store.flush();
      rebuildKeyIndex();
      // The full key is returned only once.
      return send(res, 201, { ...publicKey(key), key: secret });
    }
    const key = stream.apiKeys.find((k) => k.id === parts[2]);
    if (!key) fail(404, 'API key not found');
    if (m === 'GET') return send(res, 200, publicKey(key));
    if (m === 'PATCH' || m === 'PUT') {
      const input = parseKeyInput(await readJsonObject(req), key);
      if (!stream.apiKeys.includes(key)) fail(404, 'API key not found'); // revoked while the body arrived
      Object.assign(key, input);
      await store.flush();
      return send(res, 200, publicKey(key));
    }
    if (m === 'DELETE') {
      stream.apiKeys = stream.apiKeys.filter((k) => k.id !== key.id);
      await store.flush();
      rebuildKeyIndex();
      return send(res, 200, publicKey(key));
    }
    fail(405, 'Method not allowed');
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
      const geo = op === 'within' || op === 'near';
      if (geo && field?.type !== 'geopoint') fail(400, `filter[${name}][${op}] only works on map pin (geopoint) fields`);
      if (!geo && field?.type === 'geopoint') fail(400, `Map pin fields support filter[${name}][within]=minLng,minLat,maxLng,maxLat and filter[${name}][near]=lat,lng,km`);
      const parts = op === 'in' ? raw.split(',') : null;
      if (parts && parts.length > MAX_IN_VALUES) fail(400, `filter[${name}][in] takes at most ${MAX_IN_VALUES} values`);
      filters.push({ name, op, raw, parts, lower: raw.toLowerCase(), type: field?.type, geo: geo ? parseGeoFilter(op, raw, name) : null });
    }
    // Values are converted once per request when the field type is known. In
    // schema-less streams the type comes from each stored value, so per item.
    const typed = new Map();
    const valueOf = (raw, type, sample) => {
      if (!type) return parseFilterValue(type, raw, sample);
      const key = `${type}\u0000${raw}`;
      if (!typed.has(key)) typed.set(key, parseFilterValue(type, raw, sample));
      return typed.get(key);
    };
    const inSets = new Map(); // filter -> Map(type -> Set of converted values)
    const compare = (v, op, raw, type, f) => {
      if (op === 'contains') return v != null && String(typeof v === 'object' ? JSON.stringify(v) : v).toLowerCase().includes(f.lower);
      if (op === 'in') {
        if (!type) return f.parts.some((part) => parseFilterValue(type, part, v) === v);
        // One Set per filter and type ('string' is used for array elements).
        const byType = inSets.get(f) ?? inSets.set(f, new Map()).get(f);
        if (!byType.has(type)) byType.set(type, new Set(f.parts.map((p) => valueOf(p, type, v))));
        return byType.get(type).has(v);
      }
      const x = valueOf(raw, type, v);
      if (op === 'eq') return v === x;
      if (op === 'ne') return v !== x;
      if (v === null || v === undefined) return false;
      if (op === 'gt') return v > x;
      if (op === 'gte') return v >= x;
      if (op === 'lt') return v < x;
      return v <= x; // lte
    };
    return (item) =>
      filters.every((f) => {
        const { name, op, raw, type, geo } = f;
        const v = item.data?.[name];
        if (geo) return v != null && matchGeo(geo, v);
        // Arrays (tags, multiple relations): eq / in / contains match if any element matches; ne if none does.
        if (Array.isArray(v) && type !== 'json') {
          if (op === 'ne') return !v.some((el) => compare(el, 'eq', raw, 'string', f));
          return v.some((el) => compare(el, op, raw, 'string', f));
        }
        return compare(v, op, raw, type === 'relation' ? 'string' : type, f);
      });
  }

  function parseGeoFilter(op, raw, name) {
    const nums = raw.split(',').map((x) => Number(x.trim()));
    const bad = (msg) => fail(400, `filter[${name}][${op}] ${msg}`);
    if (nums.some((n) => !Number.isFinite(n))) bad('takes comma-separated numbers');
    if (op === 'within') {
      if (nums.length !== 4) bad('takes minLng,minLat,maxLng,maxLat');
      const [minLng, minLat, maxLng, maxLat] = nums;
      if (minLat > maxLat || Math.abs(minLat) > 90 || Math.abs(maxLat) > 90 || Math.abs(minLng) > 180 || Math.abs(maxLng) > 180) bad('has an invalid box');
      return { op, minLng, minLat, maxLng, maxLat };
    }
    if (nums.length !== 3) bad('takes lat,lng,km');
    const [lat, lng, km] = nums;
    if (Math.abs(lat) > 90 || Math.abs(lng) > 180 || !(km > 0)) bad('needs a valid lat, lng and a distance in km greater than 0');
    return { op, lat, lng, km };
  }

  function matchGeo(g, p) {
    if (g.op === 'within') {
      const inLng = g.minLng <= g.maxLng ? p.lng >= g.minLng && p.lng <= g.maxLng : p.lng >= g.minLng || p.lng <= g.maxLng; // box may cross the antimeridian
      return inLng && p.lat >= g.minLat && p.lat <= g.maxLat;
    }
    const rad = Math.PI / 180;
    const dLat = (p.lat - g.lat) * rad;
    const dLng = (p.lng - g.lng) * rad;
    const a = Math.sin(dLat / 2) ** 2 + Math.cos(g.lat * rad) * Math.cos(p.lat * rad) * Math.sin(dLng / 2) ** 2;
    return 2 * EARTH_KM * Math.asin(Math.min(1, Math.sqrt(a))) <= g.km;
  }

  const fileSummary = (file) => (file ? {
    id: file.id,
    name: file.name,
    url: file.url,
    mime: file.mime,
    size: file.size,
    width: file.width,
    height: file.height,
    alternativeText: file.alternativeText,
    caption: file.caption,
  } : null);

  /** Replaces relation and media ids with the related items / file details for `?populate=*` or `?populate=a,b`. */
  function populate(req, stream, items, url) {
    const param = url.searchParams.get('populate');
    if (!param) return items;
    const relations = stream.fields.filter((f) => f.type === 'relation' || f.type === 'media');
    const names = param === '*' ? relations.map((f) => f.name) : param.split(',').map((s) => s.trim()).filter(Boolean);
    for (const n of names) if (!relations.some((f) => f.name === n)) fail(400, `Cannot populate "${n}": not a relation or media field`);

    const resolvers = relations.filter((f) => names.includes(f.name)).map((f) => {
      if (f.type === 'media') return [f, (id) => fileSummary(store.getFile(id))];
      const target = store.data.streams.find((s) => s.slug === f.target);
      const log = target && logs.get(target.id);
      const seeDrafts = target && can(req, target, 'read');
      const resolve = (id) => {
        const it = log?.get(id);
        if (!it || (!seeDrafts && !isVisible(target, it))) return null;
        return seeDrafts ? it : publicItem(it);
      };
      return [f, resolve];
    });
    return items.map((item) => {
      const data = { ...item.data };
      for (const [f, resolve] of resolvers) {
        const v = data[f.name];
        data[f.name] = f.multiple ? (Array.isArray(v) ? v.map(resolve).filter(Boolean) : []) : v ? resolve(v) : null;
      }
      return { ...item, data };
    });
  }

  /** Items matching the request's status, time, sequence and field filters, sorted. */
  function queryItems(req, stream, url, { publishedOnly = false } = {}) {
    let items = logs.get(stream.id).all();

    if (stream.draftAndPublish) {
      const status = publishedOnly ? 'published' : url.searchParams.get('status') || 'published';
      if (!['published', 'draft', 'scheduled', 'all'].includes(status)) fail(400, 'status must be published, draft, scheduled or all');
      if (status !== 'published' && !can(req, stream, 'read')) fail(401, 'Reading drafts needs the API token or a key with the "read" scope');
      if (status === 'published') items = items.filter((i) => i.publishedAt != null);
      if (status === 'draft') items = items.filter((i) => i.publishedAt == null);
      if (status === 'scheduled') items = items.filter((i) => i.publishedAt == null && i.publishAt);
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
    if (['timestamp', 'createdAt', 'updatedAt', 'publishedAt', 'publishAt', 'seq'].includes(key)) get = (e) => e[key];
    else if (key.startsWith('data.')) {
      const name = key.slice(5);
      if (stream.fields.length && !stream.fields.some((f) => f.name === name)) fail(400, `Cannot sort by unknown field "${name}"`);
      get = (e) => e.data?.[name];
    } else fail(400, 'sort must be timestamp, createdAt, updatedAt, publishedAt, publishAt, seq or data.<field>, optionally with :asc or :desc');

    items.sort((a, b) => {
      const av = get(a);
      const bv = get(b);
      if (av == null && bv == null) return a.seq - b.seq;
      if (av == null) return 1; // nulls last regardless of direction
      if (bv == null) return -1;
      const cmp = typeof av === 'number' && typeof bv === 'number' ? av - bv : String(av).localeCompare(String(bv));
      return cmp * sign || (a.seq - b.seq) * sign;
    });
    return items;
  }

  function listItems(req, res, stream, url) {
    const page = paginate(queryItems(req, stream, url), url, { defaultSize: 25, maxSize: 500 });
    const editor = can(req, stream, 'read');
    send(res, 200, { ...page, data: populate(req, stream, editor ? page.data : page.data.map(publicItem), url) });
  }

  // ---- standard formats ------------------------------------------------------

  const FORMATS = {
    'feed.ics': { type: 'text/calendar; charset=utf-8', limit: 10000, render: toICS },
    'feed.rss': { type: 'application/rss+xml; charset=utf-8', limit: 50, render: toRSS },
    'feed.json': { type: 'application/feed+json; charset=utf-8', limit: 50, render: (s, i, c) => JSON.stringify(toJSONFeed(s, i, c), null, 2) },
    'feed.geojson': { type: 'application/geo+json; charset=utf-8', limit: 10000, render: (s, i, c) => JSON.stringify(toGeoJSON(s, i, c)) },
    'items.csv': { type: 'text/csv; charset=utf-8', limit: 100000, render: toCSV, download: 'csv' },
  };

  /**
   * Base URL for absolute links. Without MEDIA_PUBLIC_URL it comes from the
   * request, so the Host header is validated and the protocol can only be
   * http or https (no javascript:// or other schemes from a spoofed header).
   */
  function originOf(req) {
    if (publicUrl) return publicUrl.replace(/\/+$/, '');
    const forwarded = String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim().toLowerCase();
    const proto = forwarded === 'https' ? 'https' : 'http';
    const host = req.headers.host || 'localhost';
    if (!HOST_HEADER.test(host)) fail(400, 'Invalid Host header');
    return `${proto}://${host}`;
  }

  /** Published items in a standard format. Filters, since/until and sort work as on /items. */
  function sendFormat(req, res, stream, name, url) {
    const format = FORMATS[name];
    const limit = Math.min(format.limit, Math.max(1, parseInt(url.searchParams.get('limit'), 10) || format.limit));
    const items = queryItems(req, stream, url, { publishedOnly: true }).slice(0, limit);
    const origin = originOf(req);
    const streamUrl = `${origin}/api/streams/${stream.slug}`;
    const overrides = {};
    for (const role of ['title', 'description', 'start', 'end', 'allDay', 'venue', 'url', 'location', 'image']) {
      const v = url.searchParams.get(role);
      if (v) {
        if (!stream.fields.some((f) => f.name === v)) fail(400, `${role}=${v}: not a field of this stream`);
        overrides[role] = v;
      }
    }
    const tz = url.searchParams.get('tz');
    if (tz) {
      try {
        new Intl.DateTimeFormat('en', { timeZone: tz });
      } catch {
        fail(400, `tz=${tz} is not a known IANA time zone (e.g. Europe/London)`);
      }
    }
    const link = url.searchParams.get('link');
    const site = url.searchParams.get('site');
    for (const [k, v] of [['link', link], ['site', site]]) {
      // Control characters would let the value start a new line (iCalendar property injection).
      if (v && (!/^https?:\/\//.test(v) || /[\u0000-\u0020\u007f]/.test(v))) {
        fail(400, `${k} must be an http(s) URL without spaces or control characters`);
      }
    }
    const body = format.render(stream, items, {
      overrides,
      timeZone: tz || process.env.MEDIA_TIMEZONE || 'UTC',
      linkPattern: link,
      siteUrl: site,
      streamUrl,
      itemsUrl: `${streamUrl}/items`,
      feedUrl: `${origin}${url.pathname}`,
      host: new URL(origin).host,
      absolute: (path) => new URL(path, `${origin}/`).href,
      getFile: (id) => store.getFile(id),
    });
    const headers = { 'Content-Type': format.type, 'Cache-Control': 'public, max-age=60' };
    // Links depend on these request headers unless MEDIA_PUBLIC_URL is set: caches must key on them.
    if (!publicUrl) headers.Vary = 'Host, X-Forwarded-Proto';
    if (format.download) headers['Content-Disposition'] = `attachment; filename="${stream.slug}.${format.download}"`;
    res.writeHead(200, headers);
    res.end(body);
  }

  function getItem(req, res, stream, id, url) {
    const item = logs.get(stream.id).get(id);
    const editor = can(req, stream, 'read');
    if (!item || (!isVisible(stream, item) && !editor)) fail(404, 'Item not found');
    send(res, 200, populate(req, stream, [editor ? item : publicItem(item)], url)[0]);
  }

  async function createItems(req, res, stream) {
    requireScope(req, stream, 'create');
    const body = await readJson(req, 10 * 1024 * 1024);
    if (!logs.has(stream.id)) fail(404, `Stream "${stream.slug}" not found`); // deleted while the body arrived
    const batch = Array.isArray(body);
    const inputs = batch ? body : [body];
    if (!inputs.length) fail(400, 'No items provided');
    if (inputs.length > MAX_BATCH) fail(400, `At most ${MAX_BATCH} items per request`);

    // Validate everything first so a batch is all-or-nothing.
    const index = uniqueIndex(stream);
    const now = nowIso();
    const dp = stream.draftAndPublish;
    const prepared = inputs.map((input, i) => {
      const prefix = batch ? `[${i}].` : '';
      if (!input || typeof input !== 'object' || Array.isArray(input)) {
        fail(400, 'Validation failed', [{ path: batch ? `[${i}]` : 'body', message: 'must be an object like { "data": { … } }' }]);
      }
      if (!('data' in input)) fail(400, 'Validation failed', [{ path: `${prefix}data`, message: 'is required — wrap the item fields in { "data": { … } }' }]);
      if (input.publish !== undefined && typeof input.publish !== 'boolean') {
        fail(400, 'Validation failed', [{ path: `${prefix}publish`, message: 'must be true or false' }]);
      }
      const status = applySchedule(stream, input, {
        publishedAt: !dp || input.publish === true ? now : null,
        publishAt: null,
        unpublishAt: null,
      }, prefix);
      const id = randomUUID();
      return {
        id,
        status,
        data: prepareData(stream, input.data, { id, index, enforceRequired: status.publishedAt != null || status.publishAt != null, prefix }),
        timestamp: parseTimestamp(input.timestamp, `${prefix}timestamp`),
      };
    });

    const log = logs.get(stream.id);
    const items = prepared.map(({ id, data, timestamp, status }) => ({
      id,
      seq: log.nextSeq(),
      stream: stream.slug,
      timestamp,
      data,
      publishedAt: status.publishedAt,
      ...(dp ? { publishAt: status.publishAt, unpublishAt: status.unpublishAt } : {}),
      createdAt: now,
      updatedAt: now,
    }));
    await putItems(stream, items);
    for (const item of items) notify(stream, 'created', item);
    await enforceRetention(stream);
    send(res, 201, batch ? items : items[0]);
  }

  async function updateItem(req, res, stream, id, merge) {
    requireScope(req, stream, 'update');
    if (!logs.get(stream.id).get(id)) fail(404, 'Item not found'); // fail fast, before reading the body
    const body = await readJson(req, 10 * 1024 * 1024);
    if (!body || typeof body !== 'object' || Array.isArray(body)) fail(400, 'Body must be an object like { "data": { … } }');
    // Read the item only now: it may have changed or been deleted while the body arrived.
    // Using the earlier copy would overwrite those changes or bring a deleted item back.
    const existing = logs.get(stream.id)?.get(id);
    if (!existing) fail(404, 'Item not found');
    if (!merge && !('data' in body)) fail(400, 'Validation failed', [{ path: 'data', message: 'is required for PUT (use PATCH for partial updates)' }]);
    if (body.publish !== undefined && typeof body.publish !== 'boolean') fail(400, 'Validation failed', [{ path: 'publish', message: 'must be true or false' }]);

    const wasVisible = isVisible(stream, existing);
    let status = {
      publishedAt: existing.publishedAt ?? existing.createdAt,
      publishAt: existing.publishAt ?? null,
      unpublishAt: existing.unpublishAt ?? null,
      scheduleError: existing.scheduleError ?? null,
    };
    if (stream.draftAndPublish) {
      status.publishedAt = existing.publishedAt ?? null;
      if (body.publish === true) {
        status.publishedAt ??= nowIso();
        status.publishAt = null;
        status.scheduleError = null;
      }
      if (body.publish === false) {
        status.publishedAt = null;
        status.unpublishAt = null;
      }
    }
    status = applySchedule(stream, body, status);

    let incoming;
    if ('data' in body) {
      if (merge && (!body.data || typeof body.data !== 'object' || Array.isArray(body.data))) {
        fail(400, 'Validation failed', [{ path: 'data', message: 'must be a JSON object' }]);
      }
      incoming = merge ? { ...currentKeys(stream, existing.data), ...body.data } : body.data;
    } else {
      incoming = currentKeys(stream, existing.data);
    }
    const enforceRequired = status.publishedAt != null || status.publishAt != null;
    const data = prepareData(stream, incoming, { id, index: uniqueIndex(stream), enforceRequired });

    const updated = {
      ...existing,
      data,
      ...status,
      timestamp: body.timestamp !== undefined ? parseTimestamp(body.timestamp, 'timestamp') : existing.timestamp,
      updatedAt: nowIso(),
    };
    if (!stream.draftAndPublish) {
      delete updated.publishAt;
      delete updated.unpublishAt;
      delete updated.scheduleError;
    } else if (!updated.scheduleError) delete updated.scheduleError;
    await putItems(stream, [updated]);
    const nowVisible = isVisible(stream, updated);
    const type = stream.draftAndPublish && wasVisible !== nowVisible ? (nowVisible ? 'published' : 'unpublished') : 'updated';
    notify(stream, type, updated, { wasVisible });
    send(res, 200, updated);
  }

  async function setPublished(req, res, stream, id, publish) {
    requireScope(req, stream, 'update');
    if (!stream.draftAndPublish) fail(400, 'Draft & publish is not enabled for this stream');
    const existing = logs.get(stream.id).get(id);
    if (!existing) fail(404, 'Item not found');
    const wasVisible = existing.publishedAt != null;
    if (wasVisible === publish) return send(res, 200, existing); // already in that state

    if (publish) {
      const check = validateData(stream.fields, currentKeys(stream, existing.data), { mediaExists, relationExists, enforceRequired: true });
      if (check.errors) fail(400, 'Cannot publish: validation failed', check.errors);
    }
    const now = nowIso();
    const { scheduleError, ...rest } = existing;
    const updated = publish
      ? { ...rest, publishedAt: now, publishAt: null, updatedAt: now }
      : { ...rest, publishedAt: null, unpublishAt: null, updatedAt: now };
    await putItems(stream, [updated]);
    notify(stream, publish ? 'published' : 'unpublished', updated, { wasVisible });
    send(res, 200, updated);
  }

  async function deleteItem(req, res, stream, id) {
    requireScope(req, stream, 'delete');
    const existing = logs.get(stream.id).get(id);
    if (!existing) fail(404, 'Item not found');
    await removeItems(stream, [existing]);
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
      if (m === 'GET') return finish(send(res, 200, summaryFor(req, stream)));
      if (m === 'POST') return finish(createItems(req, res, stream)); // shortcut: POST /api/streams/:slug
      if (m === 'PUT' || m === 'PATCH') return finish(updateStream(req, res, stream));
      if (m === 'DELETE') return finish(deleteStream(req, res, stream));
      fail(405, 'Method not allowed');
    }

    if (parts.length === 2 && parts[1] === 'schema' && m === 'GET') return finish(send(res, 200, jsonSchema(stream)));
    if (parts.length === 2 && parts[1] === 'subscribe' && m === 'GET') return finish(subscribe(req, res, stream, url));
    if (parts.length === 2 && Object.hasOwn(FORMATS, parts[1]) && m === 'GET') return finish(sendFormat(req, res, stream, parts[1], url));
    if (parts.length === 4 && parts[1] === 'webhooks' && parts[3] === 'test' && m === 'POST') {
      return finish(testWebhook(req, res, stream, parts[2]));
    }
    if (parts[1] === 'keys' && parts.length <= 3) return finish(keysRoute(req, res, stream, parts, m));

    if (parts[1] === 'items' || parts[1] === 'events') {
      if (parts.length === 2) {
        if (m === 'GET') return finish(listItems(req, res, stream, url));
        if (m === 'POST') return finish(createItems(req, res, stream));
        fail(405, 'Method not allowed');
      }
      const id = parts[2];
      if (parts.length === 3) {
        if (m === 'GET') return finish(getItem(req, res, stream, id, url));
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
    clearInterval(scheduler);
    clearTimeout(touchTimer);
    heartbeat = null;
    webhooks.close();
    for (const subs of subscribers.values()) for (const s of subs) s.res.end();
    subscribers.clear();
    subscriberCount = 0;
  }

  return { route, close, runScheduler };
}
