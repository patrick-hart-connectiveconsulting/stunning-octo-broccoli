// Templates, draft & publish, content field types, retention and webhooks.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createHmac } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createApp } from '../src/server.js';

const TOKEN = 'content-token';
let dir;
let app;
let base;

async function call(path, { method = 'GET', json, anon = false } = {}) {
  const headers = {};
  if (json !== undefined) headers['Content-Type'] = 'application/json';
  if (!anon) headers.Authorization = `Bearer ${TOKEN}`;
  const res = await fetch(base + path, { method, headers, body: json !== undefined ? JSON.stringify(json) : undefined });
  return { status: res.status, data: await res.json().catch(() => null) };
}

const errorPaths = (r) => r.data.error.details.errors.map((e) => e.path).sort();

/** Reads SSE frames from a URL until `count` named events have arrived. */
async function sse(path) {
  const controller = new AbortController();
  const res = await fetch(base + path, { signal: controller.signal });
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  return {
    async take(count) {
      const frames = () => buffer.split('\n\n').filter((f) => /^event: /m.test(f));
      while (frames().length < count) buffer += decoder.decode((await reader.read()).value);
      return frames().slice(0, count).map((f) => ({ event: /event: (\S+)/.exec(f)[1], data: JSON.parse(/data: (.*)/.exec(f)[1]) }));
    },
    close: () => controller.abort(),
  };
}

