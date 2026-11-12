// Unit tests for the component library's pure helpers (public/ui/core.js).
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  renderMarkdown, markdownToText, escapeHtml, safeUrl, fieldRoles, monthGrid, weekDays, eventDays,
  fillPattern, jsonLdFor, truncate, toDate, dayKey, getPath, mergeQuery,
} from '../public/ui/core.js';

test('renderMarkdown renders the supported subset', () => {
  const html = renderMarkdown('# Title\n\nSome **bold**, _em_, `code` and ~~old~~ text.\n\n- one\n- two\n\n1. first\n\n> quote\n\n---\n\n```\n<b>raw</b>\n```');
  assert.match(html, /<h1>Title<\/h1>/);
  assert.match(html, /<strong>bold<\/strong>, <em>em<\/em>, <code>code<\/code> and <del>old<\/del>/);
  assert.match(html, /<ul><li>one<\/li><li>two<\/li><\/ul>/);
  assert.match(html, /<ol><li>first<\/li><\/ol>/);
  assert.match(html, /<blockquote><p>quote<\/p><\/blockquote>/);
  assert.match(html, /<hr>/);
  assert.match(html, /<pre><code>&lt;b&gt;raw&lt;\/b&gt;<\/code><\/pre>/);
  assert.equal(renderMarkdown('snake_case_name stays'), '<p>snake_case_name stays</p>');
});

