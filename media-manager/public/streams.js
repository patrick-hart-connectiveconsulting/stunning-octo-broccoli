// Streams admin page: create data streams (events, posts, products…), design
// their datasets, manage items, publishing, retention and webhooks.

import { $, h, api, toast, formatDate, debounce, copyText, getToken, initShell } from './common.js';
import { renderEmbed } from './embed.js';

const FIELD_TYPES = [
  ['string', 'Short text'],
  ['text', 'Long text'],
  ['richtext', 'Rich text (Markdown)'],
  ['uid', 'UID / slug'],
  ['email', 'Email'],
  ['url', 'URL'],
  ['integer', 'Integer'],
  ['number', 'Number'],
  ['boolean', 'Boolean'],
  ['datetime', 'Date & time'],
  ['enum', 'Enumeration'],
  ['tags', 'Tags'],
  ['json', 'JSON'],
  ['media', 'Media'],
  ['relation', 'Relation'],
  ['date', 'Date'],
  ['geopoint', 'Map pin'],
];
const KEY_SCOPES = [
  ['read', 'Read (incl. drafts)'],
  ['create', 'Create'],
  ['update', 'Update & publish'],
  ['delete', 'Delete'],
];
const UNIQUE_CAPABLE = new Set(['string', 'email', 'url', 'integer', 'number']);
const DEFAULT_MAX = { string: 255, text: 100000, richtext: 1000000, uid: 255 };
const WEBHOOK_EVENTS = ['created', 'updated', 'deleted', 'published', 'unpublished'];
const MAX_COLUMNS = 6;

const state = {
  streams: [],
  templates: [],
  current: null,
  tab: 'items',
  q: '',
  items: [],
  pagination: null,
  page: 1,
  pageSize: 25,
  sort: 'timestamp:desc',
  status: 'all',
  filter: null, // { field, op, value }
  source: null, // EventSource
  editing: null,
  media: null,
  related: new Map(), // target slug -> items (for relation pickers)
};

// ---- helpers ---------------------------------------------------------------

const toLocalInput = (iso) => {
  if (!iso) return '';
  const d = new Date(iso);
  return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 19);
};
const fromLocalInput = (v) => (v ? new Date(v).toISOString() : undefined);
const capitalize = (s) => s.charAt(0).toUpperCase() + s.slice(1);
const plural = (n, labels) => `${n} ${n === 1 ? labels.singular : labels.plural}`;
const truncate = (s, n) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
const slugify = (t) => t.toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 64).replace(/-+$/, '');
const streamPath = (s = state.current) => `/api/streams/${encodeURIComponent(s.slug)}`;

function setUrl() {
  const url = new URL(location);
  if (state.current) url.searchParams.set('stream', state.current.slug);
  else url.searchParams.delete('stream');
  if (state.tab !== 'items') url.searchParams.set('tab', state.tab);
  else url.searchParams.delete('tab');
  history.replaceState(null, '', url);
}

/** A human-readable name for an item: its title/name-like field, else the first text field, else #seq. */
function itemLabel(stream, item) {
  if (!item) return '—';
  const fields = stream?.fields || [];
  const preferred = ['title', 'name', 'label', 'heading', 'subject'];
  const field = fields.find((f) => preferred.includes(f.name.toLowerCase()) && typeof item.data?.[f.name] === 'string')
    || fields.find((f) => ['string', 'uid', 'email'].includes(f.type) && typeof item.data?.[f.name] === 'string' && item.data[f.name]);
  return field ? truncate(item.data[field.name], 60) : `#${item.seq}`;
}
/** Finds "lat, lng" in pasted text: Google Maps (@lat,lng / q=lat,lng), OpenStreetMap (mlat/mlon, #map=z/lat/lng) or plain. */
function parseCoordinates(text) {
  const t = String(text);
  const osm = /mlat=(-?\d+(?:\.\d+)?).*?mlon=(-?\d+(?:\.\d+)?)/.exec(t) || /#map=\d+\/(-?\d+(?:\.\d+)?)\/(-?\d+(?:\.\d+)?)/.exec(t);
  const m = osm || /(-?\d{1,2}(?:\.\d+)?)\s*,\s*(-?\d{1,3}(?:\.\d+)?)/.exec(t);
  if (!m) return null;
  const lat = Number(m[1]);
  const lng = Number(m[2]);
  return Math.abs(lat) <= 90 && Math.abs(lng) <= 180 ? { lat, lng } : null;
}
const streamBySlug = (slug) => state.streams.find((s) => s.slug === slug);
const itemStatus = (item) => (item.publishedAt ? 'published' : item.publishAt ? 'scheduled' : 'draft');