before(async () => {
  dir = await mkdtemp(join(tmpdir(), 'content-'));
  app = await createApp({ dataDir: dir, token: TOKEN, webhookOptions: { retryDelays: [20, 20], timeoutMs: 2000 } });
  await new Promise((r) => app.server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${app.server.address().port}`;
});

after(async () => {
  app.close();
  await rm(dir, { recursive: true, force: true });
});

test('templates are listed and pre-fill new streams', async () => {
  const { data } = await call('/api/stream-templates', { anon: true });
  assert.deepEqual(data.data.map((t) => t.id), ['blank', 'event-log', 'blog-posts', 'social-feed', 'products']);

  const blog = await call('/api/streams', { method: 'POST', json: { name: 'Blog', template: 'blog-posts' } });
  assert.equal(blog.status, 201);
  assert.equal(blog.data.template, 'blog-posts');
  assert.equal(blog.data.draftAndPublish, true);
  assert.deepEqual(blog.data.labels, { singular: 'post', plural: 'posts' });
  assert.ok(blog.data.fields.some((f) => f.name === 'slug' && f.type === 'uid' && f.targetField === 'title'));

  const logs = await call('/api/streams', { method: 'POST', json: { name: 'Logs', template: 'event-log', retention: { maxItems: 3 } } });
  assert.deepEqual(logs.data.retention, { maxItems: 3, maxAgeDays: null }); // explicit value overrides template

  assert.equal((await call('/api/streams', { method: 'POST', json: { name: 'X', template: 'nope' } })).status, 400);
});

test('draft & publish: visibility, required fields only on publish, publish/unpublish', async () => {
  const s = '/api/streams/blog';

  // A draft can be incomplete…
  const draft = await call(`${s}/items`, { method: 'POST', json: { data: { title: 'Hello World' } } });
  assert.equal(draft.status, 201);
  assert.equal(draft.data.publishedAt, null);
  assert.equal(draft.data.data.slug, 'hello-world'); // uid generated from title
  assert.deepEqual(draft.data.data.tags, []);

  // …but can't be published until required fields are filled.
  const blocked = await call(`${s}/items/${draft.data.id}/publish`, { method: 'POST' });
  assert.equal(blocked.status, 400);
  assert.deepEqual(errorPaths(blocked), ['data.body']);

  // Publishing directly on create enforces required fields.
  const bad = await call(`${s}/items`, { method: 'POST', json: { data: { title: 'No body' }, publish: true } });
  assert.deepEqual(errorPaths(bad), ['data.body']);

  // Anonymous readers don't see drafts.
  assert.equal((await call(`${s}/items`, { anon: true })).data.meta.pagination.total, 0);
  assert.equal((await call(`${s}/items/${draft.data.id}`, { anon: true })).status, 404);
  assert.equal((await call(`${s}/items?status=draft`, { anon: true })).status, 401);
  assert.equal((await call(s, { anon: true })).data.itemCount, 0);

  // Editors do.
  assert.equal((await call(`${s}/items?status=draft`)).data.meta.pagination.total, 1);
  assert.equal((await call(s)).data.draftCount, 1);

  // PATCH fills the body; publish via the action endpoint.
  await call(`${s}/items/${draft.data.id}`, { method: 'PATCH', json: { data: { body: '# Hi\n\nFirst post.' } } });
  const published = await call(`${s}/items/${draft.data.id}/publish`, { method: 'POST' });
  assert.equal(published.status, 200);
  assert.ok(published.data.publishedAt);
  assert.equal((await call(`${s}/items`, { anon: true })).data.data[0].data.title, 'Hello World');

  // Unpublish via PATCH flag.
  const unpub = await call(`${s}/items/${draft.data.id}`, { method: 'PATCH', json: { publish: false } });
  assert.equal(unpub.data.publishedAt, null);
  assert.equal((await call(`${s}/items`, { anon: true })).data.meta.pagination.total, 0);

  // Create + publish in one call; status filters.
  await call(`${s}/items`, { method: 'POST', json: { data: { title: 'Second', body: 'x', tags: ['news', 'Launch ', 'news'] }, publish: true } });
  assert.equal((await call(`${s}/items?status=all`)).data.meta.pagination.total, 2);
  assert.equal((await call(`${s}/items?status=published`)).data.meta.pagination.total, 1);
  const second = (await call(`${s}/items?status=published`)).data.data[0];
  assert.deepEqual(second.data.tags, ['news', 'Launch']);
});

test('uid uniqueness, unique fields and tag filters', async () => {
  const s = '/api/streams/blog';
  // Generated uids get a numeric suffix instead of failing.
  const dup = await call(`${s}/items`, { method: 'POST', json: { data: { title: 'Hello world!' } } });
  assert.equal(dup.data.data.slug, 'hello-world-2');
  // A batch reserves values as it goes.
  const batch = await call(`${s}/items`, { method: 'POST', json: [{ data: { title: 'Hello World' } }, { data: { title: 'Hello World' } }] });
  assert.deepEqual(batch.data.map((i) => i.data.slug), ['hello-world-3', 'hello-world-4']);
  // An explicitly chosen duplicate is an error.
  const clash = await call(`${s}/items`, { method: 'POST', json: { data: { title: 'Other', slug: 'hello-world' } } });
  assert.deepEqual(errorPaths(clash), ['data.slug']);
  // An item can keep its own value on update.
  const self = await call(`${s}/items/${dup.data.id}`, { method: 'PATCH', json: { data: { title: 'Renamed' } } });
  assert.equal(self.status, 200);
  assert.equal(self.data.data.slug, 'hello-world-2');
  // Bad uid format
  const badUid = await call(`${s}/items`, { method: 'POST', json: { data: { title: 'T', slug: 'Not A Slug' } } });
  assert.deepEqual(errorPaths(badUid), ['data.slug']);

  await call('/api/streams', { method: 'POST', json: { name: 'Shop', template: 'products' } });
  const p = { name: 'Mug', sku: 'MUG-1', price: 12, currency: 'USD', tags: ['kitchen', 'gift'] };
  assert.equal((await call('/api/streams/shop/items', { method: 'POST', json: { data: p, publish: true } })).status, 201);
  const skuClash = await call('/api/streams/shop/items', { method: 'POST', json: { data: { ...p, name: 'Mug 2' } } });
  assert.deepEqual(errorPaths(skuClash), ['data.sku']);
  await call('/api/streams/shop/items', { method: 'POST', json: { data: { ...p, name: 'Tea', sku: 'TEA-1', tags: ['kitchen'] }, publish: true } });

  const names = async (q) => (await call(`/api/streams/shop/items?${q}&sort=data.name:asc`, { anon: true })).data.data.map((i) => i.data.name);
  assert.deepEqual(await names('filter[tags]=gift'), ['Mug']);
  assert.deepEqual(await names('filter[tags]=kitchen'), ['Mug', 'Tea']);
  assert.deepEqual(await names('filter[tags][in]=gift,none'), ['Mug']);
  assert.deepEqual(await names('filter[tags][ne]=gift'), ['Tea']);
  assert.deepEqual(await names('filter[tags][contains]=GIF'), ['Mug']);
  assert.deepEqual(await names('filter[slug]=tea'), ['Tea']);
});

test('url and email fields, unique on non-uid types, schema export', async () => {
  const created = await call('/api/streams', {
    method: 'POST',
    json: {
      name: 'Contacts',
      fields: [
        { name: 'email', type: 'email', required: true, unique: true },
        { name: 'site', type: 'url' },
        { name: 'bio', type: 'richtext', maxLength: 20 },
      ],
    },
  });
  assert.equal(created.status, 201);
  assert.equal((await call('/api/streams', { method: 'POST', json: { name: 'Bad', fields: [{ name: 'x', type: 'json', unique: true }] } })).status, 400);
  assert.equal((await call('/api/streams', { method: 'POST', json: { name: 'Bad', fields: [{ name: 's', type: 'uid', targetField: 'missing' }] } })).status, 400);

  const bad = await call('/api/streams/contacts/items', { method: 'POST', json: { data: { email: 'nope', site: 'ftp://x', bio: 'x'.repeat(21) } } });
  assert.deepEqual(errorPaths(bad), ['data.bio', 'data.email', 'data.site']);
  assert.equal((await call('/api/streams/contacts/items', { method: 'POST', json: { data: { email: 'a@b.co', site: 'https://a.co' } } })).status, 201);
  assert.deepEqual(errorPaths(await call('/api/streams/contacts/items', { method: 'POST', json: { data: { email: 'a@b.co' } } })), ['data.email']);

  const schema = (await call('/api/streams/contacts/schema', { anon: true })).data;
  assert.equal(schema.properties.email.format, 'email');
  assert.equal(schema.properties.site.anyOf[0].format, 'uri');
  const blogSchema = (await call('/api/streams/blog/schema', { anon: true })).data;
  assert.equal(blogSchema.properties.tags.type, 'array');
  assert.equal(blogSchema.properties.slug.pattern, '^[a-z0-9]+(?:-[a-z0-9]+)*$');
});

test('retention by count and by age', async () => {
  const s = '/api/streams/logs/items';
  const ev = (n, timestamp) => ({ data: { type: `t${n}`, level: 'info' }, ...(timestamp ? { timestamp } : {}) });
  await call(s, { method: 'POST', json: [ev(1), ev(2), ev(3), ev(4), ev(5)] });
  let list = (await call(`${s}?sort=seq`)).data.data.map((i) => i.data.type);
  assert.deepEqual(list, ['t3', 't4', 't5']); // keeps the newest 3

  // The count limit removes the oldest *timestamp*, so a back-dated item goes first.
  await call(s, { method: 'POST', json: ev(6, '2020-01-01T00:00:00Z') });
  list = (await call(`${s}?sort=seq`)).data.data.map((i) => i.data.type);
  assert.deepEqual(list, ['t3', 't4', 't5']);

  // Age limit: setting it applies immediately, and later writes keep enforcing it.
  const old = new Date(Date.now() - 10 * 86400000).toISOString();
  await call('/api/streams/logs', { method: 'PATCH', json: { retention: { maxItems: null, maxAgeDays: 30 } } });
  await call(s, { method: 'POST', json: [ev(7, old), ev(8, '2019-06-01T00:00:00Z')] });
  list = (await call(`${s}?sort=seq`)).data.data.map((i) => i.data.type);
  assert.deepEqual(list, ['t3', 't4', 't5', 't7']);
  await call('/api/streams/logs', { method: 'PATCH', json: { retention: { maxItems: null, maxAgeDays: 5 } } });
  list = (await call(`${s}?sort=seq`)).data.data.map((i) => i.data.type);
  assert.deepEqual(list, ['t3', 't4', 't5']);
  assert.equal((await call('/api/streams/logs', { method: 'PATCH', json: { retention: { maxAgeDays: -1 } } })).status, 400);
});

test('webhooks: signed deliveries, retries, test endpoint, hidden from anonymous readers', async () => {
  const received = [];
  let failNext = 1; // first delivery fails once to exercise retry
  const hookServer = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      if (failNext > 0) {
        failNext--;
        res.writeHead(500).end();
        return;
      }
      received.push({ headers: req.headers, body });
      res.writeHead(204).end();
    });
  });
  await new Promise((r) => hookServer.listen(0, '127.0.0.1', r));
  const hookUrl = `http://127.0.0.1:${hookServer.address().port}/hook`;

  try {
    const bad = await call('/api/streams/blog', { method: 'PATCH', json: { webhooks: [{ url: 'javascript:alert(1)' }] } });
    assert.equal(bad.status, 400);

    const updated = await call('/api/streams/blog', { method: 'PATCH', json: { webhooks: [{ url: hookUrl, events: ['created', 'published'] }] } });
    const hook = updated.data.webhooks[0];
    assert.equal(hook.secret.length, 48);
    assert.equal((await call('/api/streams/blog', { anon: true })).data.webhooks, undefined);

    // Updating keeps the secret unless rotation is requested.
    const again = await call('/api/streams/blog', { method: 'PATCH', json: { webhooks: [{ id: hook.id, url: hookUrl, events: ['created', 'published'] }] } });
    assert.equal(again.data.webhooks[0].secret, hook.secret);

    const item = await call('/api/streams/blog/items', { method: 'POST', json: { data: { title: 'Hooked', body: 'b' } } });
    await call(`/api/streams/blog/items/${item.data.id}`, { method: 'PATCH', json: { data: { body: 'c' } } }); // 'updated' not subscribed
    await call(`/api/streams/blog/items/${item.data.id}/publish`, { method: 'POST' });

    const deadline = Date.now() + 3000;
    while (received.length < 2 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 20));
    assert.deepEqual(received.map((r) => r.headers['x-webhook-event']), ['item.created', 'item.published']);
    for (const r of received) {
      const expected = `sha256=${createHmac('sha256', hook.secret).update(r.body).digest('hex')}`;
      assert.equal(r.headers['x-webhook-signature'], expected);
    }
    const payload = JSON.parse(received[1].body);
    assert.equal(payload.stream.slug, 'blog');
    assert.equal(payload.item.data.body, 'c');

    // Delivery status is recorded (the first delivery needed a retry).
    const stored = (await call('/api/streams/blog')).data.webhooks[0].lastDelivery;
    assert.equal(stored.ok, true);

    const ping = await call(`/api/streams/blog/webhooks/${hook.id}/test`, { method: 'POST' });
    assert.equal(ping.data.ok, true);
    assert.equal(received.at(-1).headers['x-webhook-event'], 'ping');
  } finally {
    hookServer.close();
  }
});

