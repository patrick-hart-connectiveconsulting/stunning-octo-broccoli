// Browser tests for the component library (optional: needs Playwright).
//
//   npm run test:browser
//
// Starts its own server on a free port with a temporary data folder, fills it
// with the demo streams, then checks every component in Chromium.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createApp } from '../../src/server.js';

const here = dirname(fileURLToPath(import.meta.url));
let chromium;
try {
  ({ chromium } = createRequire(import.meta.url)('playwright'));
} catch {
  console.error('Playwright is not installed. To run the browser tests:\n  npm install --no-save playwright\n  npx playwright install chromium');
  process.exit(1);
}

const TOKEN = 'browser-token';
let dir;
let app;
let base;
let browser;
let page;
const errors = [];

before(async () => {
  dir = await mkdtemp(join(tmpdir(), 'ui-'));
  app = await createApp({ dataDir: dir, token: TOKEN });
  await new Promise((r) => app.server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${app.server.address().port}`;
  await promisify(execFile)(process.execPath, [join(here, '..', '..', 'scripts', 'seed-demo.js'), `--url=${base}`, `--token=${TOKEN}`]);
  browser = await chromium.launch();
  page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  page.on('pageerror', (e) => errors.push(e.message));
  // Map tiles come from the internet; don't let them slow the tests down.
  await page.route('https://tile.openstreetmap.org/**', (route) => route.abort());
  await page.goto(`${base}/ui/demo.html`);
  await page.waitForFunction(() => document.querySelector('#calendar stream-calendar')?.shadowRoot?.querySelector('.sui-day'));
});

after(async () => {
  await browser?.close();
  app?.close();
  await rm(dir, { recursive: true, force: true });
});

/** Runs a function against the shadow root (or light DOM) of the first matching element. */
const inEl = (selector, fn, arg) => page.evaluate(({ selector, fn, arg }) => {
  const el = document.querySelector(selector);
  const root = el.shadowRoot || el;
  // eslint-disable-next-line no-new-func
  return new Function('root', 'el', 'arg', `return (${fn})(root, el, arg)`)(root, el, arg);
}, { selector, fn: fn.toString(), arg });

const waitIn = (selector, inner, timeout = 5000) => page.waitForFunction(({ selector, inner }) => {
  const el = document.querySelector(selector);
  return (el?.shadowRoot || el)?.querySelector(inner);
}, { selector, inner }, { timeout });

test('every demo renders without page errors', async () => {
  const empty = await page.evaluate(() => [...document.querySelectorAll('.live *')]
    .filter((e) => e.localName.startsWith('stream-'))
    .filter((e) => (e.shadowRoot || e).querySelector('.sui-message.sui-error, .sui-message.sui-loading'))
    .map((e) => e.localName));
  assert.deepEqual(empty, []);
  assert.deepEqual(errors, []);
});

test('list: items, links from the pattern, load more', async () => {
  const sel = '#list stream-list';
  const first = await inEl(sel, (r) => ({ n: r.querySelectorAll('.sui-item').length, href: r.querySelector('.sui-title a').getAttribute('href') }));
  assert.equal(first.n, 3);
  assert.match(first.href, /^\/blog\/[a-z0-9-]+$/);
  await inEl(sel, (r) => r.querySelector('.sui-more').click());
  await page.waitForFunction((s) => document.querySelector(s).shadowRoot.querySelectorAll('.sui-item').length === 6, sel);
  assert.equal(await inEl(sel, (r) => Boolean(r.querySelector('.sui-more'))), false); // all 6 loaded
});

test('filter chips narrow the target list', async () => {
  const before = await inEl('#filtered-posts', (r) => r.querySelectorAll('.sui-item').length);
  await inEl('#filter stream-filter', (r) => [...r.querySelectorAll('button')].find((b) => b.textContent === 'community').click());
  await page.waitForFunction(() => document.querySelector('#filtered-posts').shadowRoot.querySelectorAll('.sui-item').length === 1);
  assert.ok(before > 1);
  assert.equal(await page.evaluate(() => document.querySelector('#filtered-posts').getAttribute('filter')), 'filter%5Btags%5D=community');
  await inEl('#filter stream-filter', (r) => r.querySelector('button').click()); // "All"
  await page.waitForFunction((n) => document.querySelector('#filtered-posts').shadowRoot.querySelectorAll('.sui-item').length === n, before);
});

test('calendar: navigation, views, popup', async () => {
  const sel = '#calendar stream-calendar';
  const title0 = await inEl(sel, (r) => r.querySelector('.sui-cal-title').textContent);
  const now = new Date();
  assert.equal(title0, new Intl.DateTimeFormat(undefined, { month: 'long', year: 'numeric' }).format(now));
  assert.ok(await inEl(sel, (r) => r.querySelectorAll('.sui-ev').length) >= 3);

  await inEl(sel, (r) => r.querySelector('[part~="next"]').click());
  await page.waitForFunction(({ s, t }) => document.querySelector(s).shadowRoot.querySelector('.sui-cal-title').textContent !== t, { s: sel, t: title0 });
  await inEl(sel, (r) => [...r.querySelectorAll('[part~="view"]')].find((b) => b.textContent === 'Agenda').click());
  await waitIn(sel, '.sui-agenda, .sui-message');
  await inEl(sel, (r) => r.querySelector('[part~="today"]').click());
  await waitIn(sel, '.sui-agenda-item');
  await inEl(sel, (r) => r.querySelector('.sui-agenda-item').click());
  assert.equal(await inEl(sel, (r) => r.querySelector('dialog').open), true);
  assert.ok((await inEl(sel, (r) => r.querySelector('dialog h3').textContent)).length > 0);
  await inEl(sel, (r) => r.querySelector('.sui-pop-close').click());
  await inEl(sel, (r) => [...r.querySelectorAll('[part~="view"]')].find((b) => b.textContent === 'Month').click());
  await waitIn(sel, '.sui-day');
});

test('calendar switches to agenda on a narrow screen', async () => {
  await page.setViewportSize({ width: 420, height: 900 });
  await waitIn('#calendar stream-calendar', '.sui-agenda, .sui-message.sui-empty');
  assert.equal(await inEl('#calendar stream-calendar', (r) => Boolean(r.querySelector('.sui-cal-grid'))), false);
  await page.setViewportSize({ width: 1280, height: 900 });
  await waitIn('#calendar stream-calendar', '.sui-cal-grid');
});

test('table sorts and searches; carousel moves; gallery opens a lightbox', async () => {
  const t = '#table stream-table';
  const titles = () => inEl(t, (r) => [...r.querySelectorAll('tbody tr td:first-child')].map((td) => td.textContent));
  const original = await titles();
  await inEl(t, (r) => r.querySelector('th button').click());
  const sorted = await titles();
  assert.deepEqual(sorted, [...original].sort((a, b) => a.localeCompare(b, undefined, { numeric: true })));
  await page.locator(t).locator('input.sui-search').fill('pizza');
  assert.deepEqual(await titles(), ['Pizza Friday']);

  const c = '#carousel stream-carousel';
  await inEl(c, (r) => r.querySelector('[part~="next"]').click());
  await page.waitForFunction((s) => document.querySelector(s).shadowRoot.querySelectorAll('.sui-dot')[1]?.getAttribute('aria-current') === 'true', c);

  const g = '#gallery stream-gallery';
  await inEl(g, (r) => r.querySelector('.sui-thumb').click());
  assert.equal(await inEl(g, (r) => r.querySelector('dialog').open), true);
  await page.keyboard.press('ArrowRight');
  assert.match(await inEl(g, (r) => r.querySelector('[part="lightbox-caption"]').textContent), /\(2\/\d+\)/);
  await page.keyboard.press('Escape');
});

test('map shows a pin per located item; next-up shows a countdown', async () => {
  await waitIn('#map stream-map', '.leaflet-marker-icon');
  const pins = await inEl('#map stream-map', (r) => r.querySelectorAll('.leaflet-marker-icon').length);
  assert.equal(pins, 6); // seeded events with a map pin
  assert.equal(await inEl('#next stream-next', (r) => r.querySelectorAll('.sui-unit').length), 4);
});

test('single item renders Markdown and adds JSON-LD', async () => {
  const sel = '#item stream-item';
  assert.equal(await inEl(sel, (r) => r.querySelector('.sui-content h2').textContent), 'Why it matters');
  assert.equal(await inEl(sel, (r) => r.querySelector('.sui-content strong').textContent), 'structured content');
  const ld = JSON.parse(await page.evaluate(() => document.querySelector('#item stream-item > script[type="application/ld+json"]').textContent));
  assert.equal(ld['@type'], 'BlogPosting');
  assert.equal(ld.headline, 'Introducing the streams component library');
  const faq = JSON.parse(await page.evaluate(() => document.querySelector('#faq stream-list > script[type="application/ld+json"]').textContent));
  assert.equal(faq.itemListElement[0].item['@type'], 'Question');
});

test('styling hooks: CSS variables, ::part, unstyled, template, renderItem', async () => {
  const accent = await inEl('#cards stream-cards', (r) => getComputedStyle(r.querySelector('.sui-tag')).color);
  assert.equal(accent, 'rgb(214, 51, 108)'); // --sui-accent: #d6336c
  const partColor = await inEl('#parts stream-list', (r) => getComputedStyle(r.querySelector('[part="date"]')).color);
  assert.equal(partColor, 'rgb(18, 184, 134)'); // ::part(date)
  assert.equal(await page.evaluate(() => Boolean(document.querySelector('#unstyled stream-list').shadowRoot)), false);
  assert.equal(await page.evaluate(() => document.querySelectorAll('#template .team-card').length), 3);
  assert.equal(await page.evaluate(() => document.querySelector('#template .team-card .bio strong')?.textContent), 'well-structured content');
  assert.match(await page.evaluate(() => document.querySelector('#js-list').shadowRoot.textContent), /📍 London office — Mo-Fr 09:00-17:30/);
});

test('live updates and escaping of hostile content', async () => {
  const sel = '#list stream-list';
  // The demo list is not live; make it live, then add a post with hostile content.
  await page.evaluate((s) => document.querySelector(s).setAttribute('live', ''), sel);
  await page.waitForTimeout(300);
  const res = await fetch(`${base}/api/streams/demo-blog/items`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ data: { title: '<img src=x onerror="window.__pwned=1">Live post', body: 'x', excerpt: '<script>window.__pwned=2</script>' }, publish: true, timestamp: new Date(Date.now() + 60000).toISOString() }),
  });
  assert.equal(res.status, 201);
  await page.waitForFunction((s) => document.querySelector(s).shadowRoot.querySelector('.sui-title').textContent.includes('Live post'), sel, { timeout: 5000 });
  assert.equal(await inEl(sel, (r) => r.querySelectorAll('img[onerror]').length), 0);
  assert.equal(await page.evaluate(() => window.__pwned), undefined);
});
