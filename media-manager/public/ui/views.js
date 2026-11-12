// Streams UI — list-style views: list, cards, carousel, timeline, table,
// gallery, next/countdown, single item, tag filter and banner.

import { StreamElement, h } from './base.js';
import { renderMarkdown, toDate, markdownToText, jsonLdFor, safeUrl, dayKey } from './core.js';

// ---- <stream-list> -------------------------------------------------------------------

export class StreamList extends StreamElement {
  static extraAttributes = ['layout', 'compact', 'divided'];
  static css = `
.sui-list { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: var(--_gap); }
.sui-list > li { min-width: 0; }
.sui-list--vertical .sui-item:not(.sui-item--text) { flex-direction: row; align-items: flex-start; gap: var(--_gap); }
.sui-list--vertical .sui-image { width: var(--sui-thumb-width, 160px); flex: none; aspect-ratio: var(--sui-thumb-ratio, 4 / 3); }
:host([divided]) .sui-list--vertical > li + li { border-top: 1px solid var(--_border); padding-top: var(--_gap); }
.sui-list--horizontal { flex-direction: row; overflow-x: auto; scroll-snap-type: x mandatory; padding-bottom: 8px; }
.sui-list--horizontal > li { flex: 0 0 var(--sui-item-width, 260px); scroll-snap-align: start; }
@media (max-width: 520px) { .sui-list--vertical .sui-item:not(.sui-item--text) { flex-direction: column; } .sui-list--vertical .sui-image { width: 100%; } }
`;

  renderView(items) {
    const layout = this.getAttribute('layout') === 'horizontal' ? 'horizontal' : 'vertical';
    return h('ul', { class: `sui-list sui-list--${layout}`, part: 'list' },
      items.map((item) => h('li', { part: 'list-item' }, this.renderOne(item))));
  }
}

// ---- <stream-cards> ------------------------------------------------------------------

export class StreamCards extends StreamElement {
  static defaultLimit = 12;
  static extraAttributes = ['columns', 'compact'];
  static css = `
.sui-cards { list-style: none; margin: 0; padding: 0; display: grid; gap: var(--_gap); grid-template-columns: repeat(var(--_cols, auto-fill), minmax(min(100%, var(--sui-card-min, 240px)), 1fr)); }
.sui-cards > li { display: flex; }
.sui-cards .sui-item { flex: 1; background: var(--_surface); border: 1px solid var(--_border); border-radius: var(--_radius); box-shadow: var(--_shadow); overflow: hidden; gap: 0; }
.sui-cards .sui-image { border-radius: 0; }
.sui-cards .sui-body { padding: 14px 16px 16px; }
.sui-cards .sui-item:hover { border-color: var(--_accent); }
`;

  renderView(items) {
    const cols = parseInt(this.getAttribute('columns'), 10);
    return h('ul', { class: 'sui-cards', part: 'grid', style: cols > 0 ? `--_cols: ${cols}` : null },
      items.map((item) => h('li', { part: 'card' }, this.renderOne(item, 'card'))));
  }
}

// ---- <stream-carousel> ---------------------------------------------------------------

export class StreamCarousel extends StreamElement {
  static extraAttributes = ['autoplay', 'per-view', 'compact'];
  static css = `
.sui-carousel { position: relative; }
.sui-track { list-style: none; margin: 0; padding: 0; display: flex; gap: var(--_gap); overflow-x: auto; scroll-snap-type: x mandatory; scroll-behavior: smooth; scrollbar-width: none; }
.sui-track::-webkit-scrollbar { display: none; }
.sui-track > li { flex: 0 0 calc((100% - (var(--_per, 1) - 1) * var(--_gap)) / var(--_per, 1)); scroll-snap-align: start; min-width: 0; }
.sui-track .sui-item { background: var(--_surface); border: 1px solid var(--_border); border-radius: var(--_radius); overflow: hidden; gap: 0; height: 100%; }
.sui-track .sui-image { border-radius: 0; }
.sui-track .sui-body { padding: 14px 16px 16px; }
.sui-controls { display: flex; align-items: center; justify-content: center; gap: 12px; margin-top: 12px; }
.sui-dots { display: flex; gap: 6px; }
.sui-dot { width: 10px; height: 10px; padding: 0; border-radius: 50%; border: 0; background: var(--_border); cursor: pointer; }
.sui-dot[aria-current=true] { background: var(--_accent); }
@media (prefers-reduced-motion: reduce) { .sui-track { scroll-behavior: auto; } }
`;