test('live feed: public view hides drafts; editors subscribe with access_token', async () => {
  const pub = await sse('/api/streams/blog/subscribe');
  const editor = await sse(`/api/streams/blog/subscribe?access_token=${TOKEN}`);

  const d = await call('/api/streams/blog/items', { method: 'POST', json: { data: { title: 'Live draft' } } });
  await call(`/api/streams/blog/items/${d.data.id}`, { method: 'PATCH', json: { data: { body: 'ready' } } });
  await call(`/api/streams/blog/items/${d.data.id}/publish`, { method: 'POST' });
  await call(`/api/streams/blog/items/${d.data.id}/unpublish`, { method: 'POST' });

  const ed = await editor.take(4);
  assert.deepEqual(ed.map((f) => f.event), ['created', 'updated', 'published', 'unpublished']);
  // Anonymous subscribers only see the item appear (publish) and disappear (unpublish).
  const pu = await pub.take(2);
  assert.deepEqual(pu.map((f) => f.event), ['created', 'deleted']);
  assert.deepEqual(Object.keys(pu[1].data).sort(), ['id', 'seq']);
  pub.close();
  editor.close();
});

test('enabling draft & publish keeps earlier items published; removed fields are dropped on edit', async () => {
  await call('/api/streams', { method: 'POST', json: { name: 'Notes', fields: [{ name: 'a', type: 'string' }, { name: 'b', type: 'string' }] } });
  const legacy = await call('/api/streams/notes/items', { method: 'POST', json: { data: { a: '1', b: '2' } } });
  await call('/api/streams/notes', { method: 'PATCH', json: { draftAndPublish: true, fields: [{ name: 'a', type: 'string' }] } });
  assert.equal((await call('/api/streams/notes/items', { anon: true })).data.meta.pagination.total, 1);
  // Old data for field "b" doesn't block an edit.
  const edited = await call(`/api/streams/notes/items/${legacy.data.id}`, { method: 'PATCH', json: { data: { a: 'x' } } });
  assert.equal(edited.status, 200);
  assert.deepEqual(edited.data.data, { a: 'x' });
});
