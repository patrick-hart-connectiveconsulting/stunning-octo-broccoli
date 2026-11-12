// Standard output formats for a stream's items: iCalendar, RSS 2.0, JSON Feed,
// GeoJSON and CSV. Pure functions: the caller passes the stream, the (published)
// items and a context with URLs and helpers.

const lower = (s) => s.toLowerCase().replace(/[^a-z]/g, '');

const ROLE_NAMES = {
  title: ['title', 'name', 'headline', 'heading', 'label', 'question', 'subject', 'summary', 'message', 'client'],
  description: ['excerpt', 'summary', 'description', 'abstract', 'answer', 'quote', 'text', 'body', 'content', 'message', 'bio'],
  start: ['start', 'startdate', 'starts', 'startsat', 'starttime', 'begin', 'date', 'eventdate'],
  end: ['end', 'enddate', 'ends', 'endsat', 'endtime', 'finish'],
  allDay: ['allday'],
  venue: ['venue', 'location', 'address', 'place', 'city'],
  url: ['url', 'link', 'website', 'applyurl', 'href', 'registrationurl'],
};
const ROLE_TYPES = {
  title: ['string', 'text', 'uid', 'email'],
  description: ['string', 'text', 'richtext'],
  start: ['datetime', 'date'],
  end: ['datetime', 'date'],
  allDay: ['boolean'],
  venue: ['string', 'text'],
  url: ['url'],
};

/**
 * Works out which field plays which role (title, start date, image…) from
 * common field names, so feeds work without configuration. `overrides` maps a
 * role to a field name, e.g. { start: 'kickoff' }.
 */
export function fieldRoles(stream, overrides = {}) {
  const byName = (name) => stream.fields.find((f) => f.name === name);
  const roles = {};
  for (const role of Object.keys(ROLE_NAMES)) {
    const forced = overrides[role] && byName(overrides[role]);
    roles[role] = forced
      || ROLE_NAMES[role].map((n) => stream.fields.find((f) => lower(f.name) === n && ROLE_TYPES[role].includes(f.type))).find(Boolean)
      || null;
  }
  roles.title ??= stream.fields.find((f) => ['string', 'uid'].includes(f.type)) || null;
  roles.geopoint = (overrides.location && byName(overrides.location)) || stream.fields.find((f) => f.type === 'geopoint') || null;
  roles.image = (overrides.image && byName(overrides.image)) || stream.fields.find((f) => f.type === 'media') || null;
  roles.slug = stream.fields.find((f) => f.type === 'uid') || null;
  roles.tags = stream.fields.find((f) => f.type === 'tags') || null;
  return roles;
}

