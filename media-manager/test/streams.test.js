import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createApp } from '../src/server.js';
import { slugify } from '../src/streams.js';

const TOKEN = 'stream-token';
const auth = { Authorization: `Bearer ${TOKEN}` };
let dir;
let app;
let base;

async function call(path, { method = 'GET', json, headers = {} } = {}) {
  const res = await fetch(base + path, {
    method,
    headers: { ...(json !== undefined ? { 'Content-Type': 'application/json' } : {}), ...auth, ...headers },
    body: json !== undefined ? JSON.stringify(json) : undefined,
  });
  return { status: res.status, data: await res.json().catch(() => null) };
}

async function start() {
  app = await createApp({ dataDir: dir, token: TOKEN });
  await new Promise((r) => app.server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${app.server.address().port}`;
}

before(async () => {
  dir = await mkdtemp(join(tmpdir(), 'streams-'));
  await start();
});

after(async () => {
  app.close();
  await rm(dir, { recursive: true, force: true });
});

const ORDER_FIELDS = [
  { name: 'orderId', type: 'string', required: true },
  { name: 'total', type: 'number', required: true, min: 0 },
  { name: 'items', type: 'integer' },
  { name: 'status', type: 'enum', options: ['pending', 'paid', 'shipped'], required: true },
  { name: 'gift', type: 'boolean' },
  { name: 'shippedAt', type: 'datetime' },
  { name: 'meta', type: 'json' },
];

test('slugify', () => {
  assert.equal(slugify('  Order Events!! 2026 '), 'order-events-2026');
  assert.equal(slugify('Café Météo'), 'cafe-meteo');
});

test('stream CRUD and validation', async () => {
  assert.equal((await call('/api/streams', { method: 'POST', json: { name: 'x' }, headers: { Authorization: '' } })).status, 401);

  const bad = await call('/api/streams', {
    method: 'POST',
    json: { name: 'Bad', fields: [{ name: '1abc', type: 'nope' }, { name: 'e', type: 'enum' }] },
  });
  assert.equal(bad.status, 400);
  assert.equal(bad.data.error.details.errors.length, 3);

  const created = await call('/api/streams', { method: 'POST', json: { name: 'Order Events', description: 'Shop orders', fields: ORDER_FIELDS } });
  assert.equal(created.status, 201);
  assert.equal(created.data.slug, 'order-events');
  assert.equal(created.data.itemCount, 0);
  assert.equal(created.data.fields[0].maxLength, 255);

  assert.equal((await call('/api/streams', { method: 'POST', json: { name: 'Order events' } })).status, 409);
  assert.equal((await call('/api/streams', { method: 'POST', json: { name: 'x', slug: 'Bad Slug' } })).status, 400);

  const list = await call('/api/streams');
  assert.deepEqual(list.data.data.map((s) => s.slug), ['order-events']);

  const renamed = await call('/api/streams/order-events', { method: 'PATCH', json: { name: 'Orders' } });
  assert.equal(renamed.data.name, 'Orders');
  assert.equal((await call('/api/streams/order-events', { method: 'PATCH', json: { slug: 'other' } })).status, 400);

  const schema = await call('/api/streams/order-events/schema');
  assert.deepEqual(schema.data.required, ['orderId', 'total', 'status']);
  assert.deepEqual(schema.data.properties.status.enum, ['pending', 'paid', 'shipped']);
  assert.equal(schema.data.additionalProperties, false);
});

test('event CRUD, validation, filtering, sorting and pagination', async () => {
  const s = '/api/streams/order-events';

  // validation errors are reported per field
  const invalid = await call(`${s}/events`, {
    method: 'POST',
    json: { data: { orderId: 7, total: -1, status: 'lost', extra: 1 } },
  });
  assert.equal(invalid.status, 400);
  const paths = invalid.data.error.details.errors.map((e) => e.path).sort();
  assert.deepEqual(paths, ['data.extra', 'data.orderId', 'data.status', 'data.total']);
  assert.equal((await call(`${s}/events`, { method: 'POST', json: { orderId: 'A' } })).status, 400); // missing data wrapper

  // shortcut POST /api/streams/:slug creates a single event
  const one = await call(s, {
    method: 'POST',
    json: { data: { orderId: 'A-1', total: 10, status: 'paid', shippedAt: '2026-01-02T03:04:05Z' }, timestamp: '2026-01-01T00:00:00Z' },
  });
  assert.equal(one.status, 201);
  assert.equal(one.data.seq, 1);
  assert.equal(one.data.stream, 'order-events');
  assert.equal(one.data.timestamp, '2026-01-01T00:00:00.000Z');
  assert.equal(one.data.data.shippedAt, '2026-01-02T03:04:05.000Z');
  assert.equal(one.data.data.gift, null);

  // batch create is all-or-nothing
  const badBatch = await call(`${s}/events`, {
    method: 'POST',
    json: [{ data: { orderId: 'B', total: 1, status: 'paid' } }, { data: { orderId: 'C', status: 'paid' } }],
  });
  assert.equal(badBatch.status, 400);
  assert.equal(badBatch.data.error.details.errors[0].path, '[1].data.total');

  const batch = await call(`${s}/events`, {
    method: 'POST',
    json: [
      { data: { orderId: 'B-2', total: 25.5, items: 3, status: 'pending', meta: { src: 'web' } }, timestamp: '2026-02-01T00:00:00Z' },
      { data: { orderId: 'C-3', total: 99, items: 1, status: 'shipped', gift: true }, timestamp: '2026-03-01T00:00:00Z' },
      { data: { orderId: 'D-4', total: 5, status: 'paid' }, timestamp: '2026-04-01T00:00:00Z' },
    ],
  });
  assert.equal(batch.status, 201);
  assert.deepEqual(batch.data.map((e) => e.seq), [2, 3, 4]);

  // default sort: newest timestamp first
  const all = await call(`${s}/events`);
  assert.deepEqual(all.data.data.map((e) => e.data.orderId), ['D-4', 'C-3', 'B-2', 'A-1']);
  assert.equal(all.data.meta.pagination.total, 4);

  const q = async (query) => (await call(`${s}/events?${query}`)).data.data.map((e) => e.data.orderId);
  assert.deepEqual(await q('filter[status]=paid&sort=timestamp:asc'), ['A-1', 'D-4']);
  assert.deepEqual(await q('filter[total][gte]=25&sort=data.total:desc'), ['C-3', 'B-2']);
  assert.deepEqual(await q('filter[status][in]=pending,shipped&sort=seq'), ['B-2', 'C-3']);
  assert.deepEqual(await q('filter[gift]=true'), ['C-3']);
  assert.deepEqual(await q('filter[orderId][contains]=b-'), ['B-2']);
  assert.deepEqual(await q('filter[meta][contains]=web'), ['B-2']);
  assert.deepEqual(await q('filter[status][ne]=paid&sort=timestamp:asc'), ['B-2', 'C-3']);
  assert.deepEqual(await q('since=2026-02-01T00:00:00Z&until=2026-04-01T00:00:00Z&sort=timestamp:asc'), ['B-2', 'C-3']);
  assert.deepEqual(await q('after=2'), ['C-3', 'D-4']); // polling: seq ascending
  assert.deepEqual(await q('sort=data.items:asc'), ['C-3', 'B-2', 'A-1', 'D-4']); // nulls last
  assert.deepEqual(await q('pageSize=2&page=2'), ['B-2', 'A-1']);

  assert.equal((await call(`${s}/events?filter[nope]=1`)).status, 400);
  assert.equal((await call(`${s}/events?sort=bogus`)).status, 400);
  assert.equal((await call(`${s}/events?since=yesterday`)).status, 400);

  // get / patch / put / delete
  const id = one.data.id;
  assert.equal((await call(`${s}/events/${id}`)).data.data.orderId, 'A-1');

  const patched = await call(`${s}/events/${id}`, { method: 'PATCH', json: { data: { status: 'shipped' } } });
  assert.equal(patched.status, 200);
  assert.equal(patched.data.data.status, 'shipped');
  assert.equal(patched.data.data.total, 10);
  assert.equal(patched.data.seq, 1);

  assert.equal((await call(`${s}/events/${id}`, { method: 'PUT', json: { data: { orderId: 'A-1' } } })).status, 400);
  const put = await call(`${s}/events/${id}`, { method: 'PUT', json: { data: { orderId: 'A-1b', total: 11, status: 'paid' } } });
  assert.equal(put.data.data.orderId, 'A-1b');
  assert.equal(put.data.data.shippedAt, null);

  assert.equal((await call(`${s}/events/${id}`, { method: 'DELETE' })).status, 200);
  assert.equal((await call(`${s}/events/${id}`)).status, 404);
  assert.equal((await call(s)).data.itemCount, 3);
  assert.equal((await call(s)).data.lastItemAt, '2026-04-01T00:00:00.000Z');
});

test('schema-less streams accept any object and media fields check references', async () => {
  await call('/api/streams', { method: 'POST', json: { name: 'Raw' } });
  const e = await call('/api/streams/raw/events', { method: 'POST', json: { data: { anything: [1, 2], nested: { ok: true } } } });
  assert.equal(e.status, 201);
  assert.deepEqual(e.data.data.nested, { ok: true });
  assert.equal((await call('/api/streams/raw/events', { method: 'POST', json: { data: [1] } })).status, 400);

  await call('/api/streams', { method: 'POST', json: { name: 'Photos', fields: [{ name: 'image', type: 'media', required: true }] } });
  const missing = await call('/api/streams/photos/events', { method: 'POST', json: { data: { image: 'not-a-file' } } });
  assert.equal(missing.data.error.details.errors[0].message, 'media file does not exist');

  const fd = new FormData();
  fd.append('files', new Blob(['hello'], { type: 'text/plain' }), 'a.txt');
  const up = await fetch(`${base}/api/upload`, { method: 'POST', headers: auth, body: fd }).then((r) => r.json());
  assert.equal((await call('/api/streams/photos/events', { method: 'POST', json: { data: { image: up[0].id } } })).status, 201);
});

test('live subscription delivers created/updated/deleted and replays missed events', async () => {
  const controller = new AbortController();
  const res = await fetch(`${base}/api/streams/raw/subscribe?after=0`, { signal: controller.signal });
  assert.equal(res.headers.get('content-type'), 'text/event-stream; charset=utf-8');
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  const nextFrames = async (n) => {
    while ((buffer.match(/\n\n/g) || []).length < n + 1) buffer += decoder.decode((await reader.read()).value);
    return buffer.split('\n\n').filter((f) => f.includes('event:'));
  };

  // the one existing event is replayed
  let frames = await nextFrames(1);
  assert.match(frames[0], /^id: 1\nevent: created/);

  const created = await call('/api/streams/raw/events', { method: 'POST', json: { data: { n: 2 } } });
  await call(`/api/streams/raw/events/${created.data.id}`, { method: 'PATCH', json: { data: { n: 3 } } });
  await call(`/api/streams/raw/events/${created.data.id}`, { method: 'DELETE' });
  frames = await nextFrames(4);
  assert.deepEqual(frames.map((f) => /event: (\S+)/.exec(f)[1]), ['created', 'created', 'updated', 'deleted']);
  assert.equal(JSON.parse(/data: (.*)/.exec(frames[2])[1]).data.n, 3);
  controller.abort();

  // Without ?after or Last-Event-ID nothing is replayed — only new changes arrive.
  const fresh = await fetch(`${base}/api/streams/raw/subscribe`);
  const r2 = fresh.body.getReader();
  let buf2 = '';
  await call('/api/streams/raw/events', { method: 'POST', json: { data: { n: 4 } } });
  while (!/event: created/.test(buf2)) buf2 += decoder.decode((await r2.read()).value);
  assert.equal((buf2.match(/event: created/g) || []).length, 1);
  assert.match(buf2, /"n":4/);
  await r2.cancel();
});

test('events persist across restarts and deleting a stream removes its log', async () => {
  app.close();
  await start();
  const list = await call('/api/streams/order-events/events?sort=seq');
  assert.deepEqual(list.data.data.map((e) => e.data.orderId), ['B-2', 'C-3', 'D-4']);
  // new sequence numbers continue after a restart
  const next = await call('/api/streams/order-events/events', { method: 'POST', json: { data: { orderId: 'E', total: 1, status: 'paid' } } });
  assert.equal(next.data.seq, 5);

  const streamId = (await call('/api/streams/order-events')).data.id;
  assert.equal((await call('/api/streams/order-events', { method: 'DELETE' })).status, 200);
  assert.equal((await call('/api/streams/order-events')).status, 404);
  await assert.rejects(readFile(join(dir, 'events', `${streamId}.jsonl`)));
});
