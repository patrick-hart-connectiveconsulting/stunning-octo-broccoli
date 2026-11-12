#!/usr/bin/env node
// Fills a running Media Manager with demo streams for the component library.
//
//   npm run seed:demo                       (server at http://localhost:1338, token dev-token)
//   npm run seed:demo -- --url=http://localhost:4100 --token=my-token
//   npm run seed:demo -- --reset            (delete the demo streams first)
//
// Dates are relative to today, so the calendar always has something to show.

import { readFile, access } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const args = Object.fromEntries(process.argv.slice(2).map((a) => {
  const m = /^--([a-z-]+)(?:=(.*))?$/.exec(a);
  if (!m) {
    console.error(`Unknown argument "${a}". Use --url=, --token= or --reset.`);
    process.exit(1);
  }
  return [m[1], m[2] ?? true];
}));
const BASE = String(args.url || 'http://localhost:1338').replace(/\/+$/, '');
const TOKEN = args.token || process.env.MEDIA_API_TOKEN || 'dev-token';
const IMAGES = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'data', 'uploads'); // sample photos from the repository

async function api(path, { method = 'GET', json, body, ok = [200, 201] } = {}) {
  const headers = { Authorization: `Bearer ${TOKEN}` };
  if (json !== undefined) headers['Content-Type'] = 'application/json';
  let res;
  try {
    res = await fetch(BASE + path, { method, headers, body: json !== undefined ? JSON.stringify(json) : body });
  } catch {
    console.error(`Cannot reach ${BASE}. Start the server first (npm run start:local).`);
    process.exit(1);
  }
  const data = await res.json().catch(() => null);
  if (!ok.includes(res.status)) {
    const msg = data?.error?.message || res.statusText;
    const detail = data?.error?.details?.errors?.map((e) => `${e.path} ${e.message}`).join('; ');
    throw new Error(`${method} ${path} → ${res.status} ${msg}${detail ? ` (${detail})` : ''}`);
  }
  return { status: res.status, data };
}

async function upload(file, alt) {
  const path = join(IMAGES, file);
  try {
    await access(path);
  } catch {
    return null;
  }
  const fd = new FormData();
  fd.append('files', new Blob([await readFile(path)], { type: 'image/jpeg' }), file);
  fd.append('fileInfo', JSON.stringify({ alternativeText: alt }));
  const { data } = await api('/api/upload', { method: 'POST', body: fd });
  return data[0].id;
}

const day = (offset, hour = null, minute = 0) => {
  const d = new Date();
  d.setDate(d.getDate() + offset);
  if (hour === null) return d.toISOString().slice(0, 10);
  d.setHours(hour, minute, 0, 0);
  return d.toISOString();
};

const STREAMS = ['demo-events', 'demo-blog', 'demo-team', 'demo-faq', 'demo-testimonials', 'demo-locations', 'demo-announcements'];

