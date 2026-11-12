// Streams admin page: create stream endpoints, design their datasets, browse events.

import { $, h, api, toast, formatDate, debounce, copyText, initShell } from './common.js';

const FIELD_TYPES = [
  ['string', 'Short text'],
  ['text', 'Long text'],
  ['integer', 'Integer'],
  ['number', 'Number'],
  ['boolean', 'Boolean'],
  ['datetime', 'Date & time'],
  ['enum', 'Enumeration'],
  ['json', 'JSON'],
  ['media', 'Media'],
];
const MAX_COLUMNS = 6;

const state = {
  streams: [],
  current: null, // selected stream
  tab: 'events',
  q: '',
  events: [],
  pagination: null,
  page: 1,
  pageSize: 25,
  sort: 'timestamp:desc',
  filter: null, // { field, op, value }
  source: null, // EventSource
  editing: null, // event being edited
  media: null, // cached media list for media fields
};

// ---- helpers ---------------------------------------------------------------

const toLocalInput = (iso) => {
  if (!iso) return '';
  const d = new Date(iso);
  return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 19);
};
const fromLocalInput = (v) => (v ? new Date(v).toISOString() : undefined);
const origin = location.origin;

function setUrl() {
  const url = new URL(location);
  if (state.current) url.searchParams.set('stream', state.current.slug);
  else url.searchParams.delete('stream');
  if (state.tab !== 'events') url.searchParams.set('tab', state.tab);
  else url.searchParams.delete('tab');
  history.replaceState(null, '', url);
}

function preview(value, type) {
  if (value === null || value === undefined) return h('span', { class: 'muted' }, '—');
  if (type === 'boolean' || typeof value === 'boolean') return h('span', { class: `pill ${value ? 'on' : ''}` }, value ? 'true' : 'false');
  if (type === 'datetime') return formatDate(value);
  if (type === 'enum') return h('span', { class: 'pill' }, value);
  if (type === 'media') return h('code', { class: 'small' }, `${value.slice(0, 8)}…`);
  if (typeof value === 'object') return h('code', { class: 'small' }, truncate(JSON.stringify(value), 80));
  return truncate(String(value), 80);
}

const truncate = (s, n) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

// ---- field builder ---------------------------------------------------------

/** Editable list of field definitions. Returns { el, getFields() }. */
function fieldBuilder(initial = []) {
  const list = h('div', { class: 'field-rows' });
  const empty = h('p', { class: 'muted small field-empty' }, 'No fields — this stream accepts any JSON object.');

  function addRow(field = { name: '', type: 'string', required: false }) {
    const typeSel = h('select', { 'aria-label': 'Field type' },
      FIELD_TYPES.map(([v, label]) => h('option', { value: v, selected: v === field.type }, label)));
    const name = h('input', { value: field.name, placeholder: 'fieldName', 'aria-label': 'Field name', pattern: '[A-Za-z_][A-Za-z0-9_]*', maxlength: 64, required: true });
    const required = h('input', { type: 'checkbox', checked: field.required });
    const extras = h('div', { class: 'field-extras' });

    const renderExtras = () => {
      const t = typeSel.value;
      extras.replaceChildren();
      if (t === 'enum') {
        extras.append(h('input', { 'data-k': 'options', placeholder: 'Options, comma separated', value: (field.options || []).join(', '), 'aria-label': 'Enum options' }));
      } else if (t === 'integer' || t === 'number') {
        extras.append(
          h('input', { 'data-k': 'min', type: 'number', step: 'any', placeholder: 'Min', value: field.min ?? '', 'aria-label': 'Minimum' }),
          h('input', { 'data-k': 'max', type: 'number', step: 'any', placeholder: 'Max', value: field.max ?? '', 'aria-label': 'Maximum' }));
      } else if (t === 'string' || t === 'text') {
        extras.append(h('input', { 'data-k': 'maxLength', type: 'number', min: 1, placeholder: t === 'string' ? 'Max length (255)' : 'Max length', value: field.maxLength && !(t === 'string' && field.maxLength === 255) && !(t === 'text' && field.maxLength === 100000) ? field.maxLength : '', 'aria-label': 'Max length' }));
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
      for (const input of extras.querySelectorAll('[data-k]')) {
        const k = input.dataset.k;
        if (input.value === '') continue;
        f[k] = k === 'options' ? input.value.split(',').map((o) => o.trim()).filter(Boolean) : Number(input.value);
      }
      return f;
    };
    list.append(row);
    sync();
    return row;
  }

  const sync = () => { empty.hidden = list.children.length > 0; };

  for (const f of initial) addRow(f);
  sync();
  const el = h('div', { class: 'field-builder' },
    empty, list,
    h('button', { type: 'button', class: 'btn btn-secondary btn-sm', onclick: () => addRow().querySelector('input').focus() }, '+ Add field'));
  return { el, getFields: () => [...list.children].map((r) => r._get()) };
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
    h('span', { class: 'stream-name' }, s.name),
    h('span', { class: 'stream-sub' }, `/${s.slug}`),
    h('span', { class: 'stream-sub' }, `${s.eventCount} event${s.eventCount === 1 ? '' : 's'} · ${s.fields.length ? `${s.fields.length} field${s.fields.length === 1 ? '' : 's'}` : 'any JSON'}`)))));
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
  }
  renderStreamList();
  renderDetail();
  selectTab(tab);
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

  const fieldSel = $('#filterField');
  const options = s.fields.length ? s.fields.map((f) => f.name) : [...new Set(state.events.flatMap((e) => Object.keys(e.data || {})))];
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
  state.tab = tab;
  for (const b of document.querySelectorAll('[role=tab]')) b.setAttribute('aria-selected', String(b.dataset.tab === tab));
  for (const p of document.querySelectorAll('.tab-panel')) p.hidden = p.dataset.panel !== tab;
  if (tab === 'events') loadEvents();
  if (tab === 'dataset') renderDataset();
  if (tab === 'api') renderApiDocs();
  setUrl();
}

