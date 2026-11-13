// Streams UI — core helpers. Pure functions with no DOM access at import time,
// so they can be unit-tested in Node and reused by every component.

// ---- escaping and safe Markdown ------------------------------------------------

const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
export const escapeHtml = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ESC[c]);

/**
 * Allows http(s), mailto, tel and relative URLs; everything else (javascript:,
 * data:…) becomes "#". Browsers ignore tabs, line breaks and leading control
 * characters in URLs ("java\tscript:" runs as "javascript:"), so they are
 * removed before the scheme is checked, and the cleaned URL is returned.
 */
export function safeUrl(url, { image = false } = {}) {
  const u = String(url ?? '').replace(/[\u0000-\u001f\u007f]/g, '').trim();
  if (!u) return '#';
  if (/^(https?:)?\/\//i.test(u) || /^[/.#?]/.test(u)) return u;
  if (!image && /^(mailto|tel):/i.test(u)) return u;
  if (/^[a-z][a-z0-9+.-]*:/i.test(u)) return '#'; // any other scheme
  return u; // relative path like "blog/x"
}

function inline(text) {
  // Text is already HTML-escaped; markup is added only from known patterns.
  const codes = [];
  let s = text.replace(/`([^`]+)`/g, (_, c) => `\u0000${codes.push(c) - 1}\u0000`);
  s = s
    .replace(/!\[([^\]]*)\]\(([^)\s]+)(?:\s+&quot;([^&]*)&quot;)?\)/g, (_, alt, src, title) =>
      `<img src="${escapeHtml(safeUrl(unescapeHtml(src), { image: true }))}" alt="${alt}"${title ? ` title="${title}"` : ''} loading="lazy">`)
    .replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_, label, href) => {
      const url = safeUrl(unescapeHtml(href));
      const external = /^(https?:)?\/\//i.test(url);
      return `<a href="${escapeHtml(url)}"${external ? ' rel="noopener noreferrer" target="_blank"' : ''}>${label}</a>`;
    })
    .replace(/\*\*(\S(?:.*?\S)??)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|[^\w])__(\S(?:.*?\S)??)__(?!\w)/g, '$1<strong>$2</strong>')
    .replace(/\*(\S(?:.*?\S)??)\*/g, '<em>$1</em>')
    .replace(/(^|[^\w])_(\S(?:.*?\S)??)_(?!\w)/g, '$1<em>$2</em>')
    .replace(/~~(\S(?:.*?\S)??)~~/g, '<del>$1</del>')
    .replace(/ {2,}\n/g, '<br>');
  return s.replace(/\u0000(\d+)\u0000/g, (_, i) => `<code>${codes[i]}</code>`);
}

const unescapeHtml = (s) => s.replace(/&(amp|lt|gt|quot|#39);/g, (m) => ({ '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#39;': "'" }[m]));

/**
 * Renders a safe subset of Markdown to HTML: headings, paragraphs, bold,
 * italic, strikethrough, inline code, code blocks, links, images, lists,
 * blockquotes and rules. Raw HTML in the input is escaped, never rendered.
 */
export function renderMarkdown(md) {
  const src = escapeHtml(String(md ?? '').replace(/\r\n?/g, '\n'));
  const lines = src.split('\n');
  const out = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (/^```/.test(line)) {
      const code = [];
      i++;
      while (i < lines.length && !/^```/.test(lines[i])) code.push(lines[i++]);
      i++;
      out.push(`<pre><code>${code.join('\n')}</code></pre>`);
      continue;
    }
    const h = /^(#{1,6})\s+(.*)$/.exec(line);
    if (h) {
      out.push(`<h${h[1].length}>${inline(h[2].replace(/\s+#+\s*$/, ''))}</h${h[1].length}>`);
      i++;
      continue;
    }
    if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) {
      out.push('<hr>');
      i++;
      continue;
    }
    if (/^&gt;\s?/.test(line)) {
      const quote = [];
      while (i < lines.length && /^&gt;\s?/.test(lines[i])) quote.push(lines[i++].replace(/^&gt;\s?/, ''));
      out.push(`<blockquote>${renderMarkdown(unescapeHtml(quote.join('\n')))}</blockquote>`);
      continue;
    }
    const listMatch = /^\s*([-*+]|\d+[.)])\s+/.exec(line);
    if (listMatch) {
      const ordered = /\d/.test(listMatch[1]);
      const items = [];
      while (i < lines.length && /^\s*([-*+]|\d+[.)])\s+/.test(lines[i])) {
        items.push(inline(lines[i].replace(/^\s*([-*+]|\d+[.)])\s+/, '')));
        i++;
      }
      out.push(`<${ordered ? 'ol' : 'ul'}>${items.map((t) => `<li>${t}</li>`).join('')}</${ordered ? 'ol' : 'ul'}>`);
      continue;
    }
    if (!line.trim()) {
      i++;
      continue;
    }
    const para = [];
    while (i < lines.length && lines[i].trim() && !/^(#{1,6}\s|```|&gt;|\s*([-*+]|\d+[.)])\s+)/.test(lines[i])) para.push(lines[i++]);
    out.push(`<p>${inline(para.join('\n'))}</p>`);
  }
  return out.join('\n');
}