  renderView(items) {
    const per = Math.max(1, parseInt(this.getAttribute('per-view'), 10) || 1);
    const track = h('ul', { class: 'sui-track', part: 'track', tabindex: '0', 'aria-label': `${this.stream?.name || 'Items'} carousel`, style: `--_per: ${per}` },
      items.map((item, i) => h('li', { part: 'slide', 'aria-roledescription': 'slide', 'aria-label': `${i + 1} of ${items.length}` }, this.renderOne(item, 'card'))));
    const pages = Math.max(1, items.length - per + 1);
    const dots = h('div', { class: 'sui-dots', part: 'dots' },
      Array.from({ length: pages }, (_, i) => h('button', { type: 'button', class: 'sui-dot', part: 'dot', 'aria-label': `Go to slide ${i + 1}`, onclick: () => this.go(i) })));
    const prev = h('button', { type: 'button', class: 'sui-button', part: 'prev', 'aria-label': 'Previous', onclick: () => this.go(this.index - 1) }, '‹');
    const next = h('button', { type: 'button', class: 'sui-button', part: 'next', 'aria-label': 'Next', onclick: () => this.go(this.index + 1) }, '›');
    this.track = track;
    this.dots = dots;
    this.pages = pages;
    this.index = 0;
    track.addEventListener('scroll', () => {
      clearTimeout(this._scrollTimer);
      this._scrollTimer = setTimeout(() => this.#syncIndex(), 80);
    });
    track.addEventListener('keydown', (e) => {
      if (e.key === 'ArrowRight') { e.preventDefault(); this.go(this.index + 1); }
      if (e.key === 'ArrowLeft') { e.preventDefault(); this.go(this.index - 1); }
    });
    for (const ev of ['mouseenter', 'focusin']) this.addEventListener(ev, () => { this.paused = true; });
    for (const ev of ['mouseleave', 'focusout']) this.addEventListener(ev, () => { this.paused = false; });
    return h('div', { class: 'sui-carousel', part: 'carousel', 'aria-roledescription': 'carousel' }, track,
      pages > 1 ? h('div', { class: 'sui-controls', part: 'controls' }, prev, dots, next) : null);
  }

  afterRender() {
    this.#syncIndex();
    clearInterval(this._autoplay);
    const ms = parseInt(this.getAttribute('autoplay'), 10);
    const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (ms > 0 && !reduced && this.pages > 1) {
      this._autoplay = setInterval(() => { if (!this.paused) this.go((this.index + 1) % this.pages); }, Math.max(1500, ms));
    }
  }

  teardown() {
    clearInterval(this._autoplay);
  }

  go(i) {
    if (!this.track) return;
    const index = (i + this.pages) % this.pages;
    const slide = this.track.children[index];
    if (slide) this.track.scrollTo({ left: slide.offsetLeft - this.track.offsetLeft, behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' });
    this.index = index;
    this.#markDots();
  }

  #syncIndex() {
    if (!this.track) return;
    const slides = [...this.track.children];
    const left = this.track.scrollLeft;
    let best = 0;
    slides.forEach((s, i) => { if (Math.abs(s.offsetLeft - this.track.offsetLeft - left) < Math.abs(slides[best].offsetLeft - this.track.offsetLeft - left)) best = i; });
    this.index = Math.min(best, this.pages - 1);
    this.#markDots();
  }

  #markDots() {
    [...(this.dots?.children || [])].forEach((d, i) => d.setAttribute('aria-current', String(i === this.index)));
  }
}

// ---- <stream-timeline> ---------------------------------------------------------------

export class StreamTimeline extends StreamElement {
  static defaultLimit = 20;
  static extraAttributes = ['group', 'alternate', 'compact', 'order'];
  static css = `
.sui-timeline { list-style: none; margin: 0; padding: 0; position: relative; }
.sui-timeline::before { content: ''; position: absolute; left: 7px; top: 4px; bottom: 4px; width: 2px; background: var(--_border); }
.sui-timeline > li { position: relative; padding: 0 0 var(--_gap) 32px; }
.sui-timeline > li::before { content: ''; position: absolute; left: 0; top: 4px; width: 16px; height: 16px; border-radius: 50%; background: var(--_surface); border: 3px solid var(--_accent); }
.sui-timeline .sui-group { padding-left: 32px; font-weight: 700; color: var(--_muted); text-transform: uppercase; font-size: .8em; letter-spacing: .05em; }
.sui-timeline .sui-group::before { display: none; }
.sui-timeline .sui-image { max-width: 320px; }
@media (min-width: 720px) {
  :host([alternate]) .sui-timeline::before { left: 50%; margin-left: -1px; }
  :host([alternate]) .sui-timeline > li { width: 50%; padding: 0 32px var(--_gap) 0; text-align: right; }
  :host([alternate]) .sui-timeline > li::before { left: auto; right: -8px; }
  :host([alternate]) .sui-timeline > li.sui-right { margin-left: 50%; padding: 0 0 var(--_gap) 32px; text-align: left; }
  :host([alternate]) .sui-timeline > li.sui-right::before { left: -8px; right: auto; }
  :host([alternate]) .sui-timeline > li:not(.sui-right) .sui-tags { justify-content: flex-end; }
  :host([alternate]) .sui-timeline .sui-group { width: 100%; text-align: center; padding: 0 0 var(--_gap); }
  :host([alternate]) .sui-timeline > li:not(.sui-right) .sui-image { margin-left: auto; }
}
`;