// ---- events tab ------------------------------------------------------------

async function loadEvents() {
  const s = state.current;
  if (!s) return;
  const params = new URLSearchParams({ page: state.page, pageSize: state.pageSize, sort: state.sort });
  if (state.filter) {
    const { field, op, value } = state.filter;
    params.set(op === 'eq' ? `filter[${field}]` : `filter[${field}][${op}]`, value);
  }
  try {
    const { data, meta } = await api(`/api/streams/${encodeURIComponent(s.slug)}/events?${params}`);
    if (state.page > meta.pagination.pageCount) {
      state.page = meta.pagination.pageCount;
      return loadEvents();
    }
    state.events = data;
    state.pagination = meta.pagination;
    renderEvents();
    if (!s.fields.length) renderDetail(); // refresh schema-less filter options
  } catch (err) {
    toast(err.message, 'error');
  }
}

function columns() {
  const s = state.current;
  if (s.fields.length) return s.fields.slice(0, MAX_COLUMNS).map((f) => ({ key: f.name, label: f.name, type: f.type }));
  return [{ key: null, label: 'data', type: 'json' }];
}

function renderEvents() {
  const cols = columns();
  const sortable = (label, key) => {
    const [cur, dir] = state.sort.split(':');
    const active = cur === key;
    return h('th', {},
      h('button', {
        class: `th-sort${active ? ' active' : ''}`,
        onclick: () => { state.sort = `${key}:${active && dir === 'desc' ? 'asc' : 'desc'}`; state.page = 1; loadEvents(); },
      }, label, active ? (dir === 'desc' ? ' ↓' : ' ↑') : ''));
  };
  $('#eventsHead').replaceChildren(h('tr', {},
    sortable('#', 'seq'),
    sortable('Timestamp', 'timestamp'),
    cols.map((c) => (c.key && c.type !== 'json' ? sortable(c.label, `data.${c.key}`) : h('th', {}, c.label))),
    state.current.fields.length > MAX_COLUMNS ? h('th', { class: 'muted' }, `+${state.current.fields.length - MAX_COLUMNS} more`) : null));

  $('#eventsBody').replaceChildren(...state.events.map((e) => h('tr', {
    tabindex: 0,
    onclick: () => openEvent(e),
    onkeydown: (ev) => ev.key === 'Enter' && openEvent(e),
  },
  h('td', { class: 'muted' }, e.seq),
  h('td', { class: 'nowrap' }, formatDate(e.timestamp)),
  cols.map((c) => h('td', {}, preview(c.key ? e.data?.[c.key] : e.data, c.type))),
  state.current.fields.length > MAX_COLUMNS ? h('td', {}) : null)));

  const empty = state.events.length === 0;
  $('.table-wrap').hidden = empty;
  $('#eventsEmpty').hidden = !empty;
  $('#eventsEmptyText').textContent = state.filter ? 'No events match this filter.' : 'No events yet. Post one from the API tab or click “New event”.';
  renderPagination();
}

