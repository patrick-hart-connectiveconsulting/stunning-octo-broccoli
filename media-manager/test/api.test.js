import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createApp } from '../src/server.js';
import { imageSize } from '../src/image-size.js';

const TOKEN = 'test-token';
let dir;
let server;
let base;

// 2x3 transparent PNG
const PNG = Buffer.from(
  '89504e470d0a1a0a0000000d4948445200000002000000030806000000b9ea' +
  'de810000000d49444154789c63f8ffffff7f0009fb03fd2a86e38a0000000049454e44ae426082',
  'hex',
);

const auth = { Authorization: `Bearer ${TOKEN}` };

async function call(path, { method = 'GET', json, body, headers = {} } = {}) {
  const res = await fetch(base + path, {
    method,
    headers: { ...(json ? { 'Content-Type': 'application/json' } : {}), ...headers },
    body: json ? JSON.stringify(json) : body,
  });
  const text = await res.text();
  let data = null;
  try { data = JSON.parse(text); } catch { data = text; }
  return { status: res.status, data, res };
}

function form(files, fields = {}) {
  const fd = new FormData();
  for (const [name, content, type] of files) fd.append('files', new Blob([content], { type }), name);
  for (const [k, v] of Object.entries(fields)) fd.append(k, v);
  return fd;
}

before(async () => {
  dir = await mkdtemp(join(tmpdir(), 'media-manager-'));
  ({ server } = await createApp({ dataDir: dir, token: TOKEN, maxFileSize: 1024 }));
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  server.close();
  await rm(dir, { recursive: true, force: true });
});

