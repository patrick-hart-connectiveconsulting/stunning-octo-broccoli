// Relations between streams, per-stream API keys, scheduled publishing.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createApp } from '../src/server.js';

const TOKEN = 'main-token';
let dir;
let app;
let base;

async function call(path, { method = 'GET', json, token = TOKEN } = {}) {
  const headers = {};
  if (json !== undefined) headers['Content-Type'] = 'application/json';
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(base + path, { method, headers, body: json !== undefined ? JSON.stringify(json) : undefined });
  return { status: res.status, data: await res.json().catch(() => null) };
}
const errorPaths = (r) => r.data.error.details.errors.map((e) => e.path).sort();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const inMs = (ms) => new Date(Date.now() + ms).toISOString();

before(async () => {
  dir = await mkdtemp(join(tmpdir(), 'rks-'));
  app = await createApp({ dataDir: dir, token: TOKEN, schedulerIntervalMs: 50 });
  await new Promise((r) => app.server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${app.server.address().port}`;
});

after(async () => {
  app.close();
  await rm(dir, { recursive: true, force: true });
});

// ---- relations --------------------------------------------------------------

const ids = {};

test('relation fields: target validation, reference checks, populate, filters', async () => {
  await call('/api/streams', { method: 'POST', json: { name: 'Authors', draftAndPublish: true, fields: [{ name: 'name', type: 'string', required: true }] } });
  await call('/api/streams', { method: 'POST', json: { name: 'Categories', fields: [{ name: 'title', type: 'string' }] } });

  const badTarget = await call('/api/streams', { method: 'POST', json: { name: 'X', fields: [{ name: 'a', type: 'relation', target: 'nope' }] } });
  assert.deepEqual(errorPaths(badTarget), ['fields[0].target']);

  const posts = await call('/api/streams', {
    method: 'POST',
    json: {
      name: 'Posts',
      fields: [
        { name: 'title', type: 'string', required: true },
        { name: 'author', type: 'relation', target: 'authors', required: true },
        { name: 'categories', type: 'relation', target: 'categories', multiple: true },
        { name: 'related', type: 'relation', target: 'posts', multiple: true }, // self-relation
      ],
    },
  });
  assert.equal(posts.status, 201);

  ids.ada = (await call('/api/streams/authors/items', { method: 'POST', json: { data: { name: 'Ada' }, publish: true } })).data.id;
  ids.draftAuthor = (await call('/api/streams/authors/items', { method: 'POST', json: { data: { name: 'Draft Dan' } } })).data.id;
  ids.news = (await call('/api/streams/categories/items', { method: 'POST', json: { data: { title: 'News' } } })).data.id;
  ids.tech = (await call('/api/streams/categories/items', { method: 'POST', json: { data: { title: 'Tech' } } })).data.id;

  // Unknown ids are rejected per field.
  const bad = await call('/api/streams/posts/items', { method: 'POST', json: { data: { title: 'x', author: 'missing', categories: [ids.news, 'nope'] } } });
  assert.deepEqual(errorPaths(bad), ['data.author', 'data.categories']);
  const wrongShape = await call('/api/streams/posts/items', { method: 'POST', json: { data: { title: 'x', author: [ids.ada] } } });
  assert.deepEqual(errorPaths(wrongShape), ['data.author']);

  const p1 = await call('/api/streams/posts/items', { method: 'POST', json: { data: { title: 'First', author: ids.ada, categories: [ids.news, ids.tech, ids.news] } } });
  assert.equal(p1.status, 201);
  assert.deepEqual(p1.data.data.categories, [ids.news, ids.tech]); // de-duplicated
  ids.p1 = p1.data.id;
  const p2 = await call('/api/streams/posts/items', { method: 'POST', json: { data: { title: 'Second', author: ids.draftAuthor, categories: [ids.tech], related: [ids.p1] } } });
  ids.p2 = p2.data.id;

  // populate=* replaces ids with items; drafts in the target are hidden from anonymous readers.
  const anon = await call(`/api/streams/posts/items?populate=*&sort=seq`, { token: null });
  assert.equal(anon.data.data[0].data.author.data.name, 'Ada');
  assert.deepEqual(anon.data.data[0].data.categories.map((c) => c.data.title), ['News', 'Tech']);
  assert.equal(anon.data.data[1].data.author, null); // Draft Dan is not published
  assert.equal(anon.data.data[1].data.related[0].data.title, 'First');
  const editor = await call(`/api/streams/posts/items/${ids.p2}?populate=author`);
  assert.equal(editor.data.data.author.data.name, 'Draft Dan');
  assert.equal(editor.data.data.categories[0], ids.tech); // not populated: still an id
  assert.equal((await call('/api/streams/posts/items?populate=title')).status, 400);

  // Filter by related id (single and multiple).
  const titles = async (q) => (await call(`/api/streams/posts/items?${q}&sort=seq`)).data.data.map((i) => i.data.title);
  assert.deepEqual(await titles(`filter[author]=${ids.ada}`), ['First']);
  assert.deepEqual(await titles(`filter[categories]=${ids.tech}`), ['First', 'Second']);
  assert.deepEqual(await titles(`filter[categories][ne]=${ids.news}`), ['Second']);

  const schema = (await call('/api/streams/posts/schema')).data;
  assert.equal(schema.properties.categories.type, 'array');
  assert.equal(schema.properties.author.format, 'uuid');
});

test('deleting a related item clears references; referenced streams cannot be deleted', async () => {
  await call(`/api/streams/categories/items/${ids.news}`, { method: 'DELETE' });
  const p1 = (await call(`/api/streams/posts/items/${ids.p1}`)).data;
  assert.deepEqual(p1.data.categories, [ids.tech]);

  await call(`/api/streams/authors/items/${ids.ada}`, { method: 'DELETE' });
  assert.equal((await call(`/api/streams/posts/items/${ids.p1}`)).data.data.author, null);

  // Self-relation cleanup
  await call(`/api/streams/posts/items/${ids.p1}`, { method: 'DELETE' });
  assert.deepEqual((await call(`/api/streams/posts/items/${ids.p2}`)).data.data.related, []);

  const blocked = await call('/api/streams/authors', { method: 'DELETE' });
  assert.equal(blocked.status, 409);
  assert.match(blocked.data.error.message, /"posts" \(author\)/);
  // Removing the field unblocks it.
  await call('/api/streams/posts', { method: 'PATCH', json: { fields: [{ name: 'title', type: 'string' }, { name: 'categories', type: 'relation', target: 'categories', multiple: true }] } });
  assert.equal((await call('/api/streams/authors', { method: 'DELETE' })).status, 200);
});

// ---- API keys ---------------------------------------------------------------

test('per-stream API keys: scopes, isolation, expiry, revocation', async () => {
  // Only the main token manages keys.
  assert.equal((await call('/api/streams/categories/keys', { token: null })).status, 401);

  const bad = await call('/api/streams/categories/keys', { method: 'POST', json: { name: '', scopes: ['fly'] } });
  assert.deepEqual(errorPaths(bad), ['name', 'scopes']);

  const ingest = await call('/api/streams/categories/keys', { method: 'POST', json: { name: 'Ingest', scopes: ['create'] } });
  assert.equal(ingest.status, 201);
  assert.match(ingest.data.key, /^mmk_/);
  assert.equal(ingest.data.prefix, ingest.data.key.slice(0, 12));
  assert.equal(ingest.data.hash, undefined);
  const ingestKey = ingest.data.key;

  // The secret is never shown again.
  const listed = await call('/api/streams/categories/keys');
  assert.equal(listed.data.data[0].key, undefined);
  assert.equal(listed.data.data[0].hash, undefined);
  assert.equal((await call('/api/streams/categories')).data.apiKeys.length, 1);
  assert.equal((await call('/api/streams/categories', { token: null })).data.apiKeys, undefined);

  // create scope: can add items, nothing else.
  const created = await call('/api/streams/categories/items', { method: 'POST', token: ingestKey, json: { data: { title: 'From device' } } });
  assert.equal(created.status, 201);
  assert.equal((await call(`/api/streams/categories/items/${created.data.id}`, { method: 'DELETE', token: ingestKey })).status, 403);
  assert.equal((await call(`/api/streams/categories/items/${created.data.id}`, { method: 'PATCH', token: ingestKey, json: { data: {} } })).status, 403);
  assert.equal((await call('/api/streams/categories', { method: 'PATCH', token: ingestKey, json: { name: 'Hacked' } })).status, 401);
  assert.equal((await call('/api/streams/categories/keys', { token: ingestKey })).status, 401);
  // Keys are bound to their stream.
  assert.equal((await call('/api/streams/posts/items', { method: 'POST', token: ingestKey, json: { data: { title: 'x' } } })).status, 401);
  // …and to the streams API (not the media library).
  const fd = new FormData();
  fd.append('files', new Blob(['x']), 'x.txt');
  const upload = await fetch(`${base}/api/upload`, { method: 'POST', headers: { Authorization: `Bearer ${ingestKey}` }, body: fd });
  assert.equal(upload.status, 401);

  // lastUsedAt is tracked.
  assert.ok((await call('/api/streams/categories/keys')).data.data[0].lastUsedAt);

  // read scope sees drafts on draft & publish streams.
  await call('/api/streams', { method: 'POST', json: { name: 'Docs', draftAndPublish: true } });
  await call('/api/streams/docs/items', { method: 'POST', json: { data: { secret: true } } });
  const reader = (await call('/api/streams/docs/keys', { method: 'POST', json: { name: 'Preview site', scopes: ['read'] } })).data.key;
  assert.equal((await call('/api/streams/docs/items?status=draft', { token: null })).status, 401);
  assert.equal((await call('/api/streams/docs/items?status=draft', { token: reader })).data.meta.pagination.total, 1);
  assert.equal((await call('/api/streams/docs', { token: reader })).data.draftCount, 1);
  assert.equal((await call('/api/streams/docs', { token: reader })).data.apiKeys, undefined);
  assert.equal((await call('/api/streams/docs/items', { method: 'POST', token: reader, json: { data: {} } })).status, 403);

  // Live feed accepts a key via ?access_token and gives the editor view.
  const ctrl = new AbortController();
  const res = await fetch(`${base}/api/streams/docs/subscribe?access_token=${reader}`, { signal: ctrl.signal });
  const r = res.body.getReader();
  await call('/api/streams/docs/items', { method: 'POST', json: { data: { draft: 2 } } });
  let buf = '';
  while (!buf.includes('event: created')) buf += new TextDecoder().decode((await r.read()).value);
  ctrl.abort();

  // Scope changes, expiry and revocation.
  const keyId = listed.data.data[0].id;
  await call(`/api/streams/categories/keys/${keyId}`, { method: 'PATCH', json: { scopes: ['create', 'delete'] } });
  assert.equal((await call(`/api/streams/categories/items/${created.data.id}`, { method: 'DELETE', token: ingestKey })).status, 200);
  assert.equal((await call(`/api/streams/categories/keys/${keyId}`, { method: 'PATCH', json: { expiresAt: '2000-01-01T00:00:00Z' } })).status, 400);

  const shortLived = (await call('/api/streams/categories/keys', { method: 'POST', json: { name: 'Temp', scopes: ['create'], expiresAt: inMs(150) } })).data.key;
  assert.equal((await call('/api/streams/categories/items', { method: 'POST', token: shortLived, json: { data: {} } })).status, 201);
  await sleep(200);
  assert.equal((await call('/api/streams/categories/items', { method: 'POST', token: shortLived, json: { data: {} } })).status, 401);

  await call(`/api/streams/categories/keys/${keyId}`, { method: 'DELETE' });
  assert.equal((await call('/api/streams/categories/items', { method: 'POST', token: ingestKey, json: { data: {} } })).status, 401);
});

test('API keys survive a restart (only the hash is stored)', async () => {
  const { key } = (await call('/api/streams/docs/keys', { method: 'POST', json: { name: 'Persist', scopes: ['create'] } })).data;
  app.close();
  app = await createApp({ dataDir: dir, token: TOKEN, schedulerIntervalMs: 50 });
  await new Promise((r) => app.server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${app.server.address().port}`;
  assert.equal((await call('/api/streams/docs/items', { method: 'POST', token: key, json: { data: {} } })).status, 201);
  const raw = JSON.stringify(app.store.data.streams);
  assert.ok(!raw.includes(key), 'plain-text key must not be persisted');
});

// ---- scheduled publishing -----------------------------------------------------

test('scheduled publish and unpublish', async () => {
  await call('/api/streams', { method: 'POST', json: { name: 'News', template: 'blog-posts' } });
  const s = '/api/streams/news/items';

  // Scheduling needs draft & publish, valid dates, and complete data.
  assert.equal((await call('/api/streams/categories/items', { method: 'POST', json: { data: {}, publishAt: inMs(1000) } })).status, 400);
  assert.deepEqual(errorPaths(await call(s, { method: 'POST', json: { data: { title: 'T', body: 'b' }, publishAt: 'soon' } })), ['publishAt']);
  assert.deepEqual(errorPaths(await call(s, { method: 'POST', json: { data: { title: 'No body' }, publishAt: inMs(1000) } })), ['data.body']);
  assert.deepEqual(errorPaths(await call(s, { method: 'POST', json: { data: { title: 'T', body: 'b' }, publish: true, publishAt: inMs(1000) } })), ['publishAt']);
  assert.deepEqual(errorPaths(await call(s, { method: 'POST', json: { data: { title: 'T', body: 'b' }, unpublishAt: inMs(1000) } })), ['unpublishAt']);

  // Schedule a post to go live shortly, and to come down a bit later.
  const at = inMs(300);
  const item = await call(s, { method: 'POST', json: { data: { title: 'Launch', body: 'Soon!' }, publishAt: at, unpublishAt: inMs(900) } });
  assert.equal(item.status, 201);
  assert.equal(item.data.publishedAt, null);
  assert.equal(item.data.publishAt, at);
  assert.equal((await call(`${s}?status=scheduled`)).data.meta.pagination.total, 1);
  assert.equal((await call('/api/streams/news')).data.scheduledCount, 1);
  assert.equal((await call(s, { token: null })).data.meta.pagination.total, 0);

  // Live public feed sees it appear, then disappear.
  const ctrl = new AbortController();
  const res = await fetch(`${base}/api/streams/news/subscribe`, { signal: ctrl.signal });
  const reader = res.body.getReader();
  let buf = '';
  const waitFor = async (re) => { while (!re.test(buf)) buf += new TextDecoder().decode((await reader.read()).value); };

  await waitFor(/event: created/);
  const live = (await call(s, { token: null })).data.data;
  assert.equal(live.length, 1);
  // Scheduling details are for editors only.
  assert.equal('publishAt' in live[0], false);
  assert.equal('unpublishAt' in live[0], false);
  assert.match(buf, /event: created/);
  assert.ok(!/unpublishAt/.test(buf), 'the public live feed must not reveal the takedown time');
  const editorView = (await call(`${s}/${item.data.id}`)).data;
  assert.equal(editorView.publishAt, null);
  assert.ok(editorView.unpublishAt);

  await waitFor(/event: deleted/);
  ctrl.abort();
  const after = (await call(`${s}/${item.data.id}`)).data;
  assert.equal(after.publishedAt, null);
  assert.equal(after.unpublishAt, null);
});

test('schedule edits: reschedule, cancel, past times apply immediately, failures are recorded', async () => {
  const s = '/api/streams/news/items';
  const draft = (await call(s, { method: 'POST', json: { data: { title: 'Later', body: 'x' } } })).data;

  // Schedule far ahead, then cancel.
  await call(`${s}/${draft.id}`, { method: 'PATCH', json: { publishAt: inMs(3600000) } });
  assert.equal((await call(`${s}?status=scheduled`)).data.meta.pagination.total, 1);
  const cancelled = await call(`${s}/${draft.id}`, { method: 'PATCH', json: { publishAt: null } });
  assert.equal(cancelled.data.publishAt, null);
  assert.equal((await call(`${s}?status=scheduled`)).data.meta.pagination.total, 0);

  // A time in the past publishes right away.
  const now = await call(`${s}/${draft.id}`, { method: 'PATCH', json: { publishAt: '2020-01-01T00:00:00Z' } });
  assert.ok(now.data.publishedAt);
  // Already published: publishAt is refused, unpublishAt is fine.
  assert.equal((await call(`${s}/${draft.id}`, { method: 'PATCH', json: { publishAt: inMs(5000) } })).status, 400);
  const down = await call(`${s}/${draft.id}`, { method: 'PATCH', json: { unpublishAt: inMs(5000) } });
  assert.ok(down.data.unpublishAt);
  // Manual unpublish clears the pending unpublishAt.
  const manual = await call(`${s}/${draft.id}/unpublish`, { method: 'POST' });
  assert.equal(manual.data.unpublishAt, null);

  // If the item is no longer valid when its time comes, it stays a draft and records why.
  const doomed = (await call(s, { method: 'POST', json: { data: { title: 'Doomed', body: 'x' }, publishAt: inMs(200) } })).data;
  const stream = (await call('/api/streams/news')).data;
  await call('/api/streams/news', { method: 'PATCH', json: { fields: [...stream.fields, { name: 'summary', type: 'string', required: true }] } });
  await sleep(400);
  const failed = (await call(`${s}/${doomed.id}`)).data;
  assert.equal(failed.publishedAt, null);
  assert.equal(failed.publishAt, null);
  assert.match(failed.scheduleError, /data\.summary is required/);
  // Fixing it and rescheduling clears the error.
  const fixed = await call(`${s}/${doomed.id}`, { method: 'PATCH', json: { data: { summary: 'ok' }, publishAt: inMs(100) } });
  assert.equal(fixed.data.scheduleError, undefined);
  await sleep(300);
  assert.ok((await call(`${s}/${doomed.id}`)).data.publishedAt);
});

test('schedules survive a restart and fire on catch-up', async () => {
  const s = '/api/streams/news/items';
  const item = (await call(s, { method: 'POST', json: { data: { title: 'Overnight', body: 'x', summary: 's' }, publishAt: inMs(250) } })).data;
  app.close(); // server is down when the time passes
  await sleep(400);
  app = await createApp({ dataDir: dir, token: TOKEN, schedulerIntervalMs: 50 });
  await new Promise((r) => app.server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${app.server.address().port}`;
  await sleep(150);
  assert.ok((await call(`${s}/${item.id}`)).data.publishedAt);
});