  defaultSort() {
    const dir = this.getAttribute('order') === 'asc' ? 'asc' : 'desc';
    return this.roles?.start ? `data.${this.roles.start.name}:${dir}` : `timestamp:${dir}`;
  }

  query(page) {
    const params = super.query(page);
    if (!this.getAttribute('sort') && this.roles) params.set('sort', this.defaultSort());
    return params;
  }

  renderView(items) {
    const group = this.getAttribute('group'); // year | month
    const list = h('ol', { class: 'sui-timeline', part: 'timeline' });
    let lastGroup = null;
    let side = 0;
    for (const item of items) {
      const info = this.info(item);
      const d = toDate(info.start);
      if (group && d) {
        const key = group === 'month' ? new Intl.DateTimeFormat(this.locale, { month: 'long', year: 'numeric' }).format(d) : String(d.getFullYear());
        if (key !== lastGroup) {
          list.append(h('li', { class: 'sui-group', part: 'group', role: 'presentation' }, key));
          lastGroup = key;
        }
      }
      list.append(h('li', { part: 'entry', class: side++ % 2 ? 'sui-right' : null }, this.renderOne(item)));
    }
    return list;
  }
}

// ---- <stream-table> --------------------------------------------------------------------

const prettify = (name) => name.replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/[_-]+/g, ' ').replace(/^\w/, (c) => c.toUpperCase());

export class StreamTable extends StreamElement {
  static defaultLimit = 50;
  static extraAttributes = ['columns', 'headers', 'searchable', 'caption'];
  static css = `
.sui-table-wrap { overflow-x: auto; border: 1px solid var(--_border); border-radius: var(--_radius); }
table { width: 100%; border-collapse: collapse; background: var(--_surface); }
caption { text-align: left; padding: 10px 12px; font-weight: 650; }
th, td { text-align: left; padding: 10px 12px; border-bottom: 1px solid var(--_border); vertical-align: top; }
tbody tr:last-child td { border-bottom: 0; }
th { font-size: .8em; text-transform: uppercase; letter-spacing: .04em; color: var(--_muted); white-space: nowrap; }
th button { all: unset; cursor: pointer; }
th button:focus-visible { outline: 2px solid var(--_accent); }
th[aria-sort] button { color: var(--_accent); }
tbody tr:hover { background: var(--_hover); }
td img { width: 48px; height: 48px; object-fit: cover; border-radius: 6px; }
.sui-search { width: 100%; max-width: 320px; margin-bottom: 12px; padding: 8px 12px; border: 1px solid var(--_border); border-radius: var(--_radius); font: inherit; background: var(--_surface); color: inherit; }
`;

  columns() {
    const fields = this.stream.fields || [];
    const wanted = (this.getAttribute('columns') || '').split(',').map((s) => s.trim()).filter(Boolean);
    if (wanted.length) return wanted.map((n) => fields.find((f) => f.name === n) || { name: n, type: 'string' });
    const picked = [this.roles.title, this.roles.start, this.roles.venue].filter(Boolean);
    for (const f of fields) {
      if (picked.length >= 5) break;
      if (!picked.includes(f) && !['richtext', 'text', 'json', 'uid', 'media', 'geopoint'].includes(f.type)) picked.push(f);
    }
    return picked.length ? picked : [{ name: '$title', type: 'string' }];
  }

