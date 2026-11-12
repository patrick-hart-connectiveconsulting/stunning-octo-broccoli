// Streams UI — the base element. Every component extends StreamElement, which
// fetches the stream definition and items, keeps them live, and renders items
// with the default markup, a user <template>, or a renderItem() function.

import {
  escapeHtml, renderMarkdown, markdownToText, truncate, fieldRoles, getPath, formatDate,
  safeUrl, fillPattern, mergeQuery, jsonLdFor, toDate,
} from './core.js';

const streamCache = new Map(); // "<url>|<key>" -> Promise<stream definition>

export const BASE_CSS = `
:host { display: block; font-family: var(--sui-font, inherit); color: var(--sui-text, inherit); font-size: var(--sui-font-size, 1rem); line-height: 1.5;
  --_accent: var(--sui-accent, #4945ff); --_accent-text: var(--sui-accent-text, #fff); --_surface: var(--sui-surface, #fff);
  --_border: var(--sui-border, #e3e5ea); --_muted: var(--sui-muted, #5b6270); --_radius: var(--sui-radius, 8px);
  --_gap: var(--sui-gap, 16px); --_shadow: var(--sui-shadow, 0 1px 3px rgba(16,24,40,.08)); --_title: var(--sui-title-size, 1.125rem);
  --_ratio: var(--sui-image-ratio, 16 / 9); --_hover: var(--sui-hover, rgba(73,69,255,.06)); }
:host([hidden]) { display: none; }
:host([theme=dark]) { --_surface: var(--sui-surface, #1e1f2b); --_border: var(--sui-border, #34364a); --_muted: var(--sui-muted, #a6a9bb); --_accent: var(--sui-accent, #8b88ff); --_hover: var(--sui-hover, rgba(139,136,255,.12)); color: var(--sui-text, #ececf1); }
@media (prefers-color-scheme: dark) {
  :host([theme=auto]) { --_surface: var(--sui-surface, #1e1f2b); --_border: var(--sui-border, #34364a); --_muted: var(--sui-muted, #a6a9bb); --_accent: var(--sui-accent, #8b88ff); --_hover: var(--sui-hover, rgba(139,136,255,.12)); color: var(--sui-text, #ececf1); }
}
*, *::before, *::after { box-sizing: border-box; }
a { color: var(--_accent); }
img { max-width: 100%; display: block; }
button { font: inherit; color: inherit; }
.sui-visually-hidden { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; }
.sui-message { padding: 16px; color: var(--_muted); text-align: center; border: 1px dashed var(--_border); border-radius: var(--_radius); }
.sui-message.sui-error { color: #b42318; border-color: #f2b8b5; }
.sui-loading::after { content: ''; display: inline-block; width: 1em; height: 1em; margin-left: .5em; vertical-align: -.15em; border: 2px solid var(--_border); border-top-color: var(--_accent); border-radius: 50%; animation: sui-spin .8s linear infinite; }
@keyframes sui-spin { to { transform: rotate(360deg); } }
@media (prefers-reduced-motion: reduce) { .sui-loading::after { animation: none; } }
.sui-item { display: flex; flex-direction: column; gap: 8px; min-width: 0; }
.sui-image { aspect-ratio: var(--_ratio); width: 100%; height: auto; object-fit: cover; border-radius: calc(var(--_radius) - 2px); background: var(--_border); }
.sui-body { display: flex; flex-direction: column; gap: 4px; min-width: 0; }
.sui-title { margin: 0; font-size: var(--_title); line-height: 1.3; font-weight: 650; overflow-wrap: anywhere; }
.sui-title a { color: inherit; text-decoration: none; }
.sui-title a:hover, .sui-title a:focus-visible { color: var(--_accent); text-decoration: underline; }
.sui-date, .sui-meta { color: var(--_muted); font-size: .875em; }
.sui-description { margin: 0; color: var(--_muted); }
.sui-tags { display: flex; flex-wrap: wrap; gap: 6px; list-style: none; margin: 4px 0 0; padding: 0; }
.sui-tag { font-size: .75em; font-weight: 600; padding: 2px 8px; border-radius: 999px; background: var(--_hover); color: var(--_accent); }
.sui-more { display: block; margin: var(--_gap) auto 0; padding: 8px 18px; border: 1px solid var(--_border); border-radius: 999px; background: var(--_surface); cursor: pointer; font-weight: 600; }
.sui-more:hover { border-color: var(--_accent); color: var(--_accent); }
.sui-button { display: inline-flex; align-items: center; justify-content: center; gap: 6px; min-width: 36px; min-height: 36px; padding: 6px 12px; border: 1px solid var(--_border); border-radius: var(--_radius); background: var(--_surface); cursor: pointer; }
.sui-button:hover { border-color: var(--_accent); color: var(--_accent); }
.sui-button[aria-pressed=true], .sui-button.sui-active { background: var(--_accent); border-color: var(--_accent); color: var(--_accent-text); }
:focus-visible { outline: 2px solid var(--_accent); outline-offset: 2px; }
`;