test('image-size reads PNG, GIF and SVG dimensions', () => {
  assert.deepEqual(imageSize(PNG), { width: 2, height: 3 });
  const gif = Buffer.from('474946383961' + '0500' + '0700' + '000000', 'hex');
  assert.deepEqual(imageSize(gif), { width: 5, height: 7 });
  assert.deepEqual(imageSize(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 40 20"></svg>')), { width: 40, height: 20 });
  assert.equal(imageSize(Buffer.from('hello world, not an image')), null);
});

test('write endpoints require the API token', async () => {
  const r = await call('/api/upload', { method: 'POST', body: form([['a.txt', 'hi', 'text/plain']]) });
  assert.equal(r.status, 401);
  const f = await call('/api/upload/folders', { method: 'POST', json: { name: 'x' } });
  assert.equal(f.status, 401);
});

test('full lifecycle: folders, upload, list, update, replace, delete', async () => {
  // folders
  const photos = await call('/api/upload/folders', { method: 'POST', headers: auth, json: { name: 'Photos' } });
  assert.equal(photos.status, 201);
  const dup = await call('/api/upload/folders', { method: 'POST', headers: auth, json: { name: 'photos' } });
  assert.equal(dup.status, 409);
  const sub = await call('/api/upload/folders', { method: 'POST', headers: auth, json: { name: '2026', parent: photos.data.id } });
  assert.deepEqual(sub.data.path.map((p) => p.name), ['Photos', '2026']);
  const cycle = await call(`/api/upload/folders/${photos.data.id}`, { method: 'PUT', headers: auth, json: { parent: sub.data.id } });
  assert.equal(cycle.status, 400);

  // upload into folder with metadata
  const up = await call('/api/upload', {
    method: 'POST',
    headers: auth,
    body: form([['pixel.png', PNG, 'image/png'], ['notes.txt', 'hello', 'text/plain']], {
      folder: sub.data.id,
      fileInfo: JSON.stringify([{ alternativeText: 'A tiny pixel', caption: 'cap' }]),
    }),
  });
  assert.equal(up.status, 201);
  assert.equal(up.data.length, 2);
  const [img, txt] = up.data;
  assert.equal(img.mime, 'image/png');
  assert.equal(img.width, 2);
  assert.equal(img.height, 3);
  assert.equal(img.alternativeText, 'A tiny pixel');
  assert.equal(img.folder, sub.data.id);
  assert.equal(txt.mime, 'text/plain');

  // binary is served
  const bin = await fetch(base + img.url);
  assert.equal(bin.status, 200);
  assert.equal(bin.headers.get('content-type'), 'image/png');
  assert.deepEqual(Buffer.from(await bin.arrayBuffer()), PNG);
  const ranged = await fetch(base + img.url, { headers: { Range: 'bytes=0-3' } });
  assert.equal(ranged.status, 206);
  assert.equal((await ranged.arrayBuffer()).byteLength, 4);

  // listing, filtering, search
  const root = await call('/api/upload/files?folder=root');
  assert.equal(root.data.data.length, 0);
  const inSub = await call(`/api/upload/files?folder=${sub.data.id}`);
  assert.equal(inSub.data.meta.pagination.total, 2);
  const images = await call('/api/upload/files?type=image');
  assert.deepEqual(images.data.data.map((f) => f.id), [img.id]);
  const found = await call('/api/upload/files?q=tiny');
  assert.deepEqual(found.data.data.map((f) => f.id), [img.id]);
  const paged = await call('/api/upload/files?pageSize=1&page=2&sort=name:asc');
  assert.equal(paged.data.data[0].name, 'pixel.png');
  assert.equal(paged.data.meta.pagination.pageCount, 2);

  // folder counts and non-empty delete protection
  const folders = await call(`/api/upload/folders?parent=${photos.data.id}`);
  assert.deepEqual(folders.data.data[0].children, { folders: 0, files: 2 });
  const blocked = await call(`/api/upload/folders/${sub.data.id}`, { method: 'DELETE', headers: auth });
  assert.equal(blocked.status, 409);

  // update metadata + move to root
  const upd = await call(`/api/upload/files/${img.id}`, {
    method: 'PUT', headers: auth, json: { name: 'renamed.png', caption: '', folder: null },
  });
  assert.equal(upd.status, 200);
  assert.equal(upd.data.name, 'renamed.png');
  assert.equal(upd.data.caption, null);
  assert.equal(upd.data.folder, null);
  const bad = await call(`/api/upload/files/${img.id}`, { method: 'PUT', headers: auth, json: { name: '  ' } });
  assert.equal(bad.status, 400);

  // replace binary keeps the id, swaps the file
  const rep = await call(`/api/upload?id=${img.id}`, {
    method: 'POST', headers: auth, body: form([['other.txt', 'replaced', 'text/plain']]),
  });
  assert.equal(rep.status, 200);
  assert.equal(rep.data.id, img.id);
  assert.equal(rep.data.mime, 'text/plain');
  await assert.rejects(access(join(dir, 'uploads', img.hash + img.ext)));

  // delete files then folders
  for (const id of [img.id, txt.id]) {
    assert.equal((await call(`/api/upload/files/${id}`, { method: 'DELETE', headers: auth })).status, 200);
  }
  await assert.rejects(access(join(dir, 'uploads', txt.hash + txt.ext)));
  assert.equal((await call(`/api/upload/files/${img.id}`)).status, 404);
  assert.equal((await call(`/api/upload/folders/${sub.data.id}`, { method: 'DELETE', headers: auth })).status, 200);
  assert.equal((await call(`/api/upload/folders/${photos.data.id}`, { method: 'DELETE', headers: auth })).status, 200);

  // persisted to disk
  const db = JSON.parse(await readFile(join(dir, 'db.json'), 'utf8'));
  assert.deepEqual(db, { files: [], folders: [] });
});

test('rejects oversized files and leaves no partial batch behind', async () => {
  const r = await call('/api/upload', {
    method: 'POST',
    headers: auth,
    body: form([['ok.txt', 'small', 'text/plain'], ['big.bin', Buffer.alloc(2048), 'application/octet-stream']]),
  });
  assert.equal(r.status, 413);
  const list = await call('/api/upload/files');
  assert.equal(list.data.meta.pagination.total, 0);
});

test('uploaded active content is sandboxed and paths are not traversable', async () => {
  const up = await call('/api/upload', {
    method: 'POST', headers: auth, body: form([['x.svg', '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>', 'image/svg+xml']]),
  });
  const res = await fetch(base + up.data[0].url);
  assert.match(res.headers.get('content-security-policy'), /sandbox/);
  assert.equal(res.headers.get('x-content-type-options'), 'nosniff');

  assert.equal((await fetch(`${base}/uploads/..%2Fdb.json`)).status, 404);
  assert.equal((await fetch(`${base}/..%2F..%2Fpackage.json`)).status, 404);
  assert.equal((await fetch(`${base}/`)).status, 200);
});