async function main() {
  const health = await api('/api/health').catch(() => null);
  if (!health) process.exit(1);

  if (args.reset) {
    for (const slug of [...STREAMS].reverse()) {
      const r = await api(`/api/streams/${slug}`, { method: 'DELETE', ok: [200, 404] });
      if (r.status === 200) console.log(`Deleted ${slug}`);
    }
  }

  const existing = new Set((await api('/api/streams?pageSize=500')).data.data.map((s) => s.slug));
  const make = async (slug, name, template, extra = {}) => {
    if (existing.has(slug)) {
      console.log(`Skipped ${slug}: it exists already (use --reset to recreate it)`);
      return false;
    }
    await api('/api/streams', { method: 'POST', json: { name, slug, template, ...extra } });
    console.log(`Created ${slug}`);
    return true;
  };
  const add = (slug, items) => api(`/api/streams/${slug}/items`, {
    method: 'POST',
    json: items.map(({ _timestamp, ...data }) => ({ data, publish: true, ...(_timestamp ? { timestamp: _timestamp } : {}) })),
  });

  const img = {
    mountains: await upload('beautiful-picture.jpg', 'Mountains at dusk above a lake'),
    coffee: await upload('coffee-art.jpg', 'Latte art in a white cup'),
    beans: await upload('coffee-beans.jpg', 'Roasted coffee beans'),
    pizza: await upload('we-love-pizza.jpg', 'A pizza on a wooden table'),
    shadow: await upload('coffee-shadow.jpg', 'Coffee cup with a long shadow'),
    space: await upload('what-s-inside-a-black-hole.jpg', 'Illustration of a black hole'),
    david: await upload('daviddoe@strapi.io.jpg', 'Portrait of David Doe'),
    sarah: await upload('sarahbaker@strapi.io.jpg', 'Portrait of Sarah Baker'),
  };
  if (!img.mountains) console.log(`Note: sample photos not found in ${IMAGES}; items are created without images.`);

  if (await make('demo-events', 'Demo events', 'events', { description: 'Meetups, workshops and conferences' })) {
    await add('demo-events', [
      { title: 'Design systems meetup', start: day(2, 18, 30), end: day(2, 21), venue: 'The Hub, London', location: { lat: 51.5246, lng: -0.0794, label: 'Shoreditch, London' }, description: 'Talks and drinks about **design tokens** and component libraries.', image: img.mountains, url: 'https://example.com/tickets/1', tags: ['meetup', 'design'], status: 'scheduled' },
      { title: 'Coffee & code', start: day(4, 8), end: day(4, 9, 30), venue: 'Bean There Café, Paris', location: { lat: 48.8606, lng: 2.3376, label: 'Paris' }, description: 'An early-morning pairing session.', image: img.coffee, tags: ['community'] },
      { title: 'Company holiday', start: day(6, 0), end: day(6, 23), allDay: true, description: 'The office is closed.', tags: ['company'] },
      { title: 'Web performance workshop', start: day(9, 9), end: day(10, 17), venue: 'Tech Campus, Berlin', location: { lat: 52.5076, lng: 13.3904, label: 'Berlin' }, description: 'Two days of hands-on profiling.', image: img.space, url: 'https://example.com/tickets/2', tags: ['workshop', 'performance'] },
      { title: 'Product launch livestream', start: day(13, 17), end: day(13, 18), description: 'Watch the launch online.', tags: ['company', 'online'] },
      { title: 'Pizza Friday', start: day(16, 12), end: day(16, 13, 30), venue: 'Napoli Kitchen, Naples', location: { lat: 40.8518, lng: 14.2681, label: 'Naples' }, image: img.pizza, tags: ['community'] },
      { title: 'Accessibility clinic', start: day(20, 14), end: day(20, 16), venue: 'Online', description: 'Bring your site; we test it with a screen reader.', tags: ['online', 'design'] },
      { title: 'Engineering offsite', start: day(27, 9), end: day(29, 16), venue: 'Lakeside Lodge, Geneva', location: { lat: 46.2044, lng: 6.1432, label: 'Geneva' }, image: img.mountains, tags: ['company'] },
      { title: 'Past: retrospective', start: day(-3, 15), end: day(-3, 16), venue: 'Office', tags: ['company'] },
      { title: 'Annual conference', start: day(38, 9), end: day(39, 18), venue: 'Convention Centre, Lisbon', location: { lat: 38.7684, lng: -9.0940, label: 'Lisbon' }, description: 'Our biggest event of the year.', image: img.space, url: 'https://example.com/conf', tags: ['conference'] },
    ]);
  }

  if (await make('demo-blog', 'Demo blog', 'blog-posts')) {
    const post = (title, days, excerpt, tags, cover, featured = false) => ({ _timestamp: day(days, 10), title, excerpt, tags, cover, featured, author: featured ? 'Sarah Baker' : 'David Doe',
      body: `${excerpt}\n\n## Why it matters\n\nStreams turn **structured content** into feeds, calendars and pages. Read the [spec](https://example.com/spec).\n\n- Fast to set up\n- Works on any site\n- Styles are yours\n\n> Good content deserves good presentation.` });
    const posts = [
      post('Introducing the streams component library', -1, 'Drop a script tag on your site and turn any stream into a list, calendar or map.', ['news', 'product'], img.mountains, true),
      post('Five ways to style a calendar', -4, 'CSS variables, parts, templates and more: a tour of the styling options.', ['design', 'how-to'], img.coffee),
      post('Maps without the headache', -8, 'Every location field becomes a pin. Here is how the map component works.', ['product', 'maps'], img.space),
      post('What we learned running 40 meetups', -15, 'Lessons from three years of community events.', ['community'], img.pizza),
      post('Coffee, code and content models', -22, 'How we think about structured content at our team breakfasts.', ['culture'], img.beans),
      post('Release notes: November', -30, 'Relations, API keys and scheduled publishing.', ['news', 'release'], img.shadow),
    ];
    await add('demo-blog', posts);
  }

  if (await make('demo-team', 'Demo team', 'people')) {
    await add('demo-team', [
      { name: 'Sarah Baker', jobTitle: 'Head of Product', photo: img.sarah, bio: 'Sarah leads product and loves **well-structured content**.', email: 'sarah@example.com', order: 1 },
      { name: 'David Doe', jobTitle: 'Lead Engineer', photo: img.david, bio: 'David builds the streams engine and the component library.', url: 'https://example.com/david', order: 2 },
      { name: 'Ada Park', jobTitle: 'Designer', bio: 'Ada designs the components and their default styles.', order: 3 },
    ]);
  }

  if (await make('demo-faq', 'Demo FAQ', 'faq')) {
    await add('demo-faq', [
      { question: 'Do I need a build step?', answer: 'No. Add one `<script type="module">` tag and use the elements.', category: 'Getting started', order: 1 },
      { question: 'Can I use my own styles?', answer: 'Yes: CSS variables, `::part()`, the `unstyled` attribute, or your own `<template>`.', category: 'Styling', order: 2 },
      { question: 'Does it work with React or WordPress?', answer: 'Yes. Custom elements work in any HTML page or framework.', category: 'Getting started', order: 3 },
    ]);
  }

  if (await make('demo-testimonials', 'Demo testimonials', 'testimonials')) {
    await add('demo-testimonials', [
      { quote: 'We replaced three plugins with one script tag.', name: 'Maria Lopez', role: 'Web lead', company: 'Northwind', rating: 5 },
      { quote: 'Our events calendar finally updates itself.', name: 'Tom Becker', role: 'Marketing manager', company: 'Contoso', rating: 5, photo: img.david },
      { quote: 'The map component saved us a week of work.', name: 'Priya Shah', role: 'Developer', company: 'Fabrikam', rating: 4, photo: img.sarah },
    ]);
  }

  if (await make('demo-locations', 'Demo locations', 'locations')) {
    await add('demo-locations', [
      { name: 'London office', address: '1 Example Street, London', location: { lat: 51.5155, lng: -0.0922, label: 'London office' }, phone: '+44 20 0000 0000', openingHours: 'Mo-Fr 09:00-17:30' },
      { name: 'Berlin office', address: 'Beispielstraße 2, Berlin', location: { lat: 52.52, lng: 13.405, label: 'Berlin office' }, openingHours: 'Mo-Fr 09:00-18:00' },
      { name: 'Lisbon studio', address: 'Rua Exemplo 3, Lisbon', location: { lat: 38.7223, lng: -9.1393, label: 'Lisbon studio' }, image: img.coffee },
    ]);
  }

  if (await make('demo-announcements', 'Demo announcements', 'announcements')) {
    await add('demo-announcements', [
      { message: 'Tickets for the annual conference are now on sale.', level: 'info', url: 'https://example.com/conf', linkText: 'Get tickets' },
      { message: 'Scheduled maintenance on Saturday from 22:00 UTC.', level: 'warning' },
    ]);
  }

  console.log(`\nDone. Open ${BASE}/ui/demo.html to see every component.`);
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
