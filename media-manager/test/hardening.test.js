// Regression tests for the lower-risk hardening items.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createApp } from '../src/server.js';
import { renderMarkdown } from '../public/ui/core.js';

const TOKEN = 'hard-token';
let dir;
let app;
let base;
let port;

async function call(path, { method = 'GET', json, token = TOKEN } = {}) {
  const headers = {};
  if (json !== undefined) headers['Content-Type'] = 'application/json';
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(base + path, { method, headers, body: json !== undefined ? JSON.stringify(json) : undefined });
  const text = await res.text();
  let data = text;
  try { data = JSON.parse(text); } catch { /* not JSON */ }
  return { status: res.status, data, headers: res.headers };
}

before(async () => {
  dir = await mkdtemp(join(tmpdir(), 'hard-'));
  app = await createApp({ dataDir: join(dir, 'data'), token: TOKEN, maxFileSize: 1024, schedulerIntervalMs: 50 });
  await new Promise((r) => app.server.listen(0, '127.0.0.1', r));
  port = app.server.address().port;
  base = `http://127.0.0.1:${port}`;
});

after(async () => {
  app.close();
  await rm(dir, { recursive: true, force: true });
});

test('admin pages send a strict Content-Security-Policy and refuse framing', async () => {
  for (const path of ['/', '/streams.html']) {
    const r = await fetch(base + path);
    const csp = r.headers.get('content-security-policy');
    assert.match(csp, /script-src 'self'(;|$)/, path);
    assert.match(csp, /frame-ancestors 'none'/, path);
    assert.match(csp, /object-src 'none'/, path);
    assert.equal(r.headers.get('x-frame-options'), 'DENY', path);
    assert.equal(r.headers.get('referrer-policy'), 'same-origin', path);
  }
  const demo = await fetch(`${base}/ui/demo.html`);
  assert.match(demo.headers.get('content-security-policy'), /frame-ancestors 'none'/);
  const js = await fetch(`${base}/ui/streams-ui.js`);
  assert.equal(js.headers.get('content-security-policy'), null); // scripts themselves get no page policy
});

test('oversized bodies get a 413 response, not a dropped connection', async () => {
  const send = (path, headers, bytes) => new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method: 'POST', path, headers: { Authorization: `Bearer ${TOKEN}`, ...headers } }, (res) => {
      let body = '';
      res.on('data', (c) => { body += c; });
      res.on('end', () => resolve({ status: res.statusCode, body, connection: res.headers.connection }));
    });
    req.on('error', reject);
    req.end(Buffer.alloc(bytes, 'a'));
  });
  // JSON limit (1 MB), declared up front.
  const json = await send('/api/streams', { 'Content-Type': 'application/json' }, 2 * 1024 * 1024);
  assert.equal(json.status, 413);
  assert.match(JSON.parse(json.body).error.message, /Payload too large/);
  assert.equal(json.connection, 'close');
  // Chunked upload with no Content-Length: the limit is found while reading.
  const chunked = await new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method: 'POST', path: '/api/upload', headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'multipart/form-data; boundary=x', 'Transfer-Encoding': 'chunked' } }, (res) => {
      let body = '';
      res.on('data', (c) => { body += c; });
      res.on('end', () => resolve({ status: res.statusCode, body }));
    });
    req.on('error', reject);
    const chunk = Buffer.alloc(64 * 1024, 'b');
    let sent = 0;
    const pump = () => {
      while (sent < 4 * 1024 * 1024) {
        sent += chunk.length;
        if (!req.write(chunk)) return req.once('drain', pump);
      }
      req.end();
    };
    req.on('response', () => {}); // the answer may arrive before we finish sending
    pump();
  }).catch((err) => ({ status: 'error', body: err.message }));
  assert.equal(chunked.status, 413, chunked.body);
});

test('generated UIDs stay within maxLength', async () => {
  await call('/api/streams', { method: 'POST', json: { name: 'Short', fields: [{ name: 'title', type: 'string' }, { name: 'slug', type: 'uid', targetField: 'title', maxLength: 10 }] } });
  const slugs = [];
  for (let i = 0; i < 12; i++) slugs.push((await call('/api/streams/short/items', { method: 'POST', json: { data: { title: 'abcdefghijklmnop' } } })).data.data.slug);
  for (const s of slugs) assert.ok(s.length <= 10, s);
  assert.equal(new Set(slugs).size, slugs.length);
  assert.deepEqual(slugs.slice(0, 3), ['abcd', 'abcd-2', 'abcd-3']);
  assert.equal(slugs[10], 'abcd-11');
});

test('anonymous readers do not see scheduling details', async () => {
  await call('/api/streams', { method: 'POST', json: { name: 'News', draftAndPublish: true } });
  const item = (await call('/api/streams/news/items', { method: 'POST', json: { data: { t: 1 }, publish: true, unpublishAt: new Date(Date.now() + 3600000).toISOString() } })).data;
  const anonList = (await call('/api/streams/news/items', { token: null })).data.data[0];
  const anonOne = (await call(`/api/streams/news/items/${item.id}`, { token: null })).data;
  for (const v of [anonList, anonOne]) {
    assert.equal('unpublishAt' in v, false);
    assert.equal('publishAt' in v, false);
  }
  assert.ok((await call(`/api/streams/news/items/${item.id}`)).data.unpublishAt);
});

test('publish and unpublish due in the same tick end consistently', async () => {
  const soon = (ms) => new Date(Date.now() + ms).toISOString();
  const item = (await call('/api/streams/news/items', { method: 'POST', json: { data: { t: 2 }, publishAt: soon(60), unpublishAt: soon(80) } })).data;
  await new Promise((r) => setTimeout(r, 400));
  const after = (await call(`/api/streams/news/items/${item.id}`)).data;
  assert.equal(after.publishedAt, null);
  assert.equal(after.publishAt, null);
  assert.equal(after.unpublishAt, null);
});

test('a stale temporary file cannot keep loose permissions', { skip: process.platform === 'win32' }, async () => {
  const db = join(dir, 'data', 'db.json');
  await writeFile(`${db}.${process.pid}.tmp`, 'stale', { mode: 0o644 });
  await call('/api/streams', { method: 'POST', json: { name: 'Perm' } });
  assert.equal((await stat(db)).mode & 0o777, 0o600);
});

test('deeply nested quotes render without a stack overflow', () => {
  const html = renderMarkdown(`${'>'.repeat(50000)} deep <b>x</b>`);
  assert.equal((html.match(/<blockquote>/g) || []).length, 9);
  assert.ok(!html.includes('<b>'));
});