  cell(item, field, info) {
    const v = field.name === '$title' ? info.title : item.data?.[field.name];
    if (field === this.roles.title || field.name === '$title') return info.link ? h('a', { href: info.link }, info.title) : info.title;
    if (v == null || v === '' || (Array.isArray(v) && !v.length)) return '—';
    switch (field.type) {
      case 'datetime': case 'date': return h('time', { datetime: v }, this.formatDate(v, { allDay: field === this.roles.start && info.allDay }));
      case 'boolean': return v ? '✓' : '—';
      case 'media': return typeof v === 'object' ? h('img', { src: this.mediaUrl(v), alt: v.alternativeText || '', loading: 'lazy' }) : '';
      case 'relation': return (Array.isArray(v) ? v : [v]).map((r) => (typeof r === 'object' ? this.info(r).title : r)).join(', ');
      case 'geopoint': return v.label || `${v.lat.toFixed(4)}, ${v.lng.toFixed(4)}`;
      case 'url': return h('a', { href: safeUrl(v), rel: 'noopener' }, v.replace(/^https?:\/\//, ''));
      case 'email': return h('a', { href: `mailto:${v}` }, v);
      case 'richtext': return markdownToText(v).slice(0, 120);
      case 'number': return new Intl.NumberFormat(this.locale).format(v);
      default: return Array.isArray(v) ? v.join(', ') : typeof v === 'object' ? JSON.stringify(v) : String(v);
    }
  }

  renderView(items) {
    const cols = this.columns();
    const headers = (this.getAttribute('headers') || '').split(',').map((s) => s.trim());
    const sortKey = this._sortCol;
    const dir = this._sortDir || 1;
    const rows = items.map((item) => ({ item, info: this.info(item) }));
    if (sortKey != null) {
      const f = cols[sortKey];
      const val = ({ item, info }) => (f.name === '$title' || f === this.roles.title ? info.title : item.data?.[f.name]);
      rows.sort((a, b) => {
        const av = val(a); const bv = val(b);
        if (av == null) return 1;
        if (bv == null) return -1;
        return (typeof av === 'number' ? av - bv : String(av).localeCompare(String(bv), this.locale, { numeric: true })) * dir;
      });
    }
    const q = (this._search || '').toLowerCase();
    const visible = q ? rows.filter(({ item, info }) => (info.title + JSON.stringify(item.data)).toLowerCase().includes(q)) : rows;
    const table = h('table', { part: 'table' },
      this.getAttribute('caption') ? h('caption', { part: 'caption' }, this.getAttribute('caption')) : null,
      h('thead', {}, h('tr', {}, cols.map((f, i) => h('th', { scope: 'col', part: 'header', 'aria-sort': sortKey === i ? (dir > 0 ? 'ascending' : 'descending') : null },
        h('button', { type: 'button', onclick: () => { this._sortDir = this._sortCol === i ? -dir : 1; this._sortCol = i; this.render(); } },
          headers[i] || (f.name === '$title' ? 'Title' : prettify(f.name)), sortKey === i ? (dir > 0 ? ' ▲' : ' ▼') : ''))))),
      h('tbody', {}, visible.map(({ item, info }) => {
        const tr = h('tr', { part: 'row' }, cols.map((f) => h('td', { part: 'cell' }, this.cell(item, f, info))));
        tr.addEventListener('click', (e) => {
          if (!e.target.closest('a')) this.dispatchEvent(new CustomEvent('stream-select', { detail: { item, info }, bubbles: true, composed: true }));
        });
        return tr;
      })));
    const out = [];
    if (this.hasAttribute('searchable')) {
      const input = h('input', { class: 'sui-search', part: 'search', type: 'search', placeholder: 'Search…', 'aria-label': 'Search', value: this._search || '' });
      input.addEventListener('input', () => {
        this._search = input.value;
        const pos = input.selectionStart;
        this.render();
        const again = this.root.querySelector('.sui-search');
        again.focus();
        again.setSelectionRange(pos, pos);
      });
      out.push(input);
    }
    out.push(h('div', { class: 'sui-table-wrap', part: 'table-wrap' }, table));
    if (!visible.length) out.push(h('p', { class: 'sui-message', part: 'message' }, 'No matches.'));
    return out;
  }
}

// ---- <stream-gallery> ---------------------------------------------------------------------

export class StreamGallery extends StreamElement {
  static defaultLimit = 24;
  static extraAttributes = ['field', 'captions'];
  static css = `
.sui-gallery { list-style: none; margin: 0; padding: 0; display: grid; gap: calc(var(--_gap) / 2); grid-template-columns: repeat(auto-fill, minmax(min(100%, var(--sui-thumb-min, 160px)), 1fr)); }
.sui-thumb { all: unset; display: block; cursor: zoom-in; border-radius: calc(var(--_radius) - 2px); overflow: hidden; position: relative; }
.sui-thumb img { width: 100%; aspect-ratio: var(--sui-thumb-ratio, 1); object-fit: cover; transition: transform .2s; }
.sui-thumb:hover img { transform: scale(1.04); }
.sui-thumb:focus-visible { outline: 3px solid var(--_accent); outline-offset: 2px; }
.sui-caption { font-size: .85em; color: var(--_muted); padding-top: 4px; }
dialog { border: 0; padding: 0; background: transparent; max-width: 96vw; max-height: 96vh; color: #fff; }
dialog::backdrop { background: rgba(8, 8, 16, .88); }
.sui-lightbox { display: flex; flex-direction: column; align-items: center; gap: 10px; }
.sui-lightbox img { max-width: 92vw; max-height: 80vh; object-fit: contain; border-radius: 4px; }
.sui-lightbox-bar { display: flex; gap: 10px; align-items: center; }
.sui-lightbox .sui-button { background: rgba(255,255,255,.12); border-color: transparent; color: #fff; }
@media (prefers-reduced-motion: reduce) { .sui-thumb img { transition: none; } }
`;

  images(items) {
    const fields = (this.stream.fields || []).filter((f) => f.type === 'media');
    const chosen = this.getAttribute('field') ? fields.filter((f) => f.name === this.getAttribute('field')) : fields;
    const out = [];
    for (const item of items) {
      const info = this.info(item);
      for (const f of chosen) {
        const file = item.data?.[f.name];
        if (file && typeof file === 'object' && /^image\//.test(file.mime || 'image/')) {
          out.push({ item, info, src: this.mediaUrl(file), alt: file.alternativeText || info.title, caption: file.caption || info.title });
        }
      }
    }
    return out;
  }

  renderView(items) {
    const images = this.images(items);
    if (!images.length) return h('p', { class: 'sui-message', part: 'message empty' }, this.getAttribute('empty-text') || 'No images yet.');
    this._images = images;
    const captions = this.hasAttribute('captions');
    const grid = h('ul', { class: 'sui-gallery', part: 'gallery' }, images.map((img, i) => h('li', {},
      h('button', { type: 'button', class: 'sui-thumb', part: 'thumb', 'aria-label': `Open image: ${img.alt}`, onclick: () => this.open(i) },
        h('img', { src: img.src, alt: img.alt, loading: 'lazy' })),
      captions ? h('div', { class: 'sui-caption', part: 'caption' }, img.caption) : null)));
    this._img = h('img', { alt: '' });
    this._cap = h('span', { part: 'lightbox-caption' });
    this._dialog = h('dialog', { part: 'lightbox', 'aria-label': 'Image viewer' },
      h('div', { class: 'sui-lightbox' }, this._img,
        h('div', { class: 'sui-lightbox-bar' },
          h('button', { type: 'button', class: 'sui-button', 'aria-label': 'Previous image', onclick: () => this.open(this._i - 1) }, '‹'),
          this._cap,
          h('button', { type: 'button', class: 'sui-button', 'aria-label': 'Next image', onclick: () => this.open(this._i + 1) }, '›'),
          h('button', { type: 'button', class: 'sui-button', 'aria-label': 'Close', onclick: () => this._dialog.close() }, '✕'))));
    this._dialog.addEventListener('keydown', (e) => {
      if (e.key === 'ArrowRight') this.open(this._i + 1);
      if (e.key === 'ArrowLeft') this.open(this._i - 1);
    });
    this._dialog.addEventListener('click', (e) => { if (e.target === this._dialog) this._dialog.close(); });
    return [grid, this._dialog];
  }

  open(i) {
    const n = this._images.length;
    this._i = (i + n) % n;
    const img = this._images[this._i];
    this._img.src = img.src;
    this._img.alt = img.alt;
    this._cap.textContent = `${img.caption} (${this._i + 1}/${n})`;
    if (!this._dialog.open) this._dialog.showModal();
  }
}

// ---- <stream-next> ---------------------------------------------------------------------------

export class StreamNext extends StreamElement {
  static defaultLimit = 1;
  static emptyText = 'Nothing coming up.';
  static extraAttributes = ['countdown'];
  static css = `
.sui-next .sui-image { max-height: var(--sui-next-image-height, 280px); }
.sui-next { display: flex; flex-direction: column; gap: 12px; padding: 18px; border: 1px solid var(--_border); border-radius: var(--_radius); background: var(--_surface); }
.sui-countdown { display: flex; gap: 10px; flex-wrap: wrap; }
.sui-unit { min-width: 64px; text-align: center; padding: 8px; border-radius: var(--_radius); background: var(--_hover); }
.sui-unit strong { display: block; font-size: 1.6em; line-height: 1.1; color: var(--_accent); font-variant-numeric: tabular-nums; }
.sui-unit span { font-size: .75em; color: var(--_muted); text-transform: uppercase; letter-spacing: .05em; }
`;

  query(page) {
    const params = super.query(page);
    const f = this.roles?.start;
    const now = new Date();
    if (f) {
      params.set(`filter[${f.name}][gte]`, f.type === 'date' ? dayKey(now) : now.toISOString());
      if (!this.getAttribute('sort')) params.set('sort', `data.${f.name}:asc`);
    } else {
      params.set('since', now.toISOString());
      if (!this.getAttribute('sort')) params.set('sort', 'timestamp:asc');
    }
    return params;
  }

  renderView(items) {
    const item = items[0];
    const info = this.info(item);
    const box = h('div', { class: 'sui-next', part: 'next' }, this.renderOne(item));
    if (this.hasAttribute('countdown')) {
      this._cd = h('div', { class: 'sui-countdown', part: 'countdown', role: 'timer', 'aria-live': 'off' });
      this._target = toDate(info.start);
      box.append(this._cd);
    } else this._cd = null;
    return box;
  }

  afterRender() {
    clearInterval(this._timer);
    if (!this._cd) return;
    const tick = () => {
      let ms = Math.max(0, this._target - Date.now());
      const units = [['days', 86400000], ['hours', 3600000], ['minutes', 60000], ['seconds', 1000]].map(([label, size]) => {
        const v = Math.floor(ms / size);
        ms -= v * size;
        return [label, v];
      });
      this._cd.replaceChildren(...units.map(([label, v]) => h('div', { class: 'sui-unit', part: 'unit' }, h('strong', {}, String(v)), h('span', {}, label))));
      if (this._target <= Date.now()) {
        clearInterval(this._timer);
        this.scheduleRefresh();
      }
    };
    tick();
    this._timer = setInterval(tick, 1000);
  }

  teardown() {
    clearInterval(this._timer);
  }
}

// ---- <stream-item> -----------------------------------------------------------------------------

export class StreamItem extends StreamElement {
  static defaultLimit = 1;
  static emptyText = 'Not found.';
  static extraAttributes = ['item-id', 'slug', 'slug-param', 'slug-from-path', 'heading', 'set-title', 'details'];
  static css = `
.sui-detail { display: flex; flex-direction: column; gap: 14px; }
.sui-detail .sui-image { aspect-ratio: auto; max-height: 480px; }
.sui-detail > .sui-title { font-size: var(--sui-detail-title-size, 2em); }
.sui-detail h1, .sui-detail h2 { margin: 0; line-height: 1.2; }
.sui-content { line-height: 1.65; }
.sui-content :is(h1,h2,h3,h4) { line-height: 1.25; margin: 1.4em 0 .4em; }
.sui-content :is(p, ul, ol, blockquote, pre) { margin: 0 0 1em; }
.sui-content blockquote { border-left: 3px solid var(--_accent); padding-left: 14px; color: var(--_muted); }
.sui-content pre { background: var(--_hover); padding: 12px; border-radius: var(--_radius); overflow-x: auto; }
.sui-content code { font-family: ui-monospace, Menlo, Consolas, monospace; font-size: .9em; }
.sui-content img { border-radius: var(--_radius); }
.sui-details { display: grid; grid-template-columns: max-content 1fr; gap: 6px 16px; margin: 0; }
.sui-details dt { color: var(--_muted); }
.sui-details dd { margin: 0; }
`;

  slug() {
    if (this.getAttribute('slug')) return this.getAttribute('slug');
    const param = this.getAttribute('slug-param');
    if (param) return new URLSearchParams(location.search).get(param);
    if (this.hasAttribute('slug-from-path')) return decodeURIComponent(location.pathname.replace(/\/+$/, '').split('/').pop() || '');
    return null;
  }

  async load(signal) {
    const populate = this.getAttribute('populate') ?? '*';
    const pop = populate && populate !== 'none' ? `populate=${encodeURIComponent(populate)}` : '';
    const id = this.getAttribute('item-id');
    if (id) {
      try {
        return { items: [await this.fetchJson(`${this.base}/items/${encodeURIComponent(id)}?${pop}`, signal)], total: 1 };
      } catch (err) {
        if (/not found/i.test(err.message)) return { items: [], total: 0 };
        throw err;
      }
    }
    const slug = this.slug();
    const field = this.roles.slug;
    if (!slug) throw new Error('Set item-id, slug, slug-param or slug-from-path on <stream-item>.');
    if (!field) throw new Error('This stream has no UID (slug) field. Use item-id instead.');
    const r = await this.fetchJson(`${this.base}/items?filter[${field.name}]=${encodeURIComponent(slug)}&pageSize=1&${pop}`, signal);
    return { items: r.data, total: r.data.length };
  }

  renderView(items) {
    const item = items[0];
    if (this.template() || this.renderItem) return this.renderOne(item, 'detail');
    const info = this.info(item);
    if (this.hasAttribute('set-title')) document.title = info.title;
    const level = Math.min(6, Math.max(1, parseInt(this.getAttribute('heading'), 10) || 1));
    const body = info.body
      ? (() => { const div = h('div', { class: 'sui-content', part: 'content' }); div.innerHTML = info.bodyIsMarkdown ? renderMarkdown(info.body) : renderMarkdown(String(info.body)); return div; })()
      : (info.description ? h('p', { class: 'sui-description', part: 'description' }, info.description) : null);
    const dateText = this.dateLabel(info);
    const details = this.hasAttribute('details') ? this.details(item, info) : null;
    return h('article', { class: 'sui-detail', part: 'item' },
      h(`h${level}`, { class: 'sui-title', part: 'title' }, info.title),
      dateText || info.venue ? h('div', { class: 'sui-meta', part: 'meta' },
        dateText ? h('time', { datetime: info.start, part: 'date' }, dateText) : null,
        dateText && info.venue ? ' · ' : null, info.venue || null) : null,
      info.image?.src ? h('img', { class: 'sui-image', part: 'image', src: info.image.src, alt: info.image.alt, width: info.image.width, height: info.image.height }) : null,
      body,
      details,
      info.tags.length ? h('ul', { class: 'sui-tags', part: 'tags' }, info.tags.map((t) => h('li', { class: 'sui-tag', part: 'tag' }, t))) : null);
  }

  details(item, info) {
    const used = new Set([this.roles.title, this.roles.body, this.roles.description, this.roles.image, this.roles.tags, this.roles.slug, this.roles.start, this.roles.end, this.roles.allDay, this.roles.venue].filter(Boolean));
    const rows = [];
    for (const f of this.stream.fields || []) {
      if (used.has(f)) continue;
      const v = item.data?.[f.name];
      if (v == null || v === '' || (Array.isArray(v) && !v.length)) continue;
      let shown;
      if (f.type === 'url') shown = h('a', { href: safeUrl(v), rel: 'noopener' }, v);
      else if (f.type === 'email') shown = h('a', { href: `mailto:${v}` }, v);
      else if (f.type === 'boolean') shown = v ? 'Yes' : 'No';
      else if (f.type === 'geopoint') shown = h('a', { href: `https://www.openstreetmap.org/?mlat=${v.lat}&mlon=${v.lng}#map=15/${v.lat}/${v.lng}`, rel: 'noopener', target: '_blank' }, v.label || `${v.lat}, ${v.lng}`);
      else if (f.type === 'relation') shown = (Array.isArray(v) ? v : [v]).map((r) => (typeof r === 'object' ? this.info(r).title : r)).join(', ');
      else if (f.type === 'media') continue;
      else if (f.type === 'datetime' || f.type === 'date') shown = this.formatDate(v);
      else if (f.type === 'richtext') shown = markdownToText(v);
      else shown = Array.isArray(v) ? v.join(', ') : typeof v === 'object' ? JSON.stringify(v) : String(v);
      rows.push(h('dt', {}, prettify(f.name)), h('dd', {}, shown));
    }
    return rows.length ? h('dl', { class: 'sui-details', part: 'details' }, rows) : null;
  }

  jsonLdData() {
    const item = this.items[0];
    const info = this.info(item);
    return jsonLdFor(item, this.stream, this.roles, { link: location.href, image: info.image?.src });
  }
}

// ---- <stream-filter> -------------------------------------------------------------------------

/**
 * Chips that filter other components: <stream-filter for="news-list" field="tags">.
 * Reads the values from the target's stream; sets filter[field]=value on the targets.
 */
export class StreamFilter extends StreamElement {
  static defaultLimit = 500;
  static extraAttributes = ['for', 'field', 'all-label', 'values'];
  static css = `
.sui-chips { display: flex; flex-wrap: wrap; gap: 8px; }
.sui-chips .sui-button { border-radius: 999px; padding: 4px 14px; min-height: 32px; }
`;

  allowEmptyView = true;

  targets() {
    return (this.getAttribute('for') || '').split(',').map((id) => document.getElementById(id.trim())).filter(Boolean);
  }

  async refresh(opts) {
    if (!this.getAttribute('src')) {
      const t = this.targets()[0];
      if (t?.getAttribute('src')) this.setAttribute('src', t.getAttribute('src'));
    }
    return super.refresh(opts);
  }

  query() {
    const params = new URLSearchParams({ pageSize: '500' });
    const t = this.targets()[0];
    const base = t?.dataset.suiBaseFilter ?? t?.getAttribute('filter');
    const statusless = new URLSearchParams(base || '');
    for (const [k, v] of statusless) if (!k.startsWith(`filter[${this.fieldName()}]`)) params.append(k, v);
    return params;
  }

  fieldName() {
    return this.getAttribute('field') || this.roles?.tags?.name || 'tags';
  }

  renderView(items) {
    const field = this.fieldName();
    let values = (this.getAttribute('values') || '').split(',').map((s) => s.trim()).filter(Boolean);
    if (!values.length) {
      const counts = new Map();
      for (const item of items) {
        const v = item.data?.[field];
        for (const x of Array.isArray(v) ? v : v == null ? [] : [v]) {
          const key = typeof x === 'object' ? x.id : String(x);
          counts.set(key, (counts.get(key) || 0) + 1);
        }
      }
      values = [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([k]) => k);
    }
    const current = this._value ?? null;
    const choose = (value) => {
      this._value = value;
      for (const t of this.targets()) {
        if (t.dataset.suiBaseFilter === undefined) t.dataset.suiBaseFilter = t.getAttribute('filter') || '';
        const base = new URLSearchParams(t.dataset.suiBaseFilter);
        if (value != null) base.set(`filter[${field}]`, value);
        const next = base.toString();
        if (next) t.setAttribute('filter', next); else t.removeAttribute('filter');
      }
      this.dispatchEvent(new CustomEvent('stream-filter', { detail: { field, value }, bubbles: true, composed: true }));
      this.render();
    };
    return h('div', { class: 'sui-chips', part: 'chips', role: 'toolbar', 'aria-label': `Filter by ${field}` },
      h('button', { type: 'button', class: 'sui-button', part: 'chip', 'aria-pressed': String(current == null), onclick: () => choose(null) }, this.getAttribute('all-label') || 'All'),
      values.map((v) => h('button', { type: 'button', class: 'sui-button', part: 'chip', 'aria-pressed': String(current === v), onclick: () => choose(v) }, v)));
  }
}

// ---- <stream-banner> -------------------------------------------------------------------------

export class StreamBanner extends StreamElement {
  static defaultLimit = 5;
  static defaultSort = 'timestamp:desc';
  static extraAttributes = ['rotate', 'dismissible'];
  static css = `
.sui-banner { display: flex; align-items: center; gap: 12px; padding: 10px 16px; border-radius: var(--_radius); background: var(--_bg, #e9eaff); color: var(--_fg, #2a2793); }
.sui-banner[data-level=success] { --_bg: var(--sui-success-bg, #e6f6ea); --_fg: var(--sui-success-text, #1d6b34); }
.sui-banner[data-level=warning] { --_bg: var(--sui-warning-bg, #fff4d6); --_fg: var(--sui-warning-text, #7a4d00); }
.sui-banner[data-level=critical] { --_bg: var(--sui-critical-bg, #fde8e6); --_fg: var(--sui-critical-text, #9f1d14); }
.sui-banner[data-level=info] { --_bg: var(--sui-info-bg, #e9eaff); --_fg: var(--sui-info-text, #2a2793); }
.sui-banner-text { flex: 1; min-width: 0; }
.sui-banner a { color: inherit; font-weight: 650; }
.sui-banner button { all: unset; cursor: pointer; padding: 2px 6px; border-radius: 4px; }
.sui-banner button:focus-visible { outline: 2px solid currentColor; }
`;

  allowEmptyView = true;

  dismissed() {
    try { return JSON.parse(localStorage.getItem('sui-dismissed') || '[]'); } catch { return []; }
  }

  renderView(items) {
    const visible = items.filter((i) => !this.dismissed().includes(i.id));
    if (!visible.length) return null;
    this._list = visible;
    this._i = Math.min(this._i || 0, visible.length - 1);
    const item = visible[this._i];
    const info = this.info(item);
    const level = this.roles.level ? item.data?.[this.roles.level.name] : 'info';
    const linkText = item.data?.linkText;
    const text = h('span', { class: 'sui-banner-text', part: 'text' }, info.title,
      info.link ? [' ', h('a', { href: info.link, part: 'link' }, linkText || 'Learn more')] : null);
    return h('div', { class: 'sui-banner', part: 'banner', role: 'status', 'data-level': level || 'info' }, text,
      this.hasAttribute('dismissible') ? h('button', {
        type: 'button', 'aria-label': 'Dismiss', part: 'dismiss',
        onclick: () => {
          try { localStorage.setItem('sui-dismissed', JSON.stringify([...this.dismissed(), item.id].slice(-50))); } catch { /* storage unavailable */ }
          this.render();
        },
      }, '✕') : null);
  }

  afterRender() {
    clearInterval(this._timer);
    const ms = parseInt(this.getAttribute('rotate'), 10);
    if (ms > 0 && this._list?.length > 1 && !matchMedia('(prefers-reduced-motion: reduce)').matches) {
      this._timer = setInterval(() => { this._i = (this._i + 1) % this._list.length; this.render(); }, Math.max(2000, ms));
    }
  }

  teardown() {
    clearInterval(this._timer);
  }
}