/** Plain text from Markdown (for excerpts and alt text). */
export function markdownToText(md) {
  return String(md ?? '')
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/^>[ \t]?/gm, '')
    .replace(/^[ \t]*([-*+]|\d+[.)])[ \t]+/gm, '')
    .replace(/(\*\*|__|~~)(.*?)\1/g, '$2')
    .replace(/(\*|_)(.*?)\1/g, '$2')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/\s+/g, ' ')
    .trim();
}

export const truncate = (s, n) => {
  const t = String(s ?? '');
  if (t.length <= n) return t;
  const cut = t.slice(0, n - 1);
  return `${cut.slice(0, Math.max(cut.lastIndexOf(' '), n * 0.6)).trimEnd()}…`;
};

// ---- field roles ------------------------------------------------------------------

const norm = (s) => s.toLowerCase().replace(/[^a-z]/g, '');
const ROLE_NAMES = {
  title: ['title', 'name', 'headline', 'heading', 'label', 'question', 'subject', 'message', 'client'],
  description: ['excerpt', 'summary', 'description', 'abstract', 'answer', 'quote', 'text', 'bio', 'body', 'content', 'message'],
  body: ['body', 'content', 'description', 'answer', 'bio', 'text', 'results'],
  start: ['start', 'startdate', 'starts', 'startsat', 'starttime', 'begin', 'date', 'eventdate', 'closingdate'],
  end: ['end', 'enddate', 'ends', 'endsat', 'endtime', 'finish'],
  allDay: ['allday'],
  venue: ['venue', 'address', 'place', 'city', 'location'],
  url: ['url', 'link', 'website', 'applyurl', 'href'],
};
const ROLE_TYPES = {
  title: ['string', 'text', 'uid', 'email'],
  description: ['string', 'text', 'richtext'],
  body: ['richtext', 'text'],
  start: ['datetime', 'date'],
  end: ['datetime', 'date'],
  allDay: ['boolean'],
  venue: ['string', 'text'],
  url: ['url'],
};

/**
 * Which field plays which role, from field names and types. `overrides` maps a
 * role to a field name (from attributes like title-field="headline").
 */
export function fieldRoles(fields = [], overrides = {}) {
  const byName = (n) => fields.find((f) => f.name === n);
  const roles = {};
  for (const role of Object.keys(ROLE_NAMES)) {
    roles[role] = (overrides[role] && byName(overrides[role]))
      || ROLE_NAMES[role].map((n) => fields.find((f) => norm(f.name) === n && ROLE_TYPES[role].includes(f.type))).find(Boolean)
      || null;
  }
  roles.title ??= fields.find((f) => ['string', 'uid'].includes(f.type)) || null;
  if (roles.description === roles.title) roles.description = null;
  roles.image = (overrides.image && byName(overrides.image)) || fields.find((f) => f.type === 'media') || null;
  roles.location = (overrides.location && byName(overrides.location)) || fields.find((f) => f.type === 'geopoint') || null;
  roles.slug = fields.find((f) => f.type === 'uid') || null;
  roles.tags = (overrides.tags && byName(overrides.tags)) || fields.find((f) => f.type === 'tags') || null;
  roles.level = fields.find((f) => norm(f.name) === 'level' && f.type === 'enum') || null;
  return roles;
}