const ROLE_ATTRS = {
  'title-field': 'title', 'description-field': 'description', 'body-field': 'body', 'date-field': 'start', 'start-field': 'start',
  'end-field': 'end', 'image-field': 'image', 'location-field': 'location', 'url-field': 'url', 'tags-field': 'tags', 'venue-field': 'venue',
};
const DATED_TYPES = ['BlogPosting', 'Article', 'NewsArticle', 'SocialMediaPosting', 'Event'];
const COMMON_ATTRS = ['src', 'limit', 'sort', 'filter', 'populate', 'live', 'link', 'locale', 'theme', 'unstyled', 'key', 'date-style', 'show-date', 'hide-date',
  'excerpt', 'more', 'empty-text', 'jsonld', 'template', ...Object.keys(ROLE_ATTRS)];

export class StreamElement extends HTMLElement {
  static defaultLimit = 10;
  static defaultSort = null;
  static css = '';
  static extraAttributes = [];
  static emptyText = 'Nothing to show yet.';

  static get observedAttributes() {
    return [...COMMON_ATTRS, ...this.extraAttributes];
  }

  constructor() {
    super();
    this.items = [];
    this.stream = null;
    this.roles = null;
    this.total = 0;
    this.page = 1;
    this.renderItem = null;
  }

  connectedCallback() {
    this.#setupRoot();
    this.scheduleRefresh();
  }

  disconnectedCallback() {
    this._abort?.abort();
    this._source?.close();
    this._source = null;
    clearTimeout(this._refreshTimer);
    this.teardown?.();
  }

  attributeChangedCallback(name, oldValue, newValue) {
    if (oldValue === newValue || !this.isConnected) return;
    if (name === 'theme') return; // handled by CSS
    this.scheduleRefresh();
  }

  /** Batches attribute changes into a single refresh. */
  scheduleRefresh() {
    clearTimeout(this._refreshTimer);
    this._refreshTimer = setTimeout(() => this.refresh(), 0);
  }

  // ---- root and styles -------------------------------------------------------