function preview(value, type, field) {
  if (value === null || value === undefined || (Array.isArray(value) && !value.length)) return h('span', { class: 'muted' }, '—');
  if (type === 'boolean' || typeof value === 'boolean') return h('span', { class: `pill ${value ? 'on' : ''}` }, value ? 'true' : 'false');
  if (type === 'datetime') return formatDate(value);
  if (type === 'enum') return h('span', { class: 'pill' }, value);
  if (type === 'tags') return h('span', { class: 'tag-list' }, value.slice(0, 4).map((t) => h('span', { class: 'pill' }, t)), value.length > 4 ? ` +${value.length - 4}` : null);
  if (type === 'media') return typeof value === 'object' ? h('span', { class: 'pill rel', title: value.name }, truncate(value.name, 24)) : h('code', { class: 'small' }, `${value.slice(0, 8)}…`);
  if (type === 'date') return new Date(`${value}T00:00:00`).toLocaleDateString(undefined, { dateStyle: 'medium' });
  if (type === 'geopoint') return h('span', { title: `${value.lat}, ${value.lng}` }, '📍 ', value.label || `${value.lat.toFixed(4)}, ${value.lng.toFixed(4)}`);
  if (type === 'relation') {
    const target = streamBySlug(field?.target);
    const list = (Array.isArray(value) ? value : [value]).filter(Boolean);
    if (!list.length) return h('span', { class: 'muted' }, '—');
    return h('span', { class: 'tag-list' }, list.slice(0, 3).map((v) => h('span', { class: 'pill rel' }, typeof v === 'object' ? itemLabel(target, v) : `${v.slice(0, 8)}…`)),
      list.length > 3 ? ` +${list.length - 3}` : null);
  }
  if (type === 'uid') return h('code', { class: 'small' }, truncate(value, 40));
  if (type === 'richtext') return truncate(value.replace(/[#*_`>\[\]()!-]+/g, ' ').replace(/\s+/g, ' ').trim(), 80);
  if (typeof value === 'object') return h('code', { class: 'small' }, truncate(JSON.stringify(value), 80));
  return truncate(String(value), 80);
}

// ---- field builder ---------------------------------------------------------

/** Editable list of field definitions. Returns { el, getFields(), setFields() }. */
function fieldBuilder(initial = [], builderSelf = null) {
  const list = h('div', { class: 'field-rows' });
  const empty = h('p', { class: 'muted small field-empty' }, 'No fields — this stream accepts any JSON object.');
  const sync = () => { empty.hidden = list.children.length > 0; };

  function addRow(field = { name: '', type: 'string', required: false }) {
    const typeSel = h('select', { 'aria-label': 'Field type' },
      FIELD_TYPES.map(([v, label]) => h('option', { value: v, selected: v === field.type }, label)));
    const name = h('input', { value: field.name, placeholder: 'fieldName', 'aria-label': 'Field name', maxlength: 64 });
    const required = h('input', { type: 'checkbox', checked: field.required });
    const extras = h('div', { class: 'field-extras' });

    const renderExtras = () => {
      const t = typeSel.value;
      const sameType = t === field.type;
      extras.replaceChildren();
      if (t === 'enum') {
        extras.append(h('input', { 'data-k': 'options', placeholder: 'Options, comma separated', value: (field.options || []).join(', '), 'aria-label': 'Enum options' }));
      } else if (t === 'integer' || t === 'number') {
        extras.append(
          h('input', { 'data-k': 'min', type: 'number', step: 'any', placeholder: 'Min', value: sameType ? field.min ?? '' : '', 'aria-label': 'Minimum' }),
          h('input', { 'data-k': 'max', type: 'number', step: 'any', placeholder: 'Max', value: sameType ? field.max ?? '' : '', 'aria-label': 'Maximum' }));
      } else if (t === 'relation') {
        const targets = state.streams.filter((x) => !builderSelf || x.slug !== builderSelf);
        extras.append(
          h('select', { 'data-k': 'target', 'aria-label': 'Related stream' },
            h('option', { value: '' }, 'Related stream…'),
            builderSelf ? h('option', { value: builderSelf, selected: field.target === builderSelf }, 'This stream') : null,
            targets.map((x) => h('option', { value: x.slug, selected: x.slug === field.target }, x.name))),
          h('label', { class: 'req', title: 'Allow several related items' },
            h('input', { type: 'checkbox', 'data-k': 'multiple', checked: Boolean(field.multiple) }), 'Many'));
      } else if (t === 'uid') {
        extras.append(h('input', { 'data-k': 'targetField', placeholder: 'Generate from field (e.g. title)', value: field.targetField || '', 'aria-label': 'Generate from field' }));
      } else if (t in DEFAULT_MAX) {
        const custom = sameType && field.maxLength && field.maxLength !== DEFAULT_MAX[t] ? field.maxLength : '';
        extras.append(h('input', { 'data-k': 'maxLength', type: 'number', min: 1, placeholder: `Max length (${DEFAULT_MAX[t].toLocaleString()})`, value: custom, 'aria-label': 'Max length' }));
      }
      if (UNIQUE_CAPABLE.has(t)) {
        extras.append(h('label', { class: 'req', title: 'No two items may share a value' },
          h('input', { type: 'checkbox', 'data-k': 'unique', checked: Boolean(field.unique) }), 'Unique'));
      }
    };
    typeSel.addEventListener('change', renderExtras);
    renderExtras();

    const move = (dir) => {
      const sib = dir < 0 ? row.previousElementSibling : row.nextElementSibling;
      if (sib) dir < 0 ? sib.before(row) : sib.after(row);
    };
    const row = h('div', { class: 'field-row' },
      name, typeSel,
      h('label', { class: 'req', title: 'Required' }, required, 'Required'),
      extras,
      h('div', { class: 'row-actions' },
        h('button', { type: 'button', class: 'icon-btn', 'aria-label': 'Move up', onclick: () => move(-1) }, '↑'),
        h('button', { type: 'button', class: 'icon-btn', 'aria-label': 'Move down', onclick: () => move(1) }, '↓'),
        h('button', { type: 'button', class: 'icon-btn', 'aria-label': 'Remove field', onclick: () => { row.remove(); sync(); } }, '✕')));
    row._get = () => {
      const f = { name: name.value.trim(), type: typeSel.value, required: required.checked };
      if (field.description) f.description = field.description;
      for (const input of extras.querySelectorAll('[data-k]')) {
        const k = input.dataset.k;
        if (input.type === 'checkbox') { if (input.checked) f[k] = true; continue; }
        if (input.value === '') continue;
        if (k === 'options') f[k] = input.value.split(',').map((o) => o.trim()).filter(Boolean);
        else if (k === 'targetField' || k === 'target') f[k] = input.value.trim();
        else f[k] = Number(input.value);
      }
      return f;
    };
    list.append(row);
    sync();
    return row;
  }

  const setFields = (fields) => {
    list.replaceChildren();
    for (const f of fields) addRow(f);
    sync();
  };
  setFields(initial);
  const el = h('div', { class: 'field-builder' },
    empty, list,
    h('button', { type: 'button', class: 'btn btn-secondary btn-sm', onclick: () => addRow().querySelector('input').focus() }, '+ Add field'));
  return { el, getFields: () => [...list.children].map((r) => r._get()), setFields };
}

// ---- stream list -----------------------------------------------------------

async function loadStreams() {
  const { data } = await api('/api/streams?pageSize=500');
  state.streams = data;
  if (state.current) state.current = data.find((s) => s.id === state.current.id) || null;
  renderStreamList();
  const n = data.length;
  $('#summary').textContent = `${n} stream${n === 1 ? '' : 's'}`;
  $('#noStreams').hidden = n > 0;
  $('#detail').hidden = !state.current;
  $('.stream-list').hidden = n === 0;
}

function renderStreamList() {
  const q = state.q.toLowerCase();
  const items = state.streams.filter((s) => !q || s.name.toLowerCase().includes(q) || s.slug.includes(q));
  $('#streamList').replaceChildren(...items.map((s) => h('li', {},
    h('button', {
      class: `stream-item${state.current?.id === s.id ? ' active' : ''}`,
      onclick: () => selectStream(s.slug),
    },
    h('span', { class: 'stream-name' }, s.name, s.draftAndPublish ? h('span', { class: 'type-tag' }, 'drafts') : null),
    h('span', { class: 'stream-sub' }, `/${s.slug}`),
    h('span', { class: 'stream-sub' },
      plural(s.itemCount, s.labels),
      s.draftCount ? ` · ${s.draftCount} draft${s.draftCount === 1 ? '' : 's'}` : '',
      ` · ${s.fields.length ? `${s.fields.length} field${s.fields.length === 1 ? '' : 's'}` : 'any JSON'}`)))));
  if (!items.length && state.streams.length) $('#streamList').append(h('li', { class: 'muted small', style: 'padding:8px' }, 'No matching streams'));
}

async function selectStream(slug, tab = state.tab) {
  const stream = state.streams.find((s) => s.slug === slug);
  if (!stream) return;
  const changed = state.current?.id !== stream.id;
  state.current = stream;
  if (changed) {
    state.page = 1;
    state.filter = null;
    state.sort = 'timestamp:desc';
    state.status = 'all';
  }
  renderStreamList();
  renderDetail();
  selectTab(tab === 'events' ? 'items' : tab);
  if (changed) connectLive();
}

// ---- detail ----------------------------------------------------------------

function renderDetail() {
  const s = state.current;
  $('#detail').hidden = false;
  $('#detailName').textContent = s.name;
  $('#detailDescription').textContent = s.description || '';
  $('#detailDescription').hidden = !s.description;
  $('#detailEndpoint').textContent = `/api/streams/${s.slug}`;
  $('#itemsTab').textContent = capitalize(s.labels.plural);
  $('#newItemLabel').textContent = `New ${s.labels.singular}`;
  $('#statusFilter').hidden = !s.draftAndPublish;
  $('#statusFilter').value = state.status;

  const fieldSel = $('#filterField');
  const options = s.fields.length ? s.fields.map((f) => f.name) : [...new Set(state.items.flatMap((e) => Object.keys(e.data || {})))];
  fieldSel.replaceChildren(h('option', { value: '' }, 'Filter by field…'), ...options.map((n) => h('option', { value: n }, n)));
  if (state.filter) {
    fieldSel.value = state.filter.field;
    $('#filterOp').value = state.filter.op;
    $('#filterValue').value = state.filter.value;
  } else {
    $('#filterValue').value = '';
  }
  $('#clearFilter').hidden = !state.filter;
}

function selectTab(tab) {
  if (!['items', 'dataset', 'settings', 'embed', 'api'].includes(tab)) tab = 'items';
  state.tab = tab;
  for (const b of document.querySelectorAll('[role=tab]')) b.setAttribute('aria-selected', String(b.dataset.tab === tab));
  for (const p of document.querySelectorAll('.tab-panel')) p.hidden = p.dataset.panel !== tab;
  if (tab === 'items') loadItems();
  if (tab === 'dataset') renderDataset();
  if (tab === 'settings') renderSettings();
  if (tab === 'api') renderApiDocs();
  if (tab === 'embed') renderEmbed($('#embedPanel'), { stream: state.current, config: state.config });
  setUrl();
}

// ---- items tab -------------------------------------------------------------

async function loadItems() {
  const s = state.current;
  if (!s) return;
  const params = new URLSearchParams({ page: state.page, pageSize: state.pageSize, sort: state.sort });
  if (s.fields.some((f) => f.type === 'relation')) params.set('populate', '*');
  if (s.draftAndPublish) params.set('status', state.status);
  if (state.filter) {
    const { field, op, value } = state.filter;
    params.set(op === 'eq' ? `filter[${field}]` : `filter[${field}][${op}]`, value);
  }
  try {
    const { data, meta } = await api(`${streamPath(s)}/items?${params}`);
    if (state.page > meta.pagination.pageCount) {
      state.page = meta.pagination.pageCount;
      return loadItems();
    }
    state.items = data;
    state.pagination = meta.pagination;
    renderItems();
    if (!s.fields.length) renderDetail(); // refresh schema-less filter options
  } catch (err) {
    toast(err.message, 'error');
  }
}

function columns() {
  const s = state.current;
  if (s.fields.length) return s.fields.slice(0, MAX_COLUMNS).map((f) => ({ key: f.name, label: f.name, type: f.type, field: f }));
  return [{ key: null, label: 'data', type: 'json' }];
}

function statusPill(item) {
  const status = itemStatus(item);
  if (status === 'published') {
    return h('span', { class: 'status-pill published', title: item.unpublishAt ? `Unpublishes ${formatDate(item.unpublishAt)}` : '' },
      'Published', item.unpublishAt ? ' ⏲' : '');
  }
  if (status === 'scheduled') return h('span', { class: 'status-pill scheduled', title: `Publishes ${formatDate(item.publishAt)}` }, `Scheduled · ${formatDate(item.publishAt)}`);
  return h('span', { class: `status-pill draft${item.scheduleError ? ' warn' : ''}`, title: item.scheduleError || '' }, item.scheduleError ? 'Draft ⚠' : 'Draft');
}

function renderItems() {
  const s = state.current;
  const cols = columns();
  const sortable = (label, key) => {
    const [cur, dir] = state.sort.split(':');
    const active = cur === key;
    return h('th', {},
      h('button', {
        class: `th-sort${active ? ' active' : ''}`,
        onclick: () => { state.sort = `${key}:${active && dir === 'desc' ? 'asc' : 'desc'}`; state.page = 1; loadItems(); },
      }, label, active ? (dir === 'desc' ? ' ↓' : ' ↑') : ''));
  };
  $('#eventsHead').replaceChildren(h('tr', {},
    sortable('#', 'seq'),
    sortable('Timestamp', 'timestamp'),
    s.draftAndPublish ? h('th', {}, 'Status') : null,
    cols.map((c) => (c.key && !['json', 'tags', 'relation'].includes(c.type) ? sortable(c.label, `data.${c.key}`) : h('th', {}, c.label))),
    s.fields.length > MAX_COLUMNS ? h('th', { class: 'muted' }, `+${s.fields.length - MAX_COLUMNS} more`) : null));

  $('#eventsBody').replaceChildren(...state.items.map((item) => h('tr', {
    tabindex: 0,
    onclick: () => openItem(item),
    onkeydown: (ev) => ev.key === 'Enter' && openItem(item),
  },
  h('td', { class: 'muted' }, item.seq),
  h('td', { class: 'nowrap' }, formatDate(item.timestamp)),
  s.draftAndPublish ? h('td', {}, statusPill(item)) : null,
  cols.map((c) => h('td', {}, preview(c.key ? item.data?.[c.key] : item.data, c.type, c.field))),
  s.fields.length > MAX_COLUMNS ? h('td', {}) : null)));

  const empty = state.items.length === 0;
  $('.table-wrap').hidden = empty;
  $('#eventsEmpty').hidden = !empty;
  $('#eventsEmptyText').textContent = state.filter || state.status !== 'all'
    ? `No ${s.labels.plural} match.`
    : `No ${s.labels.plural} yet. Post one from the API tab or click “New ${s.labels.singular}”.`;
  renderPagination();
}

function renderPagination() {
  const s = state.current;
  const { page, pageCount, total } = state.pagination;
  const btn = (label, target, disabled, aria) => h('button', {
    class: 'page-btn', disabled, 'aria-label': aria,
    onclick: () => { state.page = target; loadItems(); },
  }, label);
  $('#eventsPagination').replaceChildren(
    h('span', { class: 'muted' }, plural(total, s.labels), state.filter ? ' match' : ''),
    h('div', { class: 'pages' },
      btn('‹', page - 1, page === 1, 'Previous page'),
      h('span', { class: 'page-btn active' }, `${page} / ${pageCount}`),
      btn('›', page + 1, page === pageCount, 'Next page')));
}

function connectLive() {
  state.source?.close();
  state.source = null;
  const dot = $('#liveDot');
  dot.className = 'live-dot';
  if (!$('#liveToggle').checked || !state.current) return;
  // EventSource can't send headers, so editors pass the token as a query param to see drafts.
  const token = getToken();
  const src = new EventSource(`${streamPath()}/subscribe${token ? `?access_token=${encodeURIComponent(token)}` : ''}`);
  state.source = src;
  const refresh = debounce(async () => {
    await loadStreams();
    if (state.tab === 'items') loadItems();
  }, 300);
  src.onopen = () => { dot.className = 'live-dot on'; };
  src.onerror = () => { dot.className = 'live-dot err'; };
  for (const type of ['created', 'updated', 'deleted', 'published', 'unpublished', 'stream-updated']) src.addEventListener(type, refresh);
  src.addEventListener('stream-deleted', () => {
    toast('This stream was deleted', 'error');
    state.current = null;
    src.close();
    loadStreams();
  });
}

// ---- item dialog -----------------------------------------------------------

async function mediaOptions() {
  if (!state.media) {
    try {
      state.media = (await api('/api/upload/files?pageSize=100&sort=createdAt:desc')).data;
    } catch {
      state.media = [];
    }
  }
  return state.media;
}

async function relatedItems(slug) {
  if (!state.related.has(slug)) {
    try {
      const target = streamBySlug(slug);
      const status = target?.draftAndPublish ? '&status=all' : '';
      state.related.set(slug, (await api(`/api/streams/${encodeURIComponent(slug)}/items?pageSize=500&sort=timestamp:desc${status}`)).data);
    } catch {
      state.related.set(slug, []);
    }
  }
  return state.related.get(slug);
}

async function itemInput(field, value, form) {
  const common = { name: `f:${field.name}`, 'data-type': field.type, required: field.required };
  switch (field.type) {
    case 'text':
      return h('textarea', { ...common, rows: 3, maxlength: field.maxLength }, value ?? '');
    case 'richtext':
      return h('textarea', { ...common, rows: 10, class: 'mono', maxlength: field.maxLength, placeholder: '# Heading\n\nWrite **Markdown** here…' }, value ?? '');
    case 'integer':
    case 'number':
      return h('input', { ...common, type: 'number', step: field.type === 'integer' ? 1 : 'any', min: field.min, max: field.max, value: value ?? '' });
    case 'email':
      return h('input', { ...common, type: 'email', value: value ?? '' });
    case 'url':
      return h('input', { ...common, type: 'url', placeholder: 'https://', value: value ?? '' });
    case 'boolean':
      return h('select', common,
        h('option', { value: '' }, '—'),
        h('option', { value: 'true', selected: value === true }, 'true'),
        h('option', { value: 'false', selected: value === false }, 'false'));
    case 'datetime':
      return h('input', { ...common, type: 'datetime-local', step: 1, value: toLocalInput(value) });
    case 'enum':
      return h('select', common, h('option', { value: '' }, '—'),
        field.options.map((o) => h('option', { value: o, selected: o === value }, o)));
    case 'tags':
      return h('input', { ...common, placeholder: 'Comma separated, e.g. news, launch', value: (value || []).join(', ') });
    case 'json':
      return h('textarea', { ...common, rows: 4, class: 'mono', placeholder: '{ }' }, value == null ? '' : JSON.stringify(value, null, 2));
    case 'uid': {
      const input = h('input', { ...common, value: value ?? '', placeholder: field.targetField ? `Generated from ${field.targetField} if blank` : 'my-item' });
      if (!field.targetField) return input;
      return h('div', { class: 'input-with-btn' }, input,
        h('button', {
          type: 'button', class: 'btn btn-secondary btn-sm',
          onclick: () => { input.value = slugify(form.elements[`f:${field.targetField}`]?.value || ''); },
        }, 'Generate'));
    }
    case 'relation': {
      const target = streamBySlug(field.target);
      const items = await relatedItems(field.target);
      const label = (it) => `${itemLabel(target, it)}${target?.draftAndPublish && !it.publishedAt ? ' (draft)' : ''}`;
      const ids = (Array.isArray(value) ? value : value ? [value] : []).map((v) => (typeof v === 'object' ? v.id : v));
      if (!field.multiple) {
        const sel = h('select', common, h('option', { value: '' }, '—'),
          items.map((it) => h('option', { value: it.id, selected: ids.includes(it.id) }, label(it))));
        return sel;
      }
      const search = h('input', { type: 'search', class: 'rel-search', placeholder: `Search ${target?.labels.plural || 'items'}…`, 'aria-label': 'Search related items' });
      const options = items.map((it) => h('label', { class: 'rel-option', 'data-label': label(it).toLowerCase() },
        h('input', { type: 'checkbox', name: common.name, value: it.id, checked: ids.includes(it.id) }), label(it)));
      search.addEventListener('input', () => {
        const q = search.value.toLowerCase();
        for (const o of options) o.hidden = q && !o.dataset.label.includes(q) && !o.querySelector('input').checked;
      });
      return h('div', { class: 'rel-picker', 'data-relation': field.name },
        items.length > 8 ? search : null,
        h('div', { class: 'rel-options' }, options.length ? options : h('span', { class: 'muted small' }, `No ${target?.labels.plural || 'items'} yet`)));
    }
    case 'date':
      return h('input', { ...common, type: 'date', value: value ?? '' });
    case 'geopoint': {
      const p = value || {};
      const lat = h('input', { name: `${common.name}.lat`, type: 'number', step: 'any', min: -90, max: 90, placeholder: 'Latitude', value: p.lat ?? '', 'aria-label': `${field.name} latitude` });
      const lng = h('input', { name: `${common.name}.lng`, type: 'number', step: 'any', min: -180, max: 180, placeholder: 'Longitude', value: p.lng ?? '', 'aria-label': `${field.name} longitude` });
      const label = h('input', { name: `${common.name}.label`, maxlength: 200, placeholder: 'Label (optional)', value: p.label ?? '', 'aria-label': `${field.name} label` });
      const paste = h('input', {
        placeholder: 'Or paste a map link / "lat, lng"', 'aria-label': 'Paste a map link or coordinates',
        oninput: (e) => {
          const found = parseCoordinates(e.target.value);
          if (found) {
            lat.value = found.lat;
            lng.value = found.lng;
            e.target.value = '';
            toast(`Pin set to ${found.lat}, ${found.lng}`);
          }
        },
      });
      const open = h('a', { class: 'btn btn-ghost btn-sm', target: '_blank', rel: 'noopener', onclick: (e) => {
        if (!lat.value || !lng.value) { e.preventDefault(); return toast('Enter coordinates first', 'error'); }
        e.currentTarget.href = `https://www.openstreetmap.org/?mlat=${lat.value}&mlon=${lng.value}#map=15/${lat.value}/${lng.value}`;
      } }, 'View on map ↗');
      return h('div', { class: 'geo-input' }, h('div', { class: 'geo-row' }, lat, lng, label), h('div', { class: 'geo-row' }, paste, open));
    }
    case 'media': {
      if (value && typeof value === 'object') value = value.id;
      const files = await mediaOptions();
      const sel = h('select', common, h('option', { value: '' }, '—'),
        files.map((f) => h('option', { value: f.id, selected: f.id === value }, f.name)));
      if (value && !files.some((f) => f.id === value)) sel.append(h('option', { value, selected: true }, value));
      return sel;
    }
    default:
      return h('input', { ...common, maxlength: field.maxLength, value: value ?? '' });
  }
}

async function openItem(item = null) {
  const s = state.current;
  const dp = s.draftAndPublish;
  state.editing = item;
  const form = $('#eventForm');
  $('#eventDialogTitle').textContent = item ? `${capitalize(s.labels.singular)} #${item.seq}` : `New ${s.labels.singular}`;
  $('#deleteEvent').hidden = !item;
  $('#saveEvent').textContent = dp ? (item?.publishedAt ? 'Save' : 'Save draft') : (item ? 'Save changes' : `Create ${s.labels.singular}`);
  $('#saveEvent').className = `btn ${dp ? 'btn-secondary' : 'btn-primary'}`;
  state.related.clear(); // pick up related items created since last time
  $('#publishEvent').hidden = !dp || Boolean(item?.publishedAt);
  $('#publishEvent').textContent = item ? 'Save & publish' : 'Publish';
  $('#unpublishEvent').hidden = !dp || !item?.publishedAt;
  const status = $('#itemStatus');
  status.hidden = !dp || !item;
  if (dp && item) {
    const st = itemStatus(item);
    status.className = `status-pill ${st}`;
    status.textContent = capitalize(st);
  }
  $('#scheduleFields').hidden = !dp;
  form.publishAt.value = toLocalInput(item?.publishAt);
  form.unpublishAt.value = toLocalInput(item?.unpublishAt);
  form.publishAt.dataset.initial = form.publishAt.value;
  form.unpublishAt.dataset.initial = form.unpublishAt.value;
  form.publishAt.disabled = Boolean(item?.publishedAt); // already live: only unpublishAt applies
  $('#scheduleError').hidden = !item?.scheduleError;
  $('#scheduleError').textContent = item?.scheduleError || '';
  updateSaveLabel();

  form.timestamp.value = item ? toLocalInput(item.timestamp) : '';
  form.timestamp.dataset.initial = form.timestamp.value; // input is second-precision; only send if edited

  const meta = $('#eventMeta');
  meta.hidden = !item;
  if (item) {
    meta.replaceChildren(...[
      ['ID', item.id], ['Sequence', item.seq], ['Created', formatDate(item.createdAt)], ['Updated', formatDate(item.updatedAt)],
      ...(dp ? [['Published', item.publishedAt ? formatDate(item.publishedAt) : 'Not published']] : []),
    ].map(([k, v]) => h('div', {}, h('dt', {}, k), h('dd', {}, v))));
  }

  const container = $('#eventFields');
  if (s.fields.length) {
    const rows = [];
    for (const f of s.fields) {
      rows.push(h('label', {},
        h('span', {}, f.name, f.required ? h('span', { class: 'req-mark', title: dp ? 'Required to publish' : 'Required' }, ' *') : null,
          h('span', { class: 'type-tag' }, FIELD_TYPES.find(([t]) => t === f.type)?.[1] || f.type),
          f.unique ? h('span', { class: 'type-tag' }, 'unique') : null),
        await itemInput(f, item?.data?.[f.name], form),
        f.description ? h('span', { class: 'hint' }, f.description) : null));
    }
    container.replaceChildren(...rows);
  } else {
    container.replaceChildren(h('label', {}, 'Data (JSON object)',
      h('textarea', { name: '__json', rows: 10, class: 'mono', placeholder: '{\n  "key": "value"\n}' }, item ? JSON.stringify(item.data, null, 2) : '')));
  }
  $('#eventDialog').showModal();
}

function readItemForm() {
  const s = state.current;
  const form = $('#eventForm');
  if (!s.fields.length) {
    const raw = form.__json.value.trim() || '{}';
    try {
      return JSON.parse(raw);
    } catch {
      throw new Error('Data must be valid JSON');
    }
  }
  const data = {};
  for (const f of s.fields) {
    if (f.type === 'relation' && f.multiple) {
      data[f.name] = [...form.querySelectorAll(`input[type=checkbox][name="f:${f.name}"]:checked`)].map((i) => i.value);
      continue;
    }
    if (f.type === 'geopoint') {
      const get = (k) => form.elements[`f:${f.name}.${k}`].value.trim();
      const [lat, lng, label] = [get('lat'), get('lng'), get('label')];
      data[f.name] = lat === '' && lng === '' ? null : { lat: lat === '' ? null : Number(lat), lng: lng === '' ? null : Number(lng), ...(label ? { label } : {}) };
      continue;
    }
    const el = form.elements[`f:${f.name}`];
    const v = el.value.trim();
    if (f.type === 'tags') { data[f.name] = v.split(',').map((t) => t.trim()).filter(Boolean); continue; }
    if (v === '') { data[f.name] = null; continue; }
    if (f.type === 'integer' || f.type === 'number') data[f.name] = Number(v);
    else if (f.type === 'boolean') data[f.name] = v === 'true';
    else if (f.type === 'datetime') data[f.name] = fromLocalInput(v);
    else if (f.type === 'json') {
      try { data[f.name] = JSON.parse(v); } catch { throw new Error(`${f.name} must be valid JSON`); }
    } else if (['string', 'uid', 'email', 'url', 'relation', 'date', 'media'].includes(f.type)) data[f.name] = v;
    else data[f.name] = el.value; // keep inner whitespace for text / richtext
  }
  return data;
}

/** mode: 'save' | 'publish' | 'unpublish' */
async function saveItem(mode) {
  const s = state.current;
  const body = {};
  try {
    body.data = readItemForm();
  } catch (err) {
    return toast(err.message, 'error');
  }
  const tsInput = $('#eventForm').timestamp;
  if (tsInput.value && tsInput.value !== tsInput.dataset.initial) body.timestamp = fromLocalInput(tsInput.value);
  if (s.draftAndPublish && mode !== 'save') body.publish = mode === 'publish';
  if (s.draftAndPublish && mode === 'save' && !state.editing) body.publish = false;
  if (s.draftAndPublish) {
    const form = $('#eventForm');
    for (const key of ['publishAt', 'unpublishAt']) {
      const input = form[key];
      if (input.disabled || input.value === input.dataset.initial) continue;
      body[key] = input.value ? fromLocalInput(input.value) : null;
    }
    // "Publish now" overrides a pending schedule rather than conflicting with it.
    if (mode === 'publish') delete body.publishAt;
  }

  const label = s.labels.singular;
  try {
    if (state.editing) await api(`${streamPath(s)}/items/${state.editing.id}`, { method: 'PUT', json: body });
    else await api(`${streamPath(s)}/items`, { method: 'POST', json: body });
    $('#eventDialog').close();
    const scheduled = body.publishAt && mode === 'save';
    const verb = mode === 'publish' ? 'published' : mode === 'unpublish' ? 'unpublished' : scheduled ? `scheduled for ${formatDate(body.publishAt)}` : state.editing ? 'saved' : s.draftAndPublish ? 'saved as draft' : 'created';
    toast(`${capitalize(label)} ${verb}`);
    await loadStreams();
    loadItems();
  } catch (err) {
    toast(err.message, 'error');
  }
}

async function deleteItem() {
  const item = state.editing;
  const label = state.current.labels.singular;
  if (!item || !confirm(`Delete ${label} #${item.seq}? This cannot be undone.`)) return;
  try {
    await api(`${streamPath()}/items/${item.id}`, { method: 'DELETE' });
    $('#eventDialog').close();
    toast(`${capitalize(label)} deleted`);
    await loadStreams();
    loadItems();
  } catch (err) {
    toast(err.message, 'error');
  }
}

/** "Save draft" becomes "Schedule" when a publish time is filled in. */
function updateSaveLabel() {
  const s = state.current;
  const form = $('#eventForm');
  if (!s?.draftAndPublish) return;
  const item = state.editing;
  if (item?.publishedAt) $('#saveEvent').textContent = 'Save';
  else $('#saveEvent').textContent = form.publishAt.value ? 'Schedule' : 'Save draft';
}

// ---- dataset tab -----------------------------------------------------------

let datasetBuilder = null;

function renderDataset() {
  const s = state.current;
  const form = $('#datasetForm');
  form.name.value = s.name;
  form.slug.value = s.slug;
  form.description.value = s.description || '';
  datasetBuilder = fieldBuilder(s.fields, s.slug);
  $('#datasetFields').replaceChildren(datasetBuilder.el);
}

async function saveDataset(e) {
  e.preventDefault();
  const form = $('#datasetForm');
  try {
    await api(streamPath(), {
      method: 'PATCH',
      json: { name: form.name.value, description: form.description.value, fields: datasetBuilder.getFields() },
    });
    toast('Dataset saved');
    await loadStreams();
    renderDetail();
    renderDataset();
  } catch (err) {
    toast(err.message, 'error');
  }
}

// ---- settings tab ----------------------------------------------------------

function webhookRow(hook = { url: '', events: [...WEBHOOK_EVENTS], enabled: true }) {
  const url = h('input', { type: 'url', placeholder: 'https://example.com/hooks/stream', value: hook.url, 'aria-label': 'Webhook URL', required: true });
  const enabled = h('input', { type: 'checkbox', checked: hook.enabled !== false });
  const events = WEBHOOK_EVENTS.map((ev) => h('label', { class: 'chip' },
    h('input', { type: 'checkbox', value: ev, checked: hook.events.includes(ev) }), ev));
  let rotate = false;

  const last = hook.lastDelivery;
  const status = h('span', { class: `small ${last ? (last.ok ? 'ok-text' : 'err-text') : 'muted'}` },
    last ? `Last delivery ${last.ok ? 'succeeded' : 'failed'} (${last.status ?? last.error}${last.attempts > 1 ? `, ${last.attempts} attempts` : ''}) · ${formatDate(last.at)}` : hook.id ? 'No deliveries yet' : 'Save to activate');

  const secretRow = hook.id
    ? h('div', { class: 'secret-row' },
      h('span', { class: 'small muted' }, 'Signing secret'),
      h('code', { class: 'small secret' }, `${hook.secret.slice(0, 6)}…${hook.secret.slice(-4)}`),
      h('button', { type: 'button', class: 'btn btn-ghost btn-sm', onclick: () => copyText(hook.secret) }, 'Copy'),
      h('button', {
        type: 'button', class: 'btn btn-ghost btn-sm',
        onclick: (e) => { rotate = true; e.target.textContent = 'Rotates on save'; e.target.disabled = true; },
      }, 'Rotate'),
      h('button', {
        type: 'button', class: 'btn btn-secondary btn-sm',
        onclick: async () => {
          try {
            const r = await api(`${streamPath()}/webhooks/${hook.id}/test`, { method: 'POST' });
            toast(r.ok ? `Test delivered (HTTP ${r.status})` : `Test failed: ${r.status ?? r.error}`, r.ok ? 'success' : 'error');
            await loadStreams();
            renderSettings();
          } catch (err) {
            toast(err.message, 'error');
          }
        },
      }, 'Send test'))
    : null;

  const row = h('div', { class: 'webhook' },
    h('div', { class: 'webhook-top' },
      url,
      h('label', { class: 'req' }, enabled, 'Enabled'),
      h('button', { type: 'button', class: 'icon-btn', 'aria-label': 'Remove webhook', onclick: () => row.remove() }, '✕')),
    h('div', { class: 'chips' }, events),
    secretRow,
    status);
  row._get = () => ({
    ...(hook.id ? { id: hook.id } : {}),
    url: url.value.trim(),
    enabled: enabled.checked,
    events: events.map((c) => c.querySelector('input')).filter((i) => i.checked).map((i) => i.value),
    ...(rotate ? { rotateSecret: true } : {}),
  });
  return row;
}

function renderKeys() {
  const s = state.current;
  const keys = s.apiKeys || [];
  $('#keyList').replaceChildren(...(keys.length ? keys.map((k) => {
    const expired = k.expiresAt && k.expiresAt <= new Date().toISOString();
    return h('div', { class: `key-row${expired ? ' expired' : ''}` },
      h('div', { class: 'key-main' },
        h('strong', {}, k.name),
        h('code', { class: 'small' }, `${k.prefix}…`),
        h('span', { class: 'tag-list' }, k.scopes.map((sc) => h('span', { class: 'pill' }, sc)))),
      h('span', { class: 'small muted' },
        `Created ${formatDate(k.createdAt)} · ${k.lastUsedAt ? `last used ${formatDate(k.lastUsedAt)}` : 'never used'}`,
        k.expiresAt ? ` · ${expired ? 'expired' : 'expires'} ${formatDate(k.expiresAt)}` : ''),
      h('button', {
        type: 'button', class: 'btn btn-danger btn-sm',
        onclick: async () => {
          if (!confirm(`Revoke the key “${k.name}”? Anything using it stops working immediately.`)) return;
          try {
            await api(`${streamPath()}/keys/${k.id}`, { method: 'DELETE' });
            toast('Key revoked');
            await loadStreams();
            renderKeys();
          } catch (err) {
            toast(err.message, 'error');
          }
        },
      }, 'Revoke'));
  }) : [h('p', { class: 'muted small' }, 'No keys yet.')]));
}

async function createKey(e) {
  e.preventDefault();
  const form = $('#keyForm');
  const scopes = [...form.querySelectorAll('input[type=checkbox]:checked')].map((i) => i.value);
  if (!scopes.length) return toast('Choose at least one permission', 'error');
  const json = { name: form.name.value, scopes };
  if (form.expires.value) json.expiresAt = new Date(`${form.expires.value}T23:59:59`).toISOString();
  try {
    const created = await api(`${streamPath()}/keys`, { method: 'POST', json });
    $('#keyValue').textContent = created.key;
    $('#keyReveal').hidden = false;
    form.reset();
    toast('Key created');
    await loadStreams();
    renderKeys();
  } catch (err) {
    toast(err.message, 'error');
  }
}

function renderSettings() {
  renderKeys();
  $('#keyReveal').hidden = true;
  $('#keyValue').textContent = '';
  const s = state.current;
  const form = $('#settingsForm');
  form.singular.value = s.labels.singular;
  form.plural.value = s.labels.plural;
  form.draftAndPublish.checked = s.draftAndPublish;
  form.maxItems.value = s.retention.maxItems ?? '';
  form.maxAgeDays.value = s.retention.maxAgeDays ?? '';
  form.schemaType.value = s.schemaType || '';
  $('#webhookList').replaceChildren(...(s.webhooks || []).map((w) => webhookRow(w)));
}

async function saveSettings(e) {
  e.preventDefault();
  const s = state.current;
  const form = $('#settingsForm');
  const num = (v) => (v === '' ? null : Number(v));
  const json = {
    labels: { singular: form.singular.value, plural: form.plural.value },
    draftAndPublish: form.draftAndPublish.checked,
    retention: { maxItems: num(form.maxItems.value), maxAgeDays: num(form.maxAgeDays.value) },
    schemaType: form.schemaType.value.trim() || null,
    webhooks: [...$('#webhookList').children].map((r) => r._get()),
  };
  const total = s.itemCount + (s.draftCount || 0);
  const shrinking = (json.retention.maxItems && json.retention.maxItems < total)
    || (json.retention.maxAgeDays && json.retention.maxAgeDays !== s.retention.maxAgeDays);
  if (shrinking && !confirm(`The new retention rules apply immediately and may permanently delete existing ${s.labels.plural}. Continue?`)) return;
  try {
    await api(streamPath(), { method: 'PATCH', json });
    toast('Settings saved');
    await loadStreams();
    renderDetail();
    renderSettings();
  } catch (err) {
    toast(err.message, 'error');
  }
}

async function deleteStream() {
  const s = state.current;
  const typed = prompt(`This permanently deletes the "${s.name}" stream and all ${plural(s.itemCount + (s.draftCount || 0), s.labels)}.\n\nType the slug "${s.slug}" to confirm:`);
  if (typed === null) return;
  if (typed.trim() !== s.slug) return toast('Slug did not match — nothing was deleted', 'error');
  try {
    state.source?.close();
    await api(streamPath(s), { method: 'DELETE' });
    toast('Stream deleted');
    state.current = null;
    setUrl();
    await loadStreams();
  } catch (err) {
    toast(err.message, 'error');
  }
}

// ---- API tab ---------------------------------------------------------------

function sampleData(fields) {
  if (!fields.length) return { message: 'hello', level: 'info' };
  const sample = {
    string: 'example', text: 'Longer text…', richtext: '# Hello\n\nMarkdown **body**', email: 'someone@example.com',
    url: 'https://example.com', integer: 1, number: 9.99, boolean: true, datetime: new Date().toISOString(),
    json: { any: 'value' }, tags: ['news'], media: '<media-file-id>',
  };
  const out = {};
  for (const f of fields) {
    if (f.type === 'uid' && f.targetField) continue; // generated
    out[f.name] = f.type === 'enum' ? f.options[0] : f.type === 'uid' ? 'my-item' : sample[f.type];
  }
  return out;
}

function renderApiDocs() {
  const s = state.current;
  const origin = location.origin;
  const path = `/api/streams/${s.slug}`;
  const L = s.labels;
  const auth = '-H "Authorization: Bearer $MEDIA_API_TOKEN" ';
  const dp = s.draftAndPublish;
  const body = JSON.stringify({ data: sampleData(s.fields), ...(dp ? { publish: true } : {}) });
  const firstField = s.fields.find((f) => ['enum', 'tags', 'uid'].includes(f.type)) || s.fields[0];
  const uidField = s.fields.find((f) => f.type === 'uid');

  const endpoints = [
    ['POST', path, `Create a ${L.singular} (shortcut for POST …/items)`],
    ['GET', `${path}/items`, `List ${L.plural} — filter, sort, paginate${dp ? '; ?status=draft|all needs a token' : ''}`],
    ['POST', `${path}/items`, `Create one ${L.singular}, or send an array to create up to 1000 at once`],
    ['GET', `${path}/items/:id`, `Get one ${L.singular}`],
    ['PUT', `${path}/items/:id`, `Replace a ${L.singular}’s data`],
    ['PATCH', `${path}/items/:id`, `Update some fields of a ${L.singular}`],
    ['DELETE', `${path}/items/:id`, `Delete a ${L.singular}`],
    ...(dp ? [
      ['POST', `${path}/items/:id/publish`, 'Publish (checks required fields)'],
      ['POST', `${path}/items/:id/unpublish`, 'Back to draft'],
    ] : []),
    ['GET', `${path}/subscribe`, 'Live feed (Server-Sent Events)'],
    ['GET', `${path}/schema`, `JSON Schema of a ${L.singular}’s data`],
    ['GET', `${path}/keys`, 'List API keys (main token only)'],
    ['POST', `${path}/keys`, 'Create an API key — the secret is returned once'],
    ['DELETE', `${path}/keys/:id`, 'Revoke an API key'],
    ['GET', path, 'Stream definition'],
    ['PATCH', path, 'Update name, fields or settings'],
    ['DELETE', path, `Delete the stream and all its ${L.plural}`],
  ];

  let filterValue = 'info';
  if (firstField) filterValue = firstField.type === 'tags' ? 'news' : String(sampleData([firstField])[firstField.name] ?? 'my-item');
  const examples = [
    [`Create a ${L.singular}`, `curl -X POST ${auth}-H "Content-Type: application/json" \\\n  -d '${body}' \\\n  ${origin}${path}`],
    [`Fetch the latest ${L.plural}`, `curl "${origin}${path}/items?sort=timestamp:desc&pageSize=50"`],
    ['Filter', `curl -g "${origin}${path}/items?filter[${firstField?.name || 'level'}]=${encodeURIComponent(filterValue)}&since=2026-01-01T00:00:00Z"`],
    ...(uidField ? [[`Get a ${L.singular} by its ${uidField.name}`, `curl -g "${origin}${path}/items?filter[${uidField.name}]=my-item"`]] : []),
    ...(s.fields.some((f) => f.type === 'relation')
      ? [['Include related items', `curl "${origin}${path}/items?populate=*"\n# or only some: ?populate=${s.fields.filter((f) => f.type === 'relation').map((f) => f.name).join(',')}`]]
      : []),
    ...(dp
      ? [[`Schedule a ${L.singular}`, `curl -X PATCH ${auth}-H "Content-Type: application/json" \\\n  -d '{"publishAt":"${new Date(Date.now() + 86400000).toISOString().slice(0, 13)}:00:00Z","unpublishAt":null}' \\\n  ${origin}${path}/items/<id>`]]
      : []),
    [`Poll for new ${L.plural} after sequence 42`, `curl "${origin}${path}/items?after=42"`],
    ['Use a stream API key instead of the main token', `# Create one in Settings → API keys, then:\ncurl -X POST -H "Authorization: Bearer mmk_…" -H "Content-Type: application/json" \\\n  -d '{"data":{…}}' ${origin}${path}/items`],
    ['Subscribe live', `curl -N "${origin}${path}/subscribe"\n\n// or in the browser\nconst es = new EventSource('${path}/subscribe');\nes.addEventListener('created', (e) => console.log(JSON.parse(e.data)));`],
    ['Verify a webhook signature (Node.js)', `import { createHmac, timingSafeEqual } from 'node:crypto';\n\nfunction verify(rawBody, header, secret) {\n  const expected = 'sha256=' + createHmac('sha256', secret).update(rawBody).digest('hex');\n  return header.length === expected.length && timingSafeEqual(Buffer.from(header), Buffer.from(expected));\n}\n// header = req.headers['x-webhook-signature']`],
  ];

  $('#apiDocs').replaceChildren(
    h('p', { class: 'muted' }, 'Reads are public', dp ? ' (published items only)' : '', '. Writes need ', h('code', {}, 'Authorization: Bearer <MEDIA_API_TOKEN>'), ' when a token is configured. See SPEC.md for the full reference.'),
    h('table', { class: 'endpoints' }, h('tbody', {}, endpoints.map(([m, p, d]) => h('tr', {},
      h('td', {}, h('span', { class: `method ${m.toLowerCase()}` }, m)),
      h('td', {}, h('code', {}, p)),
      h('td', { class: 'muted' }, d))))),
    ...examples.map(([title, code]) => h('div', { class: 'example' },
      h('div', { class: 'example-head' }, h('strong', {}, title),
        h('button', { class: 'btn btn-secondary btn-sm', onclick: () => copyText(code) }, 'Copy')),
      h('pre', {}, code))),
    h('h3', { class: 'section-title', style: 'margin-top:24px' }, 'Standard formats'),
    h('p', { class: 'muted small' }, 'Published items only. Filters, since/until and sort work as on /items. Add ?link=https://your-site/path/{slug} to link items to your website.'),
    h('table', { class: 'endpoints' }, h('tbody', {}, [
      ['feed.ics', 'iCalendar — subscribe in Google, Outlook or Apple Calendar', true],
      ['feed.rss', 'RSS 2.0 — feed readers, newsletters, Zapier', true],
      ['feed.json', 'JSON Feed 1.1', true],
      ['feed.geojson', 'GeoJSON — map tools (needs a map pin field)', s.fields.some((f) => f.type === 'geopoint')],
      ['items.csv', 'CSV — open in Excel or Google Sheets', true],
    ].filter(([, , on]) => on).map(([file, d]) => h('tr', {},
      h('td', {}, h('span', { class: 'method get' }, 'GET')),
      h('td', {}, h('a', { href: `${path}/${file}`, target: '_blank', rel: 'noopener' }, h('code', {}, `${path}/${file}`))),
      h('td', { class: 'muted' }, d))))),
    h('p', { class: 'muted small' }, 'Browser access from other websites (CORS): ',
      state.config?.corsOrigins?.length ? h('code', {}, state.config.corsOrigins.join(', ')) : 'not enabled — start the server with --cors=https://your-site.example to call the API from your website.'),
    h('p', {}, h('a', { href: `${path}/schema`, target: '_blank', rel: 'noopener' }, 'Open the JSON Schema for this stream ↗')),
  );
}

// ---- create stream dialog --------------------------------------------------

let newBuilder = null;
let slugTouched = false;
let chosenTemplate = 'blank';

function renderTemplatePicker() {
  const card = (t) => h('button', {
    type: 'button', role: 'radio', class: 'template-card', 'aria-checked': String(t.id === chosenTemplate),
    onclick: () => chooseTemplate(t.id),
  },
  h('strong', {}, t.name),
  h('span', { class: 'small muted' }, t.description),
  h('span', { class: 'small template-meta' },
    t.fields.length ? `${t.fields.length} fields` : 'Any JSON',
    t.draftAndPublish ? ' · drafts' : '',
    t.retention.maxAgeDays ? ` · keeps ${t.retention.maxAgeDays} days` : ''));
  const groups = [...new Set(state.templates.map((t) => t.category || 'Other'))];
  $('#templatePicker').replaceChildren(...groups.map((g) => h('div', { class: 'template-group' },
    h('span', { class: 'template-group-title' }, g),
    h('div', { class: 'template-grid' }, state.templates.filter((t) => (t.category || 'Other') === g).map(card)))));
}

function chooseTemplate(id) {
  chosenTemplate = id;
  const t = state.templates.find((x) => x.id === id);
  newBuilder.setFields(t?.fields || []);
  const form = $('#streamForm');
  if (!form.name.value || form.name.dataset.auto === 'true') {
    form.name.value = id === 'blank' || !t ? '' : t.name;
    form.name.dataset.auto = 'true';
    if (!slugTouched) form.slug.value = slugify(form.name.value);
    updateSlugHint();
  }
  renderTemplatePicker();
}

function openNewStream() {
  const form = $('#streamForm');
  form.reset();
  slugTouched = false;
  form.name.dataset.auto = 'true';
  newBuilder = fieldBuilder([]);
  $('#newStreamFields').replaceChildren(newBuilder.el);
  chooseTemplate('blank');
  $('#streamDialog').showModal();
  form.name.focus();
}

function updateSlugHint() {
  const form = $('#streamForm');
  $('#slugHint').textContent = `POST /api/streams/${form.slug.value || form.slug.placeholder}`;
}

async function createStream(e) {
  e.preventDefault();
  const form = $('#streamForm');
  try {
    const stream = await api('/api/streams', {
      method: 'POST',
      json: {
        name: form.name.value,
        slug: form.slug.value || undefined,
        description: form.description.value,
        template: chosenTemplate,
        fields: newBuilder.getFields(),
      },
    });
    $('#streamDialog').close();
    toast(`Stream “${stream.name}” created`);
    await loadStreams();
    selectStream(stream.slug, 'api');
  } catch (err) {
    toast(err.message, 'error');
  }
}

// ---- wiring ----------------------------------------------------------------

$('#newStreamBtn').addEventListener('click', openNewStream);
$('#emptyNewStream').addEventListener('click', openNewStream);
$('#streamForm').addEventListener('submit', createStream);
$('#streamForm').name.addEventListener('input', (e) => {
  e.target.dataset.auto = 'false';
  if (!slugTouched) $('#streamForm').slug.value = slugify(e.target.value);
  updateSlugHint();
});
$('#streamForm').slug.addEventListener('input', () => { slugTouched = true; updateSlugHint(); });
$('#streamSearch').addEventListener('input', (e) => { state.q = e.target.value.trim(); renderStreamList(); });

for (const b of document.querySelectorAll('[role=tab]')) b.addEventListener('click', () => selectTab(b.dataset.tab));

$('#newEventBtn').addEventListener('click', () => openItem());
$('#eventForm').addEventListener('submit', (e) => {
  e.preventDefault();
  saveItem(e.submitter?.id === 'publishEvent' ? 'publish' : 'save');
});
$('#unpublishEvent').addEventListener('click', () => saveItem('unpublish'));
$('#deleteEvent').addEventListener('click', deleteItem);
$('#datasetForm').addEventListener('submit', saveDataset);
$('#settingsForm').addEventListener('submit', saveSettings);
$('#addWebhook').addEventListener('click', () => {
  const row = webhookRow();
  $('#webhookList').append(row);
  row.querySelector('input').focus();
});
$('#deleteStream').addEventListener('click', deleteStream);
$('#keyForm').addEventListener('submit', createKey);
$('#copyKey').addEventListener('click', () => copyText($('#keyValue').textContent));
$('#keyScopes').replaceChildren(...KEY_SCOPES.map(([v, label]) => h('label', { class: 'chip' },
  h('input', { type: 'checkbox', value: v, checked: v === 'create' }), label)));
$('#eventForm').publishAt.addEventListener('input', updateSaveLabel);
$('#liveToggle').addEventListener('change', connectLive);
$('#statusFilter').addEventListener('change', (e) => { state.status = e.target.value; state.page = 1; loadItems(); });

$('#filterForm').addEventListener('submit', (e) => {
  e.preventDefault();
  const field = $('#filterField').value;
  if (!field) return toast('Choose a field to filter by', 'error');
  state.filter = { field, op: $('#filterOp').value, value: $('#filterValue').value };
  state.page = 1;
  $('#clearFilter').hidden = false;
  loadItems();
});
$('#clearFilter').addEventListener('click', () => {
  state.filter = null;
  state.page = 1;
  renderDetail();
  loadItems();
});

(async function init() {
  state.config = await initShell();
  try {
    const [templates] = await Promise.all([api('/api/stream-templates'), loadStreams()]);
    state.templates = templates.data;
  } catch (err) {
    return toast(err.message, 'error');
  }
  const params = new URL(location).searchParams;
  const slug = params.get('stream');
  const initial = state.streams.find((s) => s.slug === slug) || state.streams[0];
  if (initial) selectStream(initial.slug, params.get('tab') || 'items');
})();