/** Reads a dotted path from an item: "title", "author.data.name", "$title"… */
export function getPath(obj, path) {
  if (path === '.' || path === '') return obj;
  return path.split('.').reduce((v, k) => (v == null ? undefined : v[k]), obj);
}

// ---- dates ------------------------------------------------------------------------

/** Local Date from an ISO date-time or a YYYY-MM-DD date (taken as local midnight). */
export function toDate(value) {
  if (value == null || value === '') return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  const d = m ? new Date(+m[1], +m[2] - 1, +m[3]) : new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}

export const isDateOnly = (value) => /^\d{4}-\d{2}-\d{2}$/.test(String(value ?? ''));
export const sameDay = (a, b) => a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
export const startOfDay = (d) => new Date(d.getFullYear(), d.getMonth(), d.getDate());
export const addDays = (d, n) => new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);
export const dayKey = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

/** Formats a date (and time when meaningful). style: short | medium | long | full. */
export function formatDate(value, { locale, style = 'medium', time = 'auto', allDay = false } = {}) {
  const d = toDate(value);
  if (!d) return '';
  const showTime = time === true || (time === 'auto' && !allDay && !isDateOnly(value));
  const opts = { dateStyle: style };
  if (showTime) opts.timeStyle = 'short';
  try {
    return new Intl.DateTimeFormat(locale || undefined, opts).format(d);
  } catch {
    return d.toLocaleString();
  }
}

export function formatTime(value, locale) {
  const d = toDate(value);
  return d ? new Intl.DateTimeFormat(locale || undefined, { timeStyle: 'short' }).format(d) : '';
}

/** 0 = Sunday … 6 = Saturday, from the locale (Intl.Locale weekInfo where supported). */
export function weekStartFor(locale) {
  try {
    const loc = new Intl.Locale(locale || Intl.DateTimeFormat().resolvedOptions().locale);
    const info = loc.getWeekInfo?.() || loc.weekInfo;
    if (info?.firstDay) return info.firstDay % 7;
    const region = loc.maximize().region;
    return ['US', 'CA', 'MX', 'BR', 'JP', 'KR', 'IL', 'PH', 'IN', 'ZA', 'AU', 'TW', 'HK'].includes(region) ? 0 : 1;
  } catch {
    return 1;
  }
}

/** The days shown for a month view: whole weeks covering the month (5 or 6 rows). */
export function monthGrid(year, month, weekStart = 1) {
  const first = new Date(year, month, 1);
  const offset = (first.getDay() - weekStart + 7) % 7;
  const start = addDays(first, -offset);
  const last = new Date(year, month + 1, 0);
  const days = Math.ceil((offset + last.getDate()) / 7) * 7;
  return Array.from({ length: days }, (_, i) => addDays(start, i));
}

export function weekDays(date, weekStart = 1) {
  const d = startOfDay(date);
  const start = addDays(d, -((d.getDay() - weekStart + 7) % 7));
  return Array.from({ length: 7 }, (_, i) => addDays(start, i));
}

/**
 * The span of an event in local days: [firstDay, lastDay] (inclusive). A
 * timed event that ends exactly at midnight does not occupy the next day.
 */
export function eventDays(startValue, endValue) {
  const s = toDate(startValue);
  if (!s) return null;
  let e = toDate(endValue) || s;
  if (e < s) e = s;
  let last = startOfDay(e);
  if (!isDateOnly(endValue) && endValue && e.getTime() === last.getTime() && e > s) last = addDays(last, -1);
  return [startOfDay(s), last < startOfDay(s) ? startOfDay(s) : last];
}

// ---- JSON-LD ------------------------------------------------------------------------