test('renderMarkdown never lets HTML or script URLs through', () => {
  const attacks = [
    '<script>alert(1)</script>',
    '<img src=x onerror=alert(1)>',
    '[click](javascript:alert(1))',
    '[click](JaVaScRiPt:alert(1))',
    '[click](data:text/html;base64,PHNjcmlwdD4=)',
    '![x](javascript:alert(1))',
    '![x](data:image/svg+xml,<svg onload=alert(1)>)',
    '[x](vbscript:msgbox(1))',
    '"><svg onload=alert(1)>',
    '[x](https://ok.example/"onmouseover="alert(1))',
  ];
  for (const a of attacks) {
    const html = renderMarkdown(a);
    // No real tags other than the safe ones, no event-handler attributes inside a tag, no script URLs.
    assert.ok(!/<(script|svg|iframe|object)/i.test(html), `${a} -> ${html}`);
    assert.ok(!/<[^>]*\son\w+\s*=/i.test(html), `${a} -> ${html}`);
    assert.ok(!/(href|src)="\s*(javascript|data|vbscript):/i.test(html), `${a} -> ${html}`);
  }
  assert.match(renderMarkdown('[ok](https://example.com)'), /<a href="https:\/\/example.com" rel="noopener noreferrer" target="_blank">ok<\/a>/);
  assert.match(renderMarkdown('[rel](/blog/x)'), /<a href="\/blog\/x">rel<\/a>/);
  assert.match(renderMarkdown('[mail](mailto:a@b.co)'), /href="mailto:a@b.co"/);
});

test('escapeHtml, safeUrl, truncate, markdownToText', () => {
  assert.equal(escapeHtml(`<a href="x">'&'</a>`), '&lt;a href=&quot;x&quot;&gt;&#39;&amp;&#39;&lt;/a&gt;');
  assert.equal(safeUrl('javascript:alert(1)'), '#');
  assert.equal(safeUrl(' https://x.y/a '), 'https://x.y/a');
  assert.equal(safeUrl('tel:+441234'), 'tel:+441234');
  assert.equal(safeUrl('tel:+441234', { image: true }), '#');
  assert.equal(truncate('one two three four', 12), 'one two…');
  assert.equal(markdownToText('## Hi\n\n**Bold** [link](x)\n- item'), 'Hi Bold link item');
});

test('fieldRoles detects common field names and honours overrides', () => {
  const fields = [
    { name: 'title', type: 'string' }, { name: 'slug', type: 'uid' }, { name: 'excerpt', type: 'text' },
    { name: 'body', type: 'richtext' }, { name: 'startDate', type: 'datetime' }, { name: 'endDate', type: 'datetime' },
    { name: 'allDay', type: 'boolean' }, { name: 'cover', type: 'media' }, { name: 'where', type: 'geopoint' },
    { name: 'tags', type: 'tags' }, { name: 'headline', type: 'string' },
  ];
  const r = fieldRoles(fields);
  assert.deepEqual([r.title.name, r.description.name, r.body.name, r.start.name, r.end.name, r.allDay.name, r.image.name, r.location.name, r.slug.name, r.tags.name],
    ['title', 'excerpt', 'body', 'startDate', 'endDate', 'allDay', 'cover', 'where', 'slug', 'tags']);
  assert.equal(fieldRoles(fields, { title: 'headline' }).title.name, 'headline');
  assert.equal(fieldRoles([{ name: 'quote', type: 'text' }, { name: 'name', type: 'string' }]).title.name, 'name');
});

test('calendar maths', () => {
  // November 2026 starts on a Sunday.
  const sundayFirst = monthGrid(2026, 10, 0);
  assert.equal(sundayFirst.length, 35);
  assert.equal(dayKey(sundayFirst[0]), '2026-11-01');
  const mondayFirst = monthGrid(2026, 10, 1);
  assert.equal(dayKey(mondayFirst[0]), '2026-10-26');
  assert.equal(mondayFirst.length % 7, 0);
  assert.equal(dayKey(weekDays(new Date(2026, 10, 12), 1)[0]), '2026-11-09');

  const span = (s, e) => eventDays(s, e).map(dayKey);
  assert.deepEqual(span('2026-12-01', '2026-12-03'), ['2026-12-01', '2026-12-03']); // date-only: inclusive
  const local = (y, m, d, h = 0) => new Date(y, m, d, h).toISOString();
  assert.deepEqual(span(local(2026, 11, 1, 22), local(2026, 11, 2, 0)), ['2026-12-01', '2026-12-01']); // ends at midnight
  assert.deepEqual(span(local(2026, 11, 1, 9), local(2026, 11, 3, 17)), ['2026-12-01', '2026-12-03']);
  assert.deepEqual(span(local(2026, 11, 5, 9), null), ['2026-12-05', '2026-12-05']);
  assert.equal(toDate('2026-02-01').getDate(), 1); // date-only is local, not UTC
});

test('fillPattern, getPath, mergeQuery', () => {
  const roles = { slug: { name: 'slug' } };
  const item = { id: 'abc', seq: 7, data: { slug: 'hello world', author: { id: 'p1' } } };
  assert.equal(fillPattern('/blog/{slug}?n={seq}&a={author}&i={id}', item, roles), '/blog/hello%20world?n=7&a=p1&i=abc');
  assert.equal(getPath({ a: { b: [1, { c: 'x' }] } }, 'a.b.1.c'), 'x');
  assert.equal(mergeQuery(new URLSearchParams('a=1'), '?filter[tags]=news&b=2').toString(), 'a=1&filter%5Btags%5D=news&b=2');
});

test('jsonLdFor builds schema.org objects', () => {
  const stream = { schemaType: 'Event', fields: [] };
  const roles = fieldRoles([{ name: 'title', type: 'string' }, { name: 'start', type: 'datetime' }, { name: 'venue', type: 'string' }, { name: 'location', type: 'geopoint' }]);
  const ld = jsonLdFor({ id: '1', seq: 1, data: { title: 'Meetup', start: '2026-12-01T18:00:00Z', venue: 'Hub', location: { lat: 1, lng: 2 } } }, stream, roles, { link: 'https://x/e/1' });
  assert.deepEqual(ld, {
    '@context': 'https://schema.org', '@type': 'Event', name: 'Meetup', url: 'https://x/e/1', startDate: '2026-12-01T18:00:00Z',
    location: { '@type': 'Place', name: 'Hub', geo: { '@type': 'GeoCoordinates', latitude: 1, longitude: 2 } },
  });
  const faqRoles = fieldRoles([{ name: 'question', type: 'string' }, { name: 'answer', type: 'richtext' }]);
  const q = jsonLdFor({ data: { question: 'Why?', answer: '**Because**' } }, { schemaType: 'Question' }, faqRoles);
  assert.deepEqual(q.acceptedAnswer, { '@type': 'Answer', text: 'Because' });
  assert.equal(jsonLdFor({ data: {} }, { schemaType: null }, roles), null);
});
