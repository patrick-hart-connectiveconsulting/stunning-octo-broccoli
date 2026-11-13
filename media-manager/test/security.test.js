// Regression tests for the security review findings. Each test reproduces the
// original problem and checks that it is fixed.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp, rm, stat, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createApp, contentDisposition } from '../src/server.js';
import { toCSV } from '../src/formats.js';
import { isPrivateAddress } from '../src/webhooks.js';
import { safeUrl } from '../public/ui/core.js';

const TOKEN = 'sec-token';
let dir;
let app;
let base;
let port;

async function call(path, { method = 'GET', json, raw, token = TOKEN, headers = {} } = {}) {
  const h = { ...headers };
  if (json !== undefined || raw !== undefined) h['Content-Type'] = 'application/json';
  if (token) h.Authorization = `Bearer ${token}`;
  const res = await fetch(base + path, { method, headers: h, body: raw ?? (json !== undefined ? JSON.stringify(json) : undefined) });
  const text = await res.text();
  let data = text;
  try { data = JSON.parse(text); } catch { /* not JSON */ }
  return { status: res.status, data, text, headers: res.headers };
}

/** A raw HTTP request, for headers fetch() won't let us set (Host) or bodies sent slowly. */
function rawRequest({ method = 'GET', path, headers = {} }) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method, path, headers }, (res) => {
      let body = '';
      res.on('data', (c) => { body += c; });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body }));
    });
    req.on('error', reject);
    req.end();
  });
}

before(async () => {
  dir = await mkdtemp(join(tmpdir(), 'sec-'));
  app = await createApp({ dataDir: join(dir, 'data'), token: TOKEN, maxSubscribers: 3, maxReplay: 2, webhookOptions: { retryDelays: [], timeoutMs: 300, maxQueue: 1 } });
  await new Promise((r) => app.server.listen(0, '127.0.0.1', r));
  port = app.server.address().port;
  base = `http://127.0.0.1:${port}`;
  await call('/api/streams', { method: 'POST', json: { name: 'Ev', template: 'events', draftAndPublish: false } });
  await call('/api/streams/ev/items', { method: 'POST', json: { data: { title: 'Real', start: '2026-12-01T10:00:00Z' } } });
});

after(async () => {
  app.close();
  await rm(dir, { recursive: true, force: true });
});

test('iCalendar injection: ?link= with line breaks is refused; url fields reject control characters; bare CR is escaped', async () => {
  const attack = '/api/streams/ev/feed.ics?link=https://x.example/%0D%0AEND:VEVENT%0D%0ABEGIN:VEVENT%0D%0ASUMMARY:INJECTED';
  const r = await call(attack, { token: null });
  assert.equal(r.status, 400);
  assert.ok(!r.text.includes('INJECTED'));
  assert.equal((await call('/api/streams/ev/feed.rss?site=https://x.example/%0Aa', { token: null })).status, 400);

  const stored = await call('/api/streams/ev/items', { method: 'POST', json: { data: { title: 'T', start: '2026-12-02T10:00:00Z', url: 'https://ok.example/\r\nATTACH:https://evil.example/x' } } });
  assert.equal(stored.status, 400);
  assert.match(stored.data.error.details.errors[0].message, /control characters/);
  assert.equal((await call('/api/streams/ev/items', { method: 'POST', json: { data: { title: 'T', start: '2026-12-02T10:00:00Z', url: 'https://ok.example/a?b=1' } } })).status, 201);

  await call('/api/streams/ev/items', { method: 'POST', json: { data: { title: 'Bare\rCR\u0007bell', start: '2026-12-03T10:00:00Z' } } });
  const ics = (await call('/api/streams/ev/feed.ics', { token: null })).text;
  for (const line of ics.split('\r\n')) assert.ok(!/[\r\n\u0000-\u0008\u000b-\u001f]/.test(line), JSON.stringify(line));
  assert.match(ics, /SUMMARY:Bare\\nCRbell/);
});

test('safeUrl removes control characters before checking the scheme', () => {
  for (const u of ['\u0001javascript:alert(1)', 'java\tscript:alert(1)', 'java\nscript:alert(1)', ' JaVaScRiPt:alert(1)', 'data:text/html,x']) {
    assert.equal(safeUrl(u), '#', JSON.stringify(u));
  }
  assert.equal(safeUrl('https://ok.example/a'), 'https://ok.example/a');
  assert.equal(safeUrl('/blog/x'), '/blog/x');
});