/** schema.org JSON-LD for an item, based on the stream's schemaType and field roles. */
export function jsonLdFor(item, stream, roles, { link, image } = {}) {
  const type = stream?.schemaType;
  if (!type) return null;
  const d = item.data || {};
  const val = (f) => (f ? d[f.name] : undefined);
  const text = (f) => {
    const v = val(f);
    return v == null ? undefined : f.type === 'richtext' ? markdownToText(v) : String(v);
  };
  const out = { '@context': 'https://schema.org', '@type': type };
  const title = text(roles.title);
  const nameKey = ['Question'].includes(type) ? 'name' : ['BlogPosting', 'Article', 'NewsArticle', 'WebPage'].includes(type) ? 'headline' : 'name';
  if (title) out[nameKey] = title;
  const description = text(roles.description);
  if (description && type !== 'Question') out.description = description;
  if (link) out.url = link;
  if (image) out.image = image;
  if (type === 'Event' || /Event$/.test(type)) {
    if (val(roles.start)) out.startDate = val(roles.start);
    if (val(roles.end)) out.endDate = val(roles.end);
    const pin = val(roles.location);
    const venue = text(roles.venue);
    if (pin || venue) {
      out.location = { '@type': 'Place', name: venue || pin?.label || title };
      if (pin) out.location.geo = { '@type': 'GeoCoordinates', latitude: pin.lat, longitude: pin.lng };
    }
  } else if (type === 'Question') {
    const answer = text(roles.body) || description;
    if (answer) out.acceptedAnswer = { '@type': 'Answer', text: answer };
  } else if (['BlogPosting', 'Article', 'NewsArticle'].includes(type)) {
    out.datePublished = item.publishedAt || item.timestamp;
    out.dateModified = item.updatedAt;
  } else if (type === 'Place' || type === 'LocalBusiness') {
    const pin = val(roles.location);
    if (pin) out.geo = { '@type': 'GeoCoordinates', latitude: pin.lat, longitude: pin.lng };
    if (d.address) out.address = d.address;
    if (d.phone) out.telephone = d.phone;
  } else if (type === 'Product') {
    if (d.sku) out.sku = d.sku;
    if (d.price != null) out.offers = { '@type': 'Offer', price: d.price, priceCurrency: d.currency || undefined, availability: d.inStock === false ? 'https://schema.org/OutOfStock' : 'https://schema.org/InStock' };
  } else if (type === 'Person') {
    if (d.jobTitle) out.jobTitle = d.jobTitle;
    if (d.email) out.email = d.email;
  } else if (type === 'JobPosting') {
    out.title = title;
    out.datePosted = item.publishedAt || item.timestamp;
    if (d.description) out.description = markdownToText(d.description);
    if (d.closingDate) out.validThrough = d.closingDate;
    if (d.employmentType) out.employmentType = String(d.employmentType).toUpperCase().replace(/-/g, '_');
  } else if (type === 'Review') {
    if (d.quote) out.reviewBody = d.quote;
    if (d.name) out.author = { '@type': 'Person', name: d.name };
    if (d.rating) out.reviewRating = { '@type': 'Rating', ratingValue: d.rating, bestRating: 5 };
  }
  return out;
}

// ---- links and queries -------------------------------------------------------------

/** Fills a link pattern like "/blog/{slug}" from an item. */
export function fillPattern(pattern, item, roles) {
  return pattern.replace(/\{(\$?\w+)\}/g, (_, key) => {
    if (key === 'id') return item.id;
    if (key === 'seq') return String(item.seq);
    if (key === 'slug') return encodeURIComponent((roles.slug && item.data?.[roles.slug.name]) || item.id);
    const v = item.data?.[key];
    return encodeURIComponent(v == null ? '' : typeof v === 'object' ? v.id ?? '' : String(v));
  });
}

/** Merges a user filter string ("filter[tags]=news&since=…") into URLSearchParams. */
export function mergeQuery(params, extra) {
  if (!extra) return params;
  for (const [k, v] of new URLSearchParams(extra.replace(/^\?/, ''))) params.append(k, v);
  return params;
}
