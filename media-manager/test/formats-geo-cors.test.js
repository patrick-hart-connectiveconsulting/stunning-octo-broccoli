// CORS, map pins, date fields, media population, schema.org types and the
// standard output formats (iCalendar, RSS, JSON Feed, GeoJSON, CSV).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createApp, parseOrigins } from '../src/server.js';
import { markdownToText } from '../src/formats.js';

const TOKEN = 'fmt-token';
const SITE = 'https://www.example.com';
let dir;
let app;
let base;

async function call(path, { method = 'GET', json, token = TOKEN, headers = {} } = {}) {
  const h = { ...headers };
  if (json !== undefined) h['Content-Type'] = 'application/json';
  if (token) h.Authorization = `Bearer ${token}`;
  const res = await fetch(base + path, { method, headers: h, body: json !== undefined ? JSON.stringify(json) : undefined });
  const text = await res.text();
  let data = text;
  try { data = JSON.parse(text); } catch { /* not JSON */ }
  return { status: res.status, data, text, headers: res.headers };
}
const errorPaths = (r) => r.data.error.details.errors.map((e) => e.path).sort();

before(async () => {
  dir = await mkdtemp(join(tmpdir(), 'fmt-'));
  app = await createApp({ dataDir: dir, token: TOKEN, cors: `${SITE}, http://localhost:5173`, publicUrl: 'https://cms.example.com' });
  await new Promise((r) => app.server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${app.server.address().port}`;
});

after(async () => {
  app.close();
  await rm(dir, { recursive: true, force: true });
});

test('CORS: allowed origins get headers and preflight answers; others do not', async () => {
  const ok = await call('/api/health', { token: null, headers: { Origin: SITE } });
  assert.equal(ok.headers.get('access-control-allow-origin'), SITE);
  assert.equal(ok.headers.get('vary'), 'Origin');

  const other = await call('/api/health', { token: null, headers: { Origin: 'https://evil.example' } });
  assert.equal(other.headers.get('access-control-allow-origin'), null);

  const pre = await fetch(`${base}/api/streams`, {
    method: 'OPTIONS',
    headers: { Origin: SITE, 'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'authorization,content-type' },
  });
  assert.equal(pre.status, 204);
  assert.match(pre.headers.get('access-control-allow-methods'), /POST/);
  assert.match(pre.headers.get('access-control-allow-headers'), /Authorization/);

  assert.deepEqual((await call('/api/config', { token: null })).data.corsOrigins, [SITE, 'http://localhost:5173']);
  assert.deepEqual(parseOrigins('*'), ['*']);
  assert.throws(() => parseOrigins('www.example.com'), /Invalid CORS origin/);
  assert.throws(() => parseOrigins('https://example.com/path'), /Invalid CORS origin/);
});

test('templates carry schema.org types; schemaType can be overridden and is validated', async () => {
  const templates = (await call('/api/stream-templates', { token: null })).data.data;
  for (const id of ['events', 'pages', 'people', 'locations', 'faq', 'testimonials', 'jobs', 'announcements', 'case-studies']) {
    assert.ok(templates.some((t) => t.id === id), id);
  }
  const events = await call('/api/streams', { method: 'POST', json: { name: 'Events', template: 'events' } });
  assert.equal(events.data.schemaType, 'Event');
  const custom = await call('/api/streams', { method: 'POST', json: { name: 'Talks', template: 'events', schemaType: 'EducationEvent' } });
  assert.equal(custom.data.schemaType, 'EducationEvent');
  assert.deepEqual(errorPaths(await call('/api/streams', { method: 'POST', json: { name: 'Bad', schemaType: 'not a type' } })), ['schemaType']);
  assert.equal((await call('/api/streams/talks', { method: 'PATCH', json: { schemaType: null } })).data.schemaType, null);
});

test('map pin and date fields: validation, within/near filters', async () => {
  const s = '/api/streams/events/items';
  const bad = await call(s, { method: 'POST', json: { data: { title: 'x', start: '2026-01-01T10:00:00Z', location: { lat: 100, lng: 0 } } } });
  assert.deepEqual(errorPaths(bad), ['data.location']);

  const mk = (title, start, location, extra = {}) => call(s, { method: 'POST', json: { data: { title, start, location, ...extra }, publish: true } });
  await mk('London meetup', '2026-12-01T18:00:00Z', { lat: 51.5074, lng: -0.1278, label: 'London' }, { venue: 'Shoreditch, London', end: '2026-12-01T21:00:00Z' });
  await mk('Paris conference', '2026-12-10T08:00:00Z', { lat: 48.8566, lng: 2.3522 }, { allDay: true, end: '2026-12-11T08:00:00Z' });
  await mk('Tokyo summit', '2026-12-20T01:00:00Z', { lat: 35.6762, lng: 139.6503 });
  await mk('Fiji retreat', '2026-12-24T00:00:00Z', { lat: -17.7134, lng: 178.065 });
  await call(s, { method: 'POST', json: { data: { title: 'Draft: secret', start: '2026-12-05T10:00:00Z' } } });

  const titles = async (q) => (await call(`${s}?${q}&sort=data.start`, { token: null })).data.data.map((i) => i.data.title);
  assert.deepEqual(await titles('filter[location][within]=-10,40,10,60'), ['London meetup', 'Paris conference']);
  assert.deepEqual(await titles('filter[location][near]=51.5,-0.12,400'), ['London meetup', 'Paris conference']); // ~340 km apart
  assert.deepEqual(await titles('filter[location][near]=51.5,-0.12,50'), ['London meetup']);
  assert.deepEqual(await titles('filter[location][within]=170,-30,-170,0'), ['Fiji retreat']); // box across the antimeridian
  assert.equal((await call(`${s}?filter[title][near]=1,2,3`)).status, 400);
  assert.equal((await call(`${s}?filter[location]=51`)).status, 400);
  assert.equal((await call(`${s}?filter[location][within]=1,2,3`)).status, 400);

  await call('/api/streams', { method: 'POST', json: { name: 'Jobs', template: 'jobs' } });
  const job = { title: 'Dev', location: 'Remote', employmentType: 'Full-time', description: 'x', applyUrl: 'https://jobs.example.com/1' };
  assert.deepEqual(errorPaths(await call('/api/streams/jobs/items', { method: 'POST', json: { data: { ...job, closingDate: '2026-02-30' }, publish: true } })), ['data.closingDate']);
  assert.equal((await call('/api/streams/jobs/items', { method: 'POST', json: { data: { ...job, closingDate: '2026-12-31' }, publish: true } })).status, 201);
  assert.deepEqual(await (async () => (await call('/api/streams/jobs/items?filter[closingDate][gte]=2026-12-01', { token: null })).data.data.map((i) => i.data.closingDate))(), ['2026-12-31']);

  const schema = (await call('/api/streams/events/schema', { token: null })).data;
  assert.deepEqual(schema.properties.location.anyOf[0].required, ['lat', 'lng']);
});

test('populate fills in media fields with file details', async () => {
  const fd = new FormData();
  fd.append('files', new Blob([Buffer.from('89504e470d0a1a0a0000000d4948445200000002000000030806000000b9eade810000000d49444154789c63f8ffffff7f0009fb03fd2a86e38a0000000049454e44ae426082', 'hex')], { type: 'image/png' }), 'poster.png');
  const file = (await fetch(`${base}/api/upload`, { method: 'POST', headers: { Authorization: `Bearer ${TOKEN}` }, body: fd }).then((r) => r.json()))[0];
  await call('/api/streams/events/items', { method: 'POST', json: { data: { title: 'With poster', start: '2027-01-05T10:00:00Z', image: file.id }, publish: true } });
  const plain = (await call('/api/streams/events/items?filter[title]=With%20poster', { token: null })).data.data[0];
  assert.equal(plain.data.image, file.id);
  const populated = (await call('/api/streams/events/items?filter[title]=With%20poster&populate=image', { token: null })).data.data[0];
  assert.equal(populated.data.image.url, file.url);
  assert.equal(populated.data.image.width, 2);
  assert.equal((await call('/api/streams/events/items?populate=title')).status, 400);
});

test('iCalendar feed', async () => {
  const r = await call('/api/streams/events/feed.ics?tz=Europe/Paris', { token: null });
  assert.equal(r.status, 200);
  assert.match(r.headers.get('content-type'), /^text\/calendar/);
  const ics = r.text;
  assert.ok(ics.startsWith('BEGIN:VCALENDAR\r\n'));
  assert.ok(ics.endsWith('END:VCALENDAR\r\n'));
  assert.equal((ics.match(/BEGIN:VEVENT/g) || []).length, 5); // 5 published, the draft is excluded
  assert.ok(!ics.includes('secret'));
  assert.match(ics, /SUMMARY:London meetup\r\nDESCRIPTION|SUMMARY:London meetup\r\nLOCATION/);
  assert.match(ics, /DTSTART:20261201T180000Z\r\nDTEND:20261201T210000Z/);
  assert.match(ics, /LOCATION:Shoreditch\\, London/); // comma escaped
  assert.match(ics, /GEO:51.5074;-0.1278/);
  // All-day: dates in the requested time zone, DTEND exclusive
  assert.match(ics, /DTSTART;VALUE=DATE:20261210\r\nDTEND;VALUE=DATE:20261212/);
  assert.match(ics, /UID:[0-9a-f-]+@cms\.example\.com/);
  for (const line of ics.split('\r\n')) assert.ok(Buffer.byteLength(line) <= 75, `line too long: ${line}`);
  assert.equal((await call('/api/streams/events/feed.ics?tz=Mars/Base')).status, 400);
  assert.equal((await call('/api/streams/events/feed.ics?start=nope')).status, 400);
});

test('RSS and JSON Feed', async () => {
  await call('/api/streams', { method: 'POST', json: { name: 'Blog', template: 'blog-posts' } });
  await call('/api/streams/blog/items', {
    method: 'POST',
    json: { data: { title: 'Tips & <tricks>', excerpt: 'Short "summary"', body: '# Head\n\nSome **bold** [link](https://x.y)', tags: ['news'] }, publish: true },
  });
  await call('/api/streams/blog/items', { method: 'POST', json: { data: { title: 'Unpublished' } } });

  const rss = await call('/api/streams/blog/feed.rss?link=https://www.example.com/blog/{slug}&site=https://www.example.com', { token: null });
  assert.match(rss.headers.get('content-type'), /application\/rss\+xml/);
  assert.match(rss.text, /<title>Tips &amp; &lt;tricks&gt;<\/title>/);
  assert.match(rss.text, /<link>https:\/\/www\.example\.com\/blog\/tips-tricks<\/link>/);
  assert.match(rss.text, /<description>Short &quot;summary&quot;<\/description>/);
  assert.match(rss.text, /<category>news<\/category>/);
  assert.match(rss.text, /<atom:link href="https:\/\/cms\.example\.com\/api\/streams\/blog\/feed\.rss"/);
  assert.ok(!rss.text.includes('Unpublished'));
  assert.equal((await call('/api/streams/blog/feed.rss?link=javascript:alert(1)')).status, 400);

  const json = (await call('/api/streams/blog/feed.json', { token: null })).data;
  assert.equal(json.version, 'https://jsonfeed.org/version/1.1');
  assert.equal(json.items.length, 1);
  assert.equal(json.items[0].content_text, 'Head\n\nSome bold link');
  assert.deepEqual(json.items[0].tags, ['news']);
  assert.equal(json.items[0].url, `https://cms.example.com/api/streams/blog/items/${json.items[0].id}`);
});

test('GeoJSON and CSV', async () => {
  const geo = (await call('/api/streams/events/feed.geojson', { token: null })).data;
  assert.equal(geo.type, 'FeatureCollection');
  const london = geo.features.find((f) => f.properties.title === 'London meetup');
  assert.deepEqual(london.geometry, { type: 'Point', coordinates: [-0.1278, 51.5074] }); // [lng, lat]
  assert.equal(london.properties.label, 'London');
  assert.equal(geo.features.length, 4); // 'With poster' has no pin
  const near = (await call('/api/streams/events/feed.geojson?filter[location][near]=48.85,2.35,10', { token: null })).data;
  assert.deepEqual(near.features.map((f) => f.properties.title), ['Paris conference']);

  await call('/api/streams', { method: 'POST', json: { name: 'Sheet', fields: [{ name: 'name', type: 'string' }, { name: 'n', type: 'number' }, { name: 'tags', type: 'tags' }] } });
  await call('/api/streams/sheet/items', { method: 'POST', json: { data: { name: '=HYPERLINK("evil")', n: -5, tags: ['a', 'b'] } } });
  await call('/api/streams/sheet/items', { method: 'POST', json: { data: { name: 'Say "hi", ok', n: 2 } } });
  const csv = await call('/api/streams/sheet/items.csv?sort=seq', { token: null });
  assert.match(csv.headers.get('content-disposition'), /attachment; filename="sheet.csv"/);
  const lines = csv.text.replace(/^﻿/, '').trimEnd().split('\r\n');
  assert.equal(lines[0], 'id,seq,timestamp,name,n,tags');
  assert.match(lines[1], /,"'=HYPERLINK\(""evil""\)",-5,a; b$/); // formula neutralised, negative number untouched
  assert.match(lines[2], /,"Say ""hi"", ok",2,$/);

  assert.equal((await call('/api/streams/events/toString', { token: null })).status, 404);
});

test('markdownToText', () => {
  assert.equal(markdownToText('## Title\n\n* one\n* two\n\n> quote with `code` and ![alt](x.png)'), 'Title\n\n• one\n• two\n\nquote with code and alt');
});