function renderPagination() {
  const { page, pageCount, total } = state.pagination;
  const btn = (label, target, disabled, aria) => h('button', {
    class: 'page-btn', disabled, 'aria-label': aria,
    onclick: () => { state.page = target; loadEvents(); },
  }, label);
  $('#eventsPagination').replaceChildren(
    h('span', { class: 'muted' }, `${total} event${total === 1 ? '' : 's'}${state.filter ? ' match' : ''}`),
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
  const src = new EventSource(`/api/streams/${encodeURIComponent(state.current.slug)}/subscribe`);
  state.source = src;
  const refresh = debounce(async () => {
    await loadStreams();
    if (state.tab === 'events') loadEvents();
  }, 300);
  src.onopen = () => { dot.className = 'live-dot on'; };
  src.onerror = () => { dot.className = 'live-dot err'; };
  for (const type of ['created', 'updated', 'deleted', 'stream-updated']) src.addEventListener(type, refresh);
  src.addEventListener('stream-deleted', () => {
    toast('This stream was deleted', 'error');
    state.current = null;
    src.close();
    loadStreams();
  });
}

// ---- event dialog ----------------------------------------------------------

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

async function eventInput(field, value) {
  const common = { name: `f:${field.name}`, 'data-type': field.type, required: field.required };
  switch (field.type) {
    case 'text':
      return h('textarea', { ...common, rows: 3, maxlength: field.maxLength }, value ?? '');
    case 'integer':
    case 'number':
      return h('input', { ...common, type: 'number', step: field.type === 'integer' ? 1 : 'any', min: field.min, max: field.max, value: value ?? '' });
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
    case 'json':
      return h('textarea', { ...common, rows: 4, class: 'mono', placeholder: '{ }' }, value == null ? '' : JSON.stringify(value, null, 2));
    case 'media': {
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

async function openEvent(event = null) {
  const s = state.current;
  state.editing = event;
  const form = $('#eventForm');
  $('#eventDialogTitle').textContent = event ? `Event #${event.seq}` : `New ${s.name} event`;
  $('#saveEvent').textContent = event ? 'Save changes' : 'Create event';
  $('#deleteEvent').hidden = !event;
  form.timestamp.value = event ? toLocalInput(event.timestamp) : '';
  form.timestamp.dataset.initial = form.timestamp.value; // input is second-precision; only send if edited

  const meta = $('#eventMeta');
  meta.hidden = !event;
  if (event) {
    meta.replaceChildren(...[
      ['Event ID', event.id], ['Sequence', event.seq], ['Created', formatDate(event.createdAt)], ['Updated', formatDate(event.updatedAt)],
    ].map(([k, v]) => h('div', {}, h('dt', {}, k), h('dd', {}, v))));
  }

  const container = $('#eventFields');
  if (s.fields.length) {
    const rows = [];
    for (const f of s.fields) {
      rows.push(h('label', {},
        h('span', {}, f.name, f.required ? h('span', { class: 'req-mark' }, ' *') : null, h('span', { class: 'type-tag' }, f.type)),
        await eventInput(f, event?.data?.[f.name]),
        f.description ? h('span', { class: 'hint' }, f.description) : null));
    }
    container.replaceChildren(...rows);
  } else {
    container.replaceChildren(h('label', {}, 'Data (JSON object)',
      h('textarea', { name: '__json', rows: 10, class: 'mono', placeholder: '{\n  "key": "value"\n}' }, event ? JSON.stringify(event.data, null, 2) : '')));
  }
  $('#eventDialog').showModal();
}

function readEventForm() {
  const s = state.current;
  const form = $('#eventForm');
  const data = {};
  if (!s.fields.length) {
    const raw = form.__json.value.trim() || '{}';
    try {
      return { data: JSON.parse(raw) };
    } catch {
      throw new Error('Data must be valid JSON');
    }
  }
  for (const f of s.fields) {
    const el = form.elements[`f:${f.name}`];
    const v = el.value.trim();
    if (v === '') { data[f.name] = null; continue; }
    if (f.type === 'integer' || f.type === 'number') data[f.name] = Number(v);
    else if (f.type === 'boolean') data[f.name] = v === 'true';
    else if (f.type === 'datetime') data[f.name] = fromLocalInput(v);
    else if (f.type === 'json') {
      try { data[f.name] = JSON.parse(v); } catch { throw new Error(`${f.name} must be valid JSON`); }
    } else data[f.name] = el.value; // keep inner whitespace for text
  }
  return { data };
}

async function saveEvent(e) {
  e.preventDefault();
  const s = state.current;
  let body;
  try {
    body = readEventForm();
  } catch (err) {
    return toast(err.message, 'error');
  }
  const tsInput = $('#eventForm').timestamp;
  if (tsInput.value && tsInput.value !== tsInput.dataset.initial) body.timestamp = fromLocalInput(tsInput.value);
  const base = `/api/streams/${encodeURIComponent(s.slug)}/events`;
  try {
    if (state.editing) await api(`${base}/${state.editing.id}`, { method: 'PUT', json: body });
    else await api(base, { method: 'POST', json: body });
    $('#eventDialog').close();
    toast(state.editing ? 'Event updated' : 'Event created');
    await loadStreams();
    loadEvents();
  } catch (err) {
    toast(err.message, 'error');
  }
}

async function deleteEvent() {
  const ev = state.editing;
  if (!ev || !confirm(`Delete event #${ev.seq}? This cannot be undone.`)) return;
  try {
    await api(`/api/streams/${encodeURIComponent(state.current.slug)}/events/${ev.id}`, { method: 'DELETE' });
    $('#eventDialog').close();
    toast('Event deleted');
    await loadStreams();
    loadEvents();
  } catch (err) {
    toast(err.message, 'error');
  }
}

// ---- dataset tab -----------------------------------------------------------

let datasetBuilder = null;

function renderDataset() {
  const s = state.current;
  const form = $('#datasetForm');
  form.name.value = s.name;
  form.slug.value = s.slug;
  form.description.value = s.description || '';
  datasetBuilder = fieldBuilder(s.fields);
  $('#datasetFields').replaceChildren(datasetBuilder.el);
}

async function saveDataset(e) {
  e.preventDefault();
  const form = $('#datasetForm');
  try {
    await api(`/api/streams/${encodeURIComponent(state.current.slug)}`, {
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

async function deleteStream() {
  const s = state.current;
  const typed = prompt(`This permanently deletes the "${s.name}" stream and all ${s.eventCount} of its events.\n\nType the slug "${s.slug}" to confirm:`);
  if (typed === null) return;
  if (typed.trim() !== s.slug) return toast('Slug did not match — nothing was deleted', 'error');
  try {
    state.source?.close();
    await api(`/api/streams/${encodeURIComponent(s.slug)}`, { method: 'DELETE' });
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
    string: 'example', text: 'Longer text…', integer: 1, number: 9.99, boolean: true,
    datetime: new Date().toISOString(), json: { any: 'value' }, media: '<media-file-id>',
  };
  return Object.fromEntries(fields.map((f) => [f.name, f.type === 'enum' ? f.options[0] : sample[f.type]]));
}

function renderApiDocs() {
  const s = state.current;
  const path = `/api/streams/${s.slug}`;
  const auth = '-H "Authorization: Bearer $MEDIA_API_TOKEN" ';
  const body = JSON.stringify({ data: sampleData(s.fields) });
  const firstField = s.fields.find((f) => f.type === 'enum') || s.fields[0];

  const endpoints = [
    ['POST', path, 'Create an event (shortcut for POST …/events)'],
    ['GET', `${path}/events`, 'List events — filter, sort, paginate'],
    ['POST', `${path}/events`, 'Create one event, or send an array to create up to 1000 at once'],
    ['GET', `${path}/events/:id`, 'Get one event'],
    ['PUT', `${path}/events/:id`, 'Replace an event’s data'],
    ['PATCH', `${path}/events/:id`, 'Update some fields of an event'],
    ['DELETE', `${path}/events/:id`, 'Delete an event'],
    ['GET', `${path}/subscribe`, 'Live feed (Server-Sent Events)'],
    ['GET', `${path}/schema`, 'JSON Schema of the event data'],
    ['GET', path, 'Stream definition'],
    ['PATCH', path, 'Update name, description or fields'],
    ['DELETE', path, 'Delete the stream and all its events'],
  ];

  const examples = [
    ['Create an event', `curl -X POST ${auth}-H "Content-Type: application/json" \\\n  -d '${body}' \\\n  ${origin}${path}`],
    ['Fetch the latest events', `curl "${origin}${path}/events?sort=timestamp:desc&pageSize=50"`],
    firstField
      ? ['Filter events', `curl -g "${origin}${path}/events?filter[${firstField.name}]=${encodeURIComponent(String(sampleData([firstField])[firstField.name]))}&since=2026-01-01T00:00:00Z"`]
      : ['Filter events', `curl -g "${origin}${path}/events?filter[level]=info&since=2026-01-01T00:00:00Z"`],
    ['Poll for new events after sequence 42', `curl "${origin}${path}/events?after=42"`],
    ['Subscribe live', `curl -N "${origin}${path}/subscribe"\n\n// or in the browser\nconst es = new EventSource('${path}/subscribe');\nes.addEventListener('created', (e) => console.log(JSON.parse(e.data)));`],
  ];

  $('#apiDocs').replaceChildren(
    h('p', { class: 'muted' }, 'Reads are public. Writes need ', h('code', {}, 'Authorization: Bearer <MEDIA_API_TOKEN>'), ' when a token is configured. See SPEC.md for the full reference.'),
    h('table', { class: 'endpoints' }, h('tbody', {}, endpoints.map(([m, p, d]) => h('tr', {},
      h('td', {}, h('span', { class: `method ${m.toLowerCase()}` }, m)),
      h('td', {}, h('code', {}, p)),
      h('td', { class: 'muted' }, d))))),
    ...examples.map(([title, code]) => h('div', { class: 'example' },
      h('div', { class: 'example-head' }, h('strong', {}, title),
        h('button', { class: 'btn btn-secondary btn-sm', onclick: () => copyText(code) }, 'Copy')),
      h('pre', {}, code))),
    h('p', {}, h('a', { href: `${path}/schema`, target: '_blank', rel: 'noopener' }, 'Open the JSON Schema for this stream ↗')),
  );
}

// ---- create stream dialog --------------------------------------------------

let newBuilder = null;
let slugTouched = false;

function openNewStream() {
  const form = $('#streamForm');
  form.reset();
  slugTouched = false;
  newBuilder = fieldBuilder([]);
  $('#newStreamFields').replaceChildren(newBuilder.el);
  updateSlugHint();
  $('#streamDialog').showModal();
  form.name.focus();
}

const slugify = (t) => t.toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 64).replace(/-+$/, '');

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
      json: { name: form.name.value, slug: form.slug.value || undefined, description: form.description.value, fields: newBuilder.getFields() },
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
  if (!slugTouched) $('#streamForm').slug.value = slugify(e.target.value);
  updateSlugHint();
});
$('#streamForm').slug.addEventListener('input', () => { slugTouched = true; updateSlugHint(); });
$('#streamSearch').addEventListener('input', (e) => { state.q = e.target.value.trim(); renderStreamList(); });

for (const b of document.querySelectorAll('[role=tab]')) b.addEventListener('click', () => selectTab(b.dataset.tab));

$('#newEventBtn').addEventListener('click', () => openEvent());
$('#eventForm').addEventListener('submit', saveEvent);
$('#deleteEvent').addEventListener('click', deleteEvent);
$('#datasetForm').addEventListener('submit', saveDataset);
$('#deleteStream').addEventListener('click', deleteStream);
$('#liveToggle').addEventListener('change', connectLive);

$('#filterForm').addEventListener('submit', (e) => {
  e.preventDefault();
  const field = $('#filterField').value;
  if (!field) return toast('Choose a field to filter by', 'error');
  state.filter = { field, op: $('#filterOp').value, value: $('#filterValue').value };
  state.page = 1;
  $('#clearFilter').hidden = false;
  loadEvents();
});
$('#clearFilter').addEventListener('click', () => {
  state.filter = null;
  state.page = 1;
  renderDetail();
  loadEvents();
});

(async function init() {
  await initShell();
  try {
    await loadStreams();
  } catch (err) {
    return toast(err.message, 'error');
  }
  const params = new URL(location).searchParams;
  const slug = params.get('stream');
  const initial = state.streams.find((s) => s.slug === slug) || state.streams[0];
  if (initial) selectStream(initial.slug, params.get('tab') || 'events');
})();