test('feeds: Host and X-Forwarded-Proto cannot inject schemes; responses vary on them', async () => {
  const r = await rawRequest({ path: '/api/streams/ev/feed.json', headers: { Host: 'evil.example', 'X-Forwarded-Proto': 'javascript' } });
  const feed = JSON.parse(r.body);
  assert.equal(feed.feed_url, 'http://evil.example/api/streams/ev/feed.json'); // never javascript://
  assert.equal(r.headers.vary, 'Host, X-Forwarded-Proto');
  const https = await rawRequest({ path: '/api/streams/ev/feed.json', headers: { 'X-Forwarded-Proto': 'https' } });
  assert.match(JSON.parse(https.body).feed_url, /^https:\/\//);
  const bad = await rawRequest({ path: '/api/streams/ev/feed.rss', headers: { Host: 'evil.example/x?y' } });
  assert.equal(bad.status, 400);
});

test('downloads: aborted transfers release their file; non-Latin-1 names work', async () => {
  const fd = new FormData();
  fd.append('files', new Blob([Buffer.alloc(8 * 1024 * 1024, 1)]), '日本 "report".bin');
  const file = (await fetch(`${base}/api/upload`, { method: 'POST', headers: { Authorization: `Bearer ${TOKEN}` }, body: fd }).then((r) => r.json()))[0];

  const dl = await fetch(`${base}${file.url}?download`);
  assert.equal(dl.status, 200);
  assert.equal(dl.headers.get('content-disposition'), contentDisposition('日本 "report".bin'));
  assert.match(dl.headers.get('content-disposition'), /filename\*=UTF-8''%E6%97%A5%E6%9C%AC%20%22report%22\.bin/);
  await dl.arrayBuffer();

  if (process.platform === 'linux') {
    const openFds = async () => (await readdir('/proc/self/fd')).length;
    const before = await openFds();
    for (let i = 0; i < 20; i++) {
      await new Promise((resolve) => {
        const req = http.get({ host: '127.0.0.1', port, path: file.url }, (res) => {
          res.once('data', () => { req.destroy(); resolve(); });
        });
        req.on('error', resolve);
      });
    }
    await new Promise((r) => setTimeout(r, 300));
    assert.ok(await openFds() <= before + 2, 'file descriptors leaked by aborted downloads');
  }
});

test('updates re-read the item after the body arrives (no resurrection, no lost update)', async () => {
  const item = (await call('/api/streams/ev/items', { method: 'POST', json: { data: { title: 'Slow', start: '2026-12-05T10:00:00Z' } } })).data;
  // Start a PATCH, send half the body, delete the item, then finish the body.
  const body = JSON.stringify({ data: { title: 'Edited' } });
  const result = new Promise((resolve) => {
    const req = http.request({ host: '127.0.0.1', port, method: 'PATCH', path: `/api/streams/ev/items/${item.id}`, headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) } }, (res) => {
      res.resume();
      res.on('end', () => resolve(res.statusCode));
    });
    req.write(body.slice(0, 5));
    setTimeout(async () => {
      await call(`/api/streams/ev/items/${item.id}`, { method: 'DELETE' });
      req.end(body.slice(5));
    }, 100);
  });
  assert.equal(await result, 404);
  assert.equal((await call(`/api/streams/ev/items/${item.id}`)).status, 404); // still deleted
});

test('live feed: a revoked key stops receiving drafts immediately', async () => {
  await call('/api/streams', { method: 'POST', json: { name: 'Drafts', draftAndPublish: true } });
  const key = (await call('/api/streams/drafts/keys', { method: 'POST', json: { name: 'Preview', scopes: ['read'] } })).data;
  const ctrl = new AbortController();
  const res = await fetch(`${base}/api/streams/drafts/subscribe?access_token=${key.key}`, { signal: ctrl.signal });
  const reader = res.body.getReader();
  let buf = '';
  const waitFor = async (re) => { while (!re.test(buf)) buf += new TextDecoder().decode((await reader.read()).value); };

  await call('/api/streams/drafts/items', { method: 'POST', json: { data: { n: 'draft-before' } } });
  await waitFor(/draft-before/);
  await call(`/api/streams/drafts/keys/${key.id}`, { method: 'DELETE' });
  await call('/api/streams/drafts/items', { method: 'POST', json: { data: { n: 'draft-after' } } });
  await call('/api/streams/drafts/items', { method: 'POST', json: { data: { n: 'published-after' }, publish: true } });
  await waitFor(/published-after/);
  assert.ok(!buf.includes('draft-after'), 'revoked key still received a draft');
  ctrl.abort();
});

test('live feed: connection limit, replay limit', async () => {
  for (let i = 0; i < 3; i++) await call('/api/streams/drafts/items', { method: 'POST', json: { data: { n: i }, publish: true } });
  // maxReplay is 2: a client that missed more is told to reload instead.
  const ctrl = new AbortController();
  const replay = await fetch(`${base}/api/streams/drafts/subscribe?after=0`, { signal: ctrl.signal });
  const reader = replay.body.getReader();
  let buf = '';
  while (!/event: reset/.test(buf)) buf += new TextDecoder().decode((await reader.read()).value);
  assert.ok(!/event: created/.test(buf));
  // maxSubscribers is 3: the 4th connection is refused.
  const extra = [];
  for (let i = 0; i < 2; i++) extra.push(new AbortController());
  const opened = await Promise.all(extra.map((c) => fetch(`${base}/api/streams/drafts/subscribe`, { signal: c.signal })));
  assert.deepEqual(opened.map((r) => r.status), [200, 200]);
  const refused = await fetch(`${base}/api/streams/drafts/subscribe`);
  assert.equal(refused.status, 503);
  ctrl.abort();
  for (const c of extra) c.abort();
});

