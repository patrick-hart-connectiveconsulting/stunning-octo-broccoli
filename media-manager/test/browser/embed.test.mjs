// Browser tests for the admin "Embed" tab (optional: needs Playwright).
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

const TOKEN = 'embed-token';
let dir;
let app;
let base;
let browser;
let page;
const errors = [];

before(async () => {
  dir = await mkdtemp(join(tmpdir(), 'embed-'));
  app = await createApp({ dataDir: dir, token: TOKEN, cors: 'https://www.example.com', publicUrl: 'https://cms.example.com' });
  await new Promise((r) => app.server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${app.server.address().port}`;
  await promisify(execFile)(process.execPath, [join(here, '..', '..', 'scripts', 'seed-demo.js'), `--url=${base}`, `--token=${TOKEN}`]);
  browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  await ctx.addInitScript((t) => localStorage.setItem('mm-token', t), TOKEN);
  page = await ctx.newPage();
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => { if (/Content Security Policy|Refused to/i.test(m.text())) errors.push(`CSP: ${m.text()}`); });
  page.on('request', (r) => { if (/access_token=/.test(r.url())) errors.push(`token in URL: ${r.url()}`); });
  await page.route('https://tile.openstreetmap.org/**', (route) => route.abort());
});

after(async () => {
  await browser?.close();
  app?.close();
  await rm(dir, { recursive: true, force: true });
});

const code = () => page.textContent('.embed-code');
const open = async (slug) => {
  await page.goto(`${base}/streams.html?stream=${slug}&tab=embed`);
  await page.waitForSelector('.embed-choice[aria-checked=true]');
};

test('recommends a component per stream and disables impossible ones', async () => {
  await open('demo-events');
  assert.equal(await page.textContent('.embed-choice[aria-checked=true] strong'), 'Calendar');
  await page.waitForFunction(() => document.querySelector('.embed-preview stream-calendar')?.shadowRoot?.querySelector('.sui-ev'));
  await open('demo-blog');
  assert.equal(await page.textContent('.embed-choice[aria-checked=true] strong'), 'Cards');
  assert.equal(await page.isDisabled('.embed-choice:has-text("Map")'), true);
  await open('demo-announcements');
  assert.equal(await page.textContent('.embed-choice[aria-checked=true] strong'), 'Banner');
  await open('demo-locations');
  assert.equal(await page.textContent('.embed-choice[aria-checked=true] strong'), 'Map');
});

test('the code uses the public URL and follows the options', async () => {
  await open('demo-events');
  let c = await code();
  assert.match(c, /<script type="module" src="https:\/\/cms\.example\.com\/ui\/streams-ui\.js"><\/script>/);
  assert.match(c, /src="https:\/\/cms\.example\.com\/api\/streams\/demo-events"/);
  assert.match(c, /\n {2}live\n/);

  await page.click('.embed-choice:has-text("Table")');
  for (const f of ['title', 'start', 'venue']) await page.check(`.embed-chips .chip:has-text("${f}") input`);
  await page.locator('input[type=color]').evaluate((el) => { el.value = '#12b886'; el.dispatchEvent(new Event('input', { bubbles: true })); });
  await page.fill('.embed-options input[placeholder="/events/{slug}"]', '/events/{slug}');
  c = await code();
  assert.match(c, /columns="title,start,venue"/);
  assert.match(c, /style="--sui-accent: #12b886"/);
  assert.match(c, /link="\/events\/\{slug\}"/);
  await page.waitForFunction(() => document.querySelectorAll('.embed-preview stream-table')[0]?.shadowRoot?.querySelectorAll('thead th').length === 3);

  // Attribute values are escaped in the code.
  await page.fill('.embed-options input[placeholder="/events/{slug}"]', '/x?a="b"&c');
  assert.match(await code(), /link="\/x\?a=&quot;b&quot;&amp;c"/);
});

test('single item: fixed item or from the page address', async () => {
  await open('demo-blog');
  await page.click('.embed-choice:has-text("Single item")');
  await page.waitForFunction(() => document.querySelector('.embed-preview stream-item')?.shadowRoot?.querySelector('.sui-content'));
  assert.match(await code(), /slug="[a-z0-9-]+"/);
  await page.selectOption('.embed-source select >> nth=0', 'path');
  await page.waitForTimeout(400);
  assert.match(await code(), /\n {2}slug-from-path\n/);
  // The preview still shows an item (the newest).
  await page.waitForFunction(() => document.querySelector('.embed-preview stream-item')?.shadowRoot?.querySelector('.sui-content'));
});

test('copy button and CORS note; no page errors', async () => {
  await open('demo-events');
  assert.match(await page.textContent('.embed-output'), /https:\/\/www\.example\.com/);
  await page.context().grantPermissions(['clipboard-read', 'clipboard-write']);
  await page.click('#copyEmbed');
  const clip = await page.evaluate(() => navigator.clipboard.readText());
  assert.equal(clip, await code());
  assert.deepEqual(errors, []);
});

test('admin live view works with the token in a header (never in a URL), under the page CSP', async () => {
  await page.goto(`${base}/streams.html?stream=demo-blog`);
  await page.waitForSelector('#liveDot.on');
  const before = await page.locator('#eventsBody tr').count();
  // A draft is only visible to editors: it appears only if the live feed is authenticated.
  await fetch(`${base}/api/streams/demo-blog/items`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ data: { title: 'Live draft via header', body: 'x' } }),
  });
  await page.waitForFunction((n) => document.querySelectorAll('#eventsBody tr').length === n + 1, before, { timeout: 5000 });
  assert.match(await page.textContent('#eventsBody'), /Live draft via header/);
  // Media Library page loads cleanly under its CSP too.
  await page.goto(`${base}/`);
  await page.waitForSelector('#summary:not(:empty)');
  assert.deepEqual(errors, []);
});

test('a component with a read key gets live drafts without the key in the URL', async () => {
  const { key } = await fetch(`${base}/api/streams/demo-blog/keys`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'Preview', scopes: ['read'] }),
  }).then((r) => r.json());
  await page.goto(`${base}/ui/demo.html`);
  await page.evaluate((k) => {
    const el = document.createElement('stream-list');
    el.id = 'preview';
    el.setAttribute('src', '/api/streams/demo-blog');
    el.setAttribute('filter', 'status=all');
    el.setAttribute('key', k);
    el.setAttribute('live', '');
    el.setAttribute('limit', '50');
    document.body.prepend(el);
  }, key);
  await page.waitForFunction(() => document.querySelector('#preview').shadowRoot?.querySelector('.sui-item'));
  await new Promise((r) => setTimeout(r, 300));
  await fetch(`${base}/api/streams/demo-blog/items`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ data: { title: 'Second live draft' } }),
  });
  await page.waitForFunction(() => document.querySelector('#preview').shadowRoot.textContent.includes('Second live draft'), null, { timeout: 5000 });
  assert.deepEqual(errors.filter((e) => e.startsWith('token in URL')), []);
});