  #setupRoot() {
    if (this.root) return;
    if (this.hasAttribute('unstyled')) {
      // Light DOM: the site's own CSS applies; class names are the styling hooks.
      this.root = document.createElement('div');
      this.root.className = `sui-root sui-${this.localName}`;
      this.append(this.root);
    } else {
      const shadow = this.attachShadow({ mode: 'open' });
      const style = document.createElement('style');
      style.textContent = BASE_CSS + this.constructor.css;
      this.root = document.createElement('div');
      this.root.className = `sui-root sui-${this.localName}`;
      this.root.setAttribute('part', 'root');
      shadow.append(style, this.root);
    }
  }

  // ---- data ------------------------------------------------------------------

  get limit() {
    const n = parseInt(this.getAttribute('limit'), 10);
    return Number.isFinite(n) && n > 0 ? Math.min(n, 500) : this.constructor.defaultLimit;
  }

  get locale() {
    return this.getAttribute('locale') || document.documentElement.lang || undefined;
  }

  headers() {
    const key = this.getAttribute('key');
    return key ? { Authorization: `Bearer ${key}` } : {};
  }

  async fetchJson(url, signal) {
    let res;
    try {
      res = await fetch(url, { headers: this.headers(), signal });
    } catch (err) {
      if (err.name === 'AbortError') throw err;
      const target = new URL(url, document.baseURI).origin;
      // Browsers hide the reason; the usual cause on another website is a missing CORS setting.
      throw new Error(target !== location.origin
        ? `Cannot load from ${target}. Check that the server is running and allows this website: start it with --cors=${location.origin}`
        : `Cannot reach the server at ${target}. Check that it is running.`);
    }
    if (!res.ok) {
      const body = await res.json().catch(() => null);
      throw new Error(body?.error?.message || `Request failed (HTTP ${res.status})`);
    }
    return res.json();
  }

  getStreamDefinition(signal) {
    const cacheKey = `${this.base}|${this.getAttribute('key') || ''}`;
    if (!streamCache.has(cacheKey)) {
      const p = this.fetchJson(this.base).catch((err) => {
        streamCache.delete(cacheKey);
        throw err;
      });
      streamCache.set(cacheKey, p);
    }
    return streamCache.get(cacheKey);
  }

  /** Query parameters for the items request. Components extend this. */
  query(page = 1) {
    const params = new URLSearchParams({ pageSize: String(this.limit), page: String(page) });
    const sort = this.getAttribute('sort') || this.defaultSort();
    if (sort) params.set('sort', sort);
    const populate = this.getAttribute('populate') ?? '*';
    if (populate && populate !== 'none') params.set('populate', populate);
    mergeQuery(params, this.getAttribute('filter'));
    return params;
  }

  defaultSort() {
    return this.constructor.defaultSort;
  }

  /** Loads one page of items. Components may override this (e.g. date ranges). */
  async load(signal, page = 1) {
    const r = await this.fetchJson(`${this.base}/items?${this.query(page)}`, signal);
    return { items: r.data, total: r.meta.pagination.total };
  }

  async refresh({ quiet = false } = {}) {
    const src = this.getAttribute('src');
    if (!src) return this.renderMessage('Set the src attribute to a stream URL, e.g. https://cms.example.com/api/streams/events', 'error');
    this._abort?.abort();
    const ac = new AbortController();
    this._abort = ac;
    if (!quiet && !this.items.length) this.renderMessage(this.getAttribute('loading-text') || 'Loading', 'loading');
    try {
      this.base = new URL(src, document.baseURI).href.replace(/\/+$/, '').replace(/\/(items|events)$/, '');
      this.origin = new URL(this.base).origin;
      this.stream = await this.getStreamDefinition(ac.signal);
      const overrides = {};
      for (const [attr, role] of Object.entries(ROLE_ATTRS)) if (this.hasAttribute(attr)) overrides[role] = this.getAttribute(attr);
      this.roles = fieldRoles(this.stream.fields || [], overrides);
      const { items, total } = await this.load(ac.signal, 1);
      if (ac.signal.aborted) return;
      this.page = 1;
      this.items = items;
      this.total = total;
      this.render();
      this.#jsonLd();
      this.#setupLive();
      this.dispatchEvent(new CustomEvent('stream-load', { detail: { items, stream: this.stream, total }, bubbles: true, composed: true }));
    } catch (err) {
      if (err.name === 'AbortError') return;
      this.renderMessage(err.message || 'Could not load the stream', 'error');
      this.dispatchEvent(new CustomEvent('stream-error', { detail: { error: err }, bubbles: true, composed: true }));
    }
  }

  async loadMore() {
    const ac = new AbortController();
    this._abort = ac;
    const { items } = await this.load(ac.signal, this.page + 1);
    this.page += 1;
    this.items = [...this.items, ...items.filter((i) => !this.items.some((x) => x.id === i.id))];
    this.render();
  }

  #setupLive() {
    const want = this.hasAttribute('live');
    const url = `${this.base}/subscribe${this.getAttribute('key') ? `?access_token=${encodeURIComponent(this.getAttribute('key'))}` : ''}`;
    if (!want || this._sourceUrl !== url) {
      this._source?.close();
      this._source = null;
      this._sourceUrl = null;
    }
    if (!want || this._source) return;
    const src = new EventSource(url);
    let timer;
    const update = () => {
      clearTimeout(timer);
      timer = setTimeout(() => this.refresh({ quiet: true }), 250);
    };
    for (const type of ['created', 'updated', 'deleted', 'published', 'unpublished', 'stream-updated']) src.addEventListener(type, update);
    this._source = src;
    this._sourceUrl = url;
  }

  #jsonLd() {
    this.querySelector(':scope > script[data-sui-jsonld]')?.remove();
    if (!this.hasAttribute('jsonld') || !this.stream?.schemaType || !this.items.length) return;
    const data = this.jsonLdData();
    if (!data) return;
    const script = document.createElement('script');
    script.type = 'application/ld+json';
    script.dataset.suiJsonld = '';
    script.textContent = JSON.stringify(data).replace(/</g, '\\u003c');
    this.append(script);
  }

  jsonLdData() {
    return {
      '@context': 'https://schema.org',
      '@type': 'ItemList',
      itemListElement: this.items.map((item, i) => {
        const info = this.info(item);
        const entry = jsonLdFor(item, this.stream, this.roles, { link: info.link ? new URL(info.link, document.baseURI).href : undefined, image: info.image?.src });
        delete entry?.['@context'];
        return { '@type': 'ListItem', position: i + 1, item: entry };
      }),
    };
  }

  // ---- item helpers ----------------------------------------------------------------

  mediaUrl(file) {
    if (!file) return null;
    return typeof file === 'object' && file.url ? new URL(file.url, `${this.origin}/`).href : null;
  }

  /** The common pieces of an item: title, link, dates, image, text, tags. */
  info(item) {
    const r = this.roles || {};
    const d = item.data || {};
    const text = (f) => {
      const v = f ? d[f.name] : null;
      if (v == null || v === '') return '';
      if (typeof v === 'object') return v.data ? Object.values(v.data).find((x) => typeof x === 'string') || '' : '';
      return f.type === 'richtext' ? markdownToText(v) : String(v);
    };
    const title = text(r.title) || `#${item.seq}`;
    let link = null;
    if (this.hasAttribute('link')) link = safeUrl(fillPattern(this.getAttribute('link'), item, r));
    else if (r.url && d[r.url.name]) link = safeUrl(d[r.url.name]);
    const start = r.start ? d[r.start.name] : item.timestamp; // the item's own date (see SPEC §5.1)
    const end = r.end ? d[r.end.name] : null;
    const allDay = (r.start?.type === 'date') || (r.allDay ? d[r.allDay.name] === true : false);
    const imageFile = r.image ? d[r.image.name] : null;
    const image = imageFile && typeof imageFile === 'object'
      ? { src: this.mediaUrl(imageFile), alt: imageFile.alternativeText || title, width: imageFile.width, height: imageFile.height }
      : null;
    const excerptLength = parseInt(this.getAttribute('excerpt'), 10);
    const description = truncate(text(r.description), Number.isFinite(excerptLength) ? excerptLength : 180);
    const tags = r.tags && Array.isArray(d[r.tags.name]) ? d[r.tags.name] : [];
    const pin = r.location ? d[r.location.name] : null;
    const venue = text(r.venue) || pin?.label || '';
    const body = r.body ? d[r.body.name] : null;
    return { item, title, link, start, end, allDay, image, description, tags, pin, venue, body, bodyIsMarkdown: r.body?.type === 'richtext' };
  }

  formatDate(value, opts = {}) {
    return formatDate(value, { locale: this.locale, style: this.getAttribute('date-style') || 'medium', ...opts });
  }

  /**
   * Whether items show a date: when the stream has a date field, or holds
   * dated content (posts, articles, events). show-date / hide-date override it.
   */
  showsDate() {
    if (this.hasAttribute('hide-date')) return false;
    if (this.hasAttribute('show-date')) return true;
    return Boolean(this.roles?.start) || DATED_TYPES.includes(this.stream?.schemaType) || !(this.stream?.fields || []).length;
  }

  /** The date line for an item: "Dec 1, 2026, 6:00 PM – 9:00 PM". */
  dateLabel(info) {
    if (!info.start || !this.showsDate()) return '';
    const start = this.formatDate(info.start, { allDay: info.allDay });
    if (!info.end) return start;
    const s = toDate(info.start);
    const e = toDate(info.end);
    if (!s || !e || e <= s) return start;
    const sameDay = s.toDateString() === e.toDateString();
    if (sameDay && !info.allDay) return `${start} – ${new Intl.DateTimeFormat(this.locale, { timeStyle: 'short' }).format(e)}`;
    if (sameDay) return start;
    return `${start} – ${this.formatDate(info.end, { allDay: info.allDay })}`;
  }

  /** Value for a template binding: "$title", "$link", "data.path" or "path". */
  valueOf(item, path, info) {
    if (path.startsWith('$')) {
      const key = path.slice(1);
      if (key === 'image') return info.image?.src;
      if (key === 'date') return info.start;
      if (key === 'dateLabel') return this.dateLabel(info);
      return { title: info.title, link: info.link, description: info.description, venue: info.venue, id: item.id, seq: item.seq, tags: info.tags, body: info.body }[key];
    }
    const fromData = getPath(item.data, path);
    return fromData !== undefined ? fromData : getPath(item, path);
  }

  /** Renders one item: renderItem(), a <template>, or the default markup. */
  renderOne(item, variant = 'default') {
    const info = this.info(item);
    let node;
    if (typeof this.renderItem === 'function') {
      const out = this.renderItem(item, { info, escapeHtml, renderMarkdown, formatDate: (v, o) => this.formatDate(v, o), element: this });
      if (out instanceof Node) node = out;
      else {
        const wrap = document.createElement('div');
        wrap.innerHTML = String(out ?? ''); // the caller is responsible for escaping (use helpers.escapeHtml)
        node = wrap.childElementCount === 1 ? wrap.firstElementChild : wrap;
      }
    } else {
      const tpl = this.template();
      node = tpl ? this.fromTemplate(tpl, item, info) : this.defaultItem(info, variant);
    }
    node.addEventListener?.('click', (e) => {
      if (e.target.closest?.('a, button')) return;
      this.dispatchEvent(new CustomEvent('stream-select', { detail: { item, info }, bubbles: true, composed: true }));
    });
    return node;
  }

  template() {
    const id = this.getAttribute('template');
    if (id) {
      const t = document.getElementById(id);
      return t instanceof HTMLTemplateElement ? t : null;
    }
    return this.querySelector(':scope > template');
  }

  fromTemplate(tpl, item, info) {
    const frag = tpl.content.cloneNode(true);
    const box = document.createElement('div');
    box.append(frag);
    const value = (path, entry) => (path.startsWith('.') ? getPath(entry, path.slice(1)) : this.valueOf(item, path, info));
    const stringify = (v) => {
      if (v == null) return '';
      if (Array.isArray(v)) return v.map(stringify).join(', ');
      if (typeof v === 'object') return v.data ? this.info(v).title : v.label ?? v.name ?? '';
      return String(v);
    };
    const apply = (root, entry) => {
      for (const el of [...root.querySelectorAll('[data-if], [data-unless]')]) {
        const path = el.dataset.if ?? el.dataset.unless;
        const v = value(path, entry);
        const empty = v == null || v === '' || v === false || (Array.isArray(v) && !v.length);
        if ((el.dataset.if !== undefined && empty) || (el.dataset.unless !== undefined && !empty)) el.remove();
      }
      for (const el of root.querySelectorAll('[data-field]')) el.textContent = stringify(value(el.dataset.field, entry));
      for (const el of root.querySelectorAll('[data-html]')) el.innerHTML = renderMarkdown(stringify(value(el.dataset.html, entry)));
      for (const el of root.querySelectorAll('[data-date]')) {
        const v = value(el.dataset.date, entry);
        el.textContent = v ? this.formatDate(v, { allDay: info.allDay }) : '';
        if (el.localName === 'time' && v) el.setAttribute('datetime', v);
      }
      for (const el of root.querySelectorAll('[data-href]')) {
        const v = value(el.dataset.href, entry);
        if (v) el.setAttribute('href', safeUrl(typeof v === 'object' ? this.mediaUrl(v) : v));
        else el.removeAttribute('href');
      }
      for (const el of root.querySelectorAll('[data-src]')) {
        const v = value(el.dataset.src, entry);
        const url = typeof v === 'object' ? this.mediaUrl(v) : v;
        if (url) {
          el.setAttribute('src', safeUrl(url, { image: true }));
          if (!el.hasAttribute('alt')) el.setAttribute('alt', (typeof v === 'object' && v.alternativeText) || info.title);
        } else el.remove();
      }
    };
    // Repeat [data-each] elements once per entry, binding ".path" inside to the entry.
    for (const el of [...box.querySelectorAll('[data-each]')].reverse()) {
      const list = value(el.dataset.each);
      const entries = Array.isArray(list) ? list : [];
      for (const entry of entries) {
        const clone = el.cloneNode(true);
        clone.removeAttribute('data-each');
        const holder = document.createElement('div');
        holder.append(clone);
        apply(holder, entry);
        if (clone.dataset.field === '.') clone.textContent = stringify(entry);
        el.before(...holder.childNodes);
      }
      el.remove();
    }
    apply(box);
    return box.childElementCount === 1 ? box.firstElementChild : box;
  }

  defaultItem(info, variant) {
    const el = (tag, attrs = {}, ...kids) => {
      const n = document.createElement(tag);
      for (const [k, v] of Object.entries(attrs)) if (v != null && v !== false) n.setAttribute(k, v === true ? '' : v);
      n.append(...kids.flat().filter((k) => k != null && k !== false && k !== ''));
      return n;
    };
    const showImage = info.image?.src && !this.hasAttribute('compact') && variant !== 'text';
    const titleText = info.link ? el('a', { href: info.link, part: 'link' }, info.title) : info.title;
    const dateText = this.dateLabel(info);
    return el('article', { class: `sui-item sui-item--${variant}`, part: 'item' },
      showImage ? el('img', { class: 'sui-image', part: 'image', src: info.image.src, alt: info.image.alt, loading: 'lazy', width: info.image.width, height: info.image.height }) : null,
      el('div', { class: 'sui-body', part: 'body' },
        dateText ? el('time', { class: 'sui-date', part: 'date', datetime: info.start }, dateText) : null,
        el(variant === 'detail' ? 'h2' : 'h3', { class: 'sui-title', part: 'title' }, titleText),
        info.venue ? el('span', { class: 'sui-meta', part: 'venue' }, info.venue) : null,
        info.description && variant !== 'title' ? el('p', { class: 'sui-description', part: 'description' }, info.description) : null,
        info.tags.length && variant !== 'title' ? el('ul', { class: 'sui-tags', part: 'tags' }, info.tags.map((t) => el('li', { class: 'sui-tag', part: 'tag' }, t))) : null));
  }

  // ---- rendering ---------------------------------------------------------------------

  renderMessage(text, kind = 'empty') {
    if (!this.root) return;
    const p = document.createElement('p');
    p.className = `sui-message sui-${kind}`;
    p.setAttribute('part', `message ${kind}`);
    p.setAttribute('role', kind === 'error' ? 'alert' : 'status');
    p.textContent = text;
    this.root.replaceChildren(p);
  }

  /** Renders the current items. Components implement renderView(items) and return nodes. */
  render() {
    if (!this.items.length && !this.allowEmptyView) {
      this.renderMessage(this.getAttribute('empty-text') || this.constructor.emptyText, 'empty');
      return;
    }
    const nodes = [this.renderView(this.items)].flat().filter(Boolean);
    const moreLabel = this.getAttribute('more');
    if (moreLabel !== null && this.items.length < this.total) {
      const b = document.createElement('button');
      b.className = 'sui-more';
      b.setAttribute('part', 'more');
      b.type = 'button';
      b.textContent = moreLabel || 'Load more';
      b.addEventListener('click', () => {
        b.disabled = true;
        this.loadMore().catch((err) => this.renderMessage(err.message, 'error'));
      });
      nodes.push(b);
    }
    this.root.replaceChildren(...nodes);
    this.afterRender?.();
  }

  renderView(items) {
    const ul = document.createElement('ul');
    for (const item of items) {
      const li = document.createElement('li');
      li.append(this.renderOne(item));
      ul.append(li);
    }
    return ul;
  }
}

/** Small DOM builder used by the components. Text is set as text, never HTML. */
export function h(tag, attrs = {}, ...kids) {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k.startsWith('on') && typeof v === 'function') n.addEventListener(k.slice(2), v);
    else n.setAttribute(k, v === true ? '' : v);
  }
  n.append(...kids.flat().filter((k) => k != null && k !== false && k !== ''));
  return n;
}