test('CSV: formulas inside list values are neutralised; numbers are not', () => {
  const s = { fields: [{ name: 'tags', type: 'tags' }, { name: 'meta', type: 'json' }, { name: 'n', type: 'number' }], draftAndPublish: false };
  const csv = toCSV(s, [{ id: '1', seq: 1, timestamp: 't', data: { tags: ['=HYPERLINK("http://evil","x")'], meta: ['@SUM(1)'], n: -5 } }]);
  const row = csv.replace(/^﻿/, '').split('\r\n')[1];
  assert.equal(row, `1,1,t,"'=HYPERLINK(""http://evil"",""x"")",'@SUM(1),-5`);
});

test('webhooks: private destinations are blocked; signatures carry a timestamp; queues are bounded', async () => {
  const hits = [];
  const receiver = http.createServer((req, res) => { hits.push(req.headers); res.end(); });
  await new Promise((r) => receiver.listen(0, '127.0.0.1', r));
  try {
    for (const url of [`http://127.0.0.1:${receiver.address().port}/h`, `http://localhost:${receiver.address().port}/h`, 'http://[::ffff:127.0.0.1]:9/h', 'http://169.254.169.254/latest/meta-data/']) {
      const s = await call('/api/streams/ev', { method: 'PATCH', json: { webhooks: [{ url }] } });
      const ping = await call(`/api/streams/ev/webhooks/${s.data.webhooks[0].id}/test`, { method: 'POST' });
      assert.equal(ping.data.ok, false, url);
      assert.match(ping.data.error, /^Blocked:/, url);
    }
    assert.equal(hits.length, 0);
    for (const a of ['8.8.8.8', '2606:4700::1111']) assert.equal(isPrivateAddress(a), false, a);
  } finally {
    receiver.close();
  }

  // Signature and queue cap, against a local receiver with private addresses allowed.
  const local = await createApp({ dataDir: join(dir, 'data2'), token: TOKEN, allowPrivateWebhooks: true, webhookOptions: { retryDelays: [], timeoutMs: 2000, maxQueue: 1 } });
  await new Promise((r) => local.server.listen(0, '127.0.0.1', r));
  const lb = `http://127.0.0.1:${local.server.address().port}`;
  const got = [];
  let release;
  const gate = new Promise((r) => { release = r; });
  const slow = http.createServer(async (req, res) => { got.push(req.headers); await gate; res.end(); });
  await new Promise((r) => slow.listen(0, '127.0.0.1', r));
  try {
    const req = (path, method, json) => fetch(lb + path, { method, headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' }, body: json && JSON.stringify(json) }).then((r) => r.json());
    await req('/api/streams', 'POST', { name: 'Q' });
    await req('/api/streams/q', 'PATCH', { webhooks: [{ url: `http://127.0.0.1:${slow.address().port}/h`, events: ['created'] }] });
    for (let i = 0; i < 4; i++) await req('/api/streams/q/items', 'POST', { data: { i } });
    const hook = (await req('/api/streams/q', 'GET')).webhooks[0];
    assert.match(hook.lastDelivery.error, /Queue full \(1 waiting\): \d+ deliveries dropped/);
    release();
    await new Promise((r) => setTimeout(r, 200));
    assert.ok(got.length >= 1 && got.length <= 2);
    assert.match(got[0]['x-webhook-timestamp'], /^\d{10}$/);
  } finally {
    release();
    slow.close();
    local.close();
  }
});

test('malformed requests get 400, not 500', async () => {
  assert.equal((await call('/%E0', { token: null })).status, 400);
  for (const [path, method] of [['/api/streams', 'POST'], ['/api/streams/ev', 'PATCH'], ['/api/upload/folders', 'POST'], ['/api/streams/ev/keys', 'POST']]) {
    for (const raw of ['null', '[]', '"x"', '5']) {
      const r = await call(path, { method, raw });
      assert.equal(r.status, 400, `${method} ${path} ${raw}`);
    }
  }
});

test('filter[…][in] is limited and still correct', async () => {
  const many = Array.from({ length: 501 }, (_, i) => `v${i}`).join(',');
  assert.equal((await call(`/api/streams/ev/items?filter[title][in]=${many}`, { token: null })).status, 400);
  const r = await call('/api/streams/ev/items?filter[title][in]=Real,Nope', { token: null });
  assert.deepEqual(r.data.data.map((i) => i.data.title), ['Real']);
});

test('data files are readable by the owner only', { skip: process.platform === 'win32' }, async () => {
  const mode = async (p) => (await stat(p)).mode & 0o777;
  assert.equal(await mode(join(dir, 'data', 'db.json')), 0o600);
  assert.equal(await mode(join(dir, 'data')), 0o700);
  const logs = await readdir(join(dir, 'data', 'events'));
  assert.equal(await mode(join(dir, 'data', 'events', logs[0])), 0o600);
});