/** Plain text from Markdown, for feeds and calendar descriptions. */
export function markdownToText(md) {
  return String(md)
    .replace(/```[\s\S]*?```/g, (m) => m.replace(/```\w*\n?/g, ''))
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/^>[ \t]?/gm, '')
    .replace(/^[ \t]*[-*+][ \t]+/gm, '• ')
    .replace(/(\*\*|__)(.*?)\1/g, '$2')
    .replace(/(\*|_)(.*?)\1/g, '$2')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function textOf(item, field) {
  const v = field ? item.data?.[field.name] : null;
  if (v == null || v === '') return '';
  return field.type === 'richtext' ? markdownToText(v) : String(v);
}

/** Title for an item: its title-like field, else "#seq". */
export const titleOf = (item, roles) => textOf(item, roles.title) || `#${item.seq}`;

/**
 * Link for an item. `pattern` may contain {id}, {seq}, {slug} or {<field>},
 * e.g. "https://example.com/blog/{slug}". Without a pattern: the item's URL
 * field, else the item's API URL.
 */
export function linkOf(item, roles, ctx) {
  if (ctx.linkPattern) {
    return ctx.linkPattern.replace(/\{(\w+)\}/g, (_, key) => {
      if (key === 'id') return item.id;
      if (key === 'seq') return String(item.seq);
      if (key === 'slug') return encodeURIComponent(roles.slug ? item.data?.[roles.slug.name] ?? '' : item.id);
      const v = item.data?.[key];
      return encodeURIComponent(v == null ? '' : typeof v === 'object' ? v.id ?? '' : String(v));
    });
  }
  const own = roles.url && item.data?.[roles.url.name];
  return own || `${ctx.itemsUrl}/${item.id}`;
}

// ---- iCalendar (RFC 5545) ----------------------------------------------------

const icsEscape = (s) => String(s).replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\r?\n/g, '\\n');
const icsUtc = (iso) => iso.replace(/[-:]/g, '').replace(/\.\d{3}/, '');
const ymd = (s) => s.replace(/-/g, '');

/** Folds a content line at 75 octets without splitting a UTF-8 character. */
function fold(line) {
  const out = [];
  let current = '';
  let bytes = 0;
  for (const ch of line) {
    const size = Buffer.byteLength(ch);
    if (bytes + size > (out.length ? 74 : 75)) {
      out.push(current);
      current = '';
      bytes = 0;
    }
    current += ch;
    bytes += size;
  }
  out.push(current);
  return out.join('\r\n ');
}

/** YYYY-MM-DD of an instant in a time zone. */
function dateInZone(iso, timeZone) {
  return new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(iso));
}
const addDays = (date, n) => {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};

export function toICS(stream, items, ctx) {
  const roles = fieldRoles(stream, ctx.overrides);
  const tz = ctx.timeZone || 'UTC';
  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//Media Manager//Streams//EN',
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    `X-WR-CALNAME:${icsEscape(stream.name)}`,
    ...(stream.description ? [`X-WR-CALDESC:${icsEscape(stream.description)}`] : []),
  ];
  for (const item of items) {
    const start = roles.start ? item.data?.[roles.start.name] : item.timestamp;
    if (!start) continue;
    const end = roles.end ? item.data?.[roles.end.name] : null;
    const allDay = roles.start?.type === 'date' || (roles.allDay && item.data?.[roles.allDay.name] === true);

    lines.push('BEGIN:VEVENT', `UID:${item.id}@${ctx.host || 'media-manager'}`, `DTSTAMP:${icsUtc(item.updatedAt)}`);
    if (allDay) {
      const s = roles.start?.type === 'date' ? start : dateInZone(start, tz);
      let e = end ? (roles.end.type === 'date' ? end : dateInZone(end, tz)) : s;
      e = addDays(e < s ? s : e, 1); // DTEND is exclusive for all-day events
      lines.push(`DTSTART;VALUE=DATE:${ymd(s)}`, `DTEND;VALUE=DATE:${ymd(e)}`);
    } else {
      lines.push(`DTSTART:${icsUtc(new Date(start).toISOString())}`);
      if (end && end > start) lines.push(`DTEND:${icsUtc(new Date(end).toISOString())}`);
    }
    lines.push(`SUMMARY:${icsEscape(titleOf(item, roles))}`);
    const description = textOf(item, roles.description);
    if (description) lines.push(`DESCRIPTION:${icsEscape(description)}`);
    const point = roles.geopoint && item.data?.[roles.geopoint.name];
    const venue = textOf(item, roles.venue) || point?.label;
    if (venue) lines.push(`LOCATION:${icsEscape(venue)}`);
    if (point) lines.push(`GEO:${point.lat};${point.lng}`);
    lines.push(`URL:${linkOf(item, roles, ctx)}`);
    lines.push(`CREATED:${icsUtc(item.createdAt)}`, `LAST-MODIFIED:${icsUtc(item.updatedAt)}`, 'END:VEVENT');
  }
  lines.push('END:VCALENDAR');
  return `${lines.map(fold).join('\r\n')}\r\n`;
}

// ---- RSS 2.0 and JSON Feed 1.1 ------------------------------------------------

const xml = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');

function imageOf(item, roles, ctx) {
  const id = roles.image && item.data?.[roles.image.name];
  const file = id ? ctx.getFile(typeof id === 'object' ? id.id : id) : null;
  return file ? { url: ctx.absolute(file.url), mime: file.mime, size: file.size } : null;
}

const itemDate = (item, roles) => (roles.start && item.data?.[roles.start.name]) || item.publishedAt || item.timestamp;

export function toRSS(stream, items, ctx) {
  const roles = fieldRoles(stream, ctx.overrides);
  const latest = items.reduce((max, i) => (i.updatedAt > max ? i.updatedAt : max), stream.updatedAt);
  const entries = items.map((item) => {
    const image = imageOf(item, roles, ctx);
    const tags = roles.tags ? item.data?.[roles.tags.name] || [] : [];
    const description = textOf(item, roles.description);
    return [
      '    <item>',
      `      <title>${xml(titleOf(item, roles))}</title>`,
      `      <link>${xml(linkOf(item, roles, ctx))}</link>`,
      `      <guid isPermaLink="false">${xml(item.id)}</guid>`,
      `      <pubDate>${new Date(item.publishedAt || item.timestamp).toUTCString()}</pubDate>`,
      ...(description ? [`      <description>${xml(description)}</description>`] : []),
      ...tags.map((t) => `      <category>${xml(t)}</category>`),
      ...(image ? [`      <enclosure url="${xml(image.url)}" length="${image.size}" type="${xml(image.mime)}"/>`] : []),
      '    </item>',
    ].join('\n');
  });
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom">',
    '  <channel>',
    `    <title>${xml(stream.name)}</title>`,
    `    <link>${xml(ctx.siteUrl || ctx.streamUrl)}</link>`,
    `    <description>${xml(stream.description || stream.name)}</description>`,
    `    <lastBuildDate>${new Date(latest).toUTCString()}</lastBuildDate>`,
    `    <atom:link href="${xml(ctx.feedUrl)}" rel="self" type="application/rss+xml"/>`,
    ...entries,
    '  </channel>',
    '</rss>',
    '',
  ].join('\n');
}

export function toJSONFeed(stream, items, ctx) {
  const roles = fieldRoles(stream, ctx.overrides);
  return {
    version: 'https://jsonfeed.org/version/1.1',
    title: stream.name,
    ...(stream.description ? { description: stream.description } : {}),
    home_page_url: ctx.siteUrl || ctx.streamUrl,
    feed_url: ctx.feedUrl,
    items: items.map((item) => {
      const image = imageOf(item, roles, ctx);
      const tags = roles.tags ? item.data?.[roles.tags.name] || [] : [];
      const summary = textOf(item, roles.description);
      const body = stream.fields.find((f) => f.type === 'richtext');
      return {
        id: item.id,
        url: linkOf(item, roles, ctx),
        title: titleOf(item, roles),
        content_text: (body && textOf(item, body)) || summary || titleOf(item, roles),
        ...(summary ? { summary } : {}),
        date_published: new Date(item.publishedAt || item.timestamp).toISOString(),
        date_modified: item.updatedAt,
        ...(image ? { image: image.url } : {}),
        ...(tags.length ? { tags } : {}),
        _media_manager: { seq: item.seq, timestamp: item.timestamp, date: itemDate(item, roles), data: item.data },
      };
    }),
  };
}

// ---- GeoJSON (RFC 7946) -----------------------------------------------------------

export function toGeoJSON(stream, items, ctx) {
  const roles = fieldRoles(stream, ctx.overrides);
  const pinField = roles.geopoint;
  const features = [];
  if (pinField) {
    for (const item of items) {
      const p = item.data?.[pinField.name];
      if (!p) continue;
      const properties = { title: titleOf(item, roles), url: linkOf(item, roles, ctx), seq: item.seq, timestamp: item.timestamp };
      for (const [k, v] of Object.entries(item.data || {})) if (k !== pinField.name) properties[k] = v;
      if (p.label) properties.label = p.label;
      features.push({ type: 'Feature', id: item.id, geometry: { type: 'Point', coordinates: [p.lng, p.lat] }, properties });
    }
  }
  return { type: 'FeatureCollection', name: stream.name, features };
}

// ---- CSV (RFC 4180) ----------------------------------------------------------------

/**
 * CSV with a header row. Strings that a spreadsheet would treat as a formula
 * (starting with = + - @ tab or CR) are prefixed with an apostrophe.
 */
export function toCSV(stream, items) {
  const keys = stream.fields.length
    ? stream.fields.map((f) => f.name)
    : [...new Set(items.flatMap((i) => Object.keys(i.data || {})))];
  const header = ['id', 'seq', 'timestamp', ...(stream.draftAndPublish ? ['publishedAt'] : []), ...keys];
  const cell = (v) => {
    if (v == null) return '';
    let s;
    if (Array.isArray(v)) s = v.map((x) => (typeof x === 'object' ? JSON.stringify(x) : x)).join('; ');
    else if (typeof v === 'object') s = JSON.stringify(v);
    else s = String(v);
    if (typeof v === 'string' && /^[=+\-@\t\r]/.test(s)) s = `'${s}`;
    return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const rows = items.map((i) => [i.id, i.seq, i.timestamp, ...(stream.draftAndPublish ? [i.publishedAt] : []), ...keys.map((k) => i.data?.[k])].map(cell).join(','));
  return `\uFEFF${[header.map(cell).join(','), ...rows].join('\r\n')}\r\n`;
}
