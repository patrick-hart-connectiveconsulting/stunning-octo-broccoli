// Admin "Embed" tab: choose a component for the stream, set its options, see a
// live preview, and copy the snippet for a website.

import { h, copyText, api } from './common.js';
import { fieldRoles } from './ui/core.js';

const COMPONENTS = [
  { id: 'list', tag: 'stream-list', name: 'List', desc: 'A vertical list or a horizontal row.' },
  { id: 'cards', tag: 'stream-cards', name: 'Cards', desc: 'A responsive grid of cards.' },
  { id: 'carousel', tag: 'stream-carousel', name: 'Carousel', desc: 'Slides with buttons and dots.' },
  { id: 'calendar', tag: 'stream-calendar', name: 'Calendar', desc: 'Month, week and agenda views.' },
  { id: 'timeline', tag: 'stream-timeline', name: 'Timeline', desc: 'Items along a vertical line.' },
  { id: 'table', tag: 'stream-table', name: 'Table', desc: 'Sortable, searchable rows.' },
  { id: 'map', tag: 'stream-map', name: 'Map', desc: 'Pins on an interactive map.' },
  { id: 'gallery', tag: 'stream-gallery', name: 'Gallery', desc: 'Images with a lightbox.' },
  { id: 'item', tag: 'stream-item', name: 'Single item', desc: 'One item in full: a detail page.' },
  { id: 'next', tag: 'stream-next', name: 'Next up', desc: 'The next upcoming item, with a countdown.' },
  { id: 'banner', tag: 'stream-banner', name: 'Banner', desc: 'The latest announcement.' },
];

const bool = (attr, label, hint) => ({ attr, label, type: 'bool', hint });
const select = (attr, label, choices, def = '', hint) => ({ attr, label, type: 'select', choices, def, hint });
const num = (attr, label, def = '', hint) => ({ attr, label, type: 'number', def, hint });

/** Options per component. '' means "leave the attribute out". */
const OPTIONS = {
  list: [select('layout', 'Layout', [['', 'Vertical'], ['horizontal', 'Horizontal row']]), bool('compact', 'Hide images'), bool('divided', 'Lines between items')],
  cards: [num('columns', 'Columns', '', 'Leave empty to fit as many as the width allows'), bool('compact', 'Hide images')],
  carousel: [num('per-view', 'Slides visible at once', '1'), num('autoplay', 'Autoplay (milliseconds)', '', 'Leave empty to turn it off, e.g. 5000')],
  calendar: [
    select('view', 'First view', [['', 'Month'], ['week', 'Week'], ['agenda', 'Agenda']]),
    { attr: 'views', label: 'View buttons', type: 'multi', choices: ['month', 'week', 'agenda'], def: ['month', 'week', 'agenda'] },
    select('week-start', 'Week starts on', [['', 'Automatic (from the language)'], ['0', 'Sunday'], ['1', 'Monday']]),
    { attr: 'color-field', label: 'Colour events by', type: 'field', types: ['tags', 'enum', 'string'], empty: 'One colour' },
  ],
  timeline: [select('group', 'Group by', [['', 'No groups'], ['month', 'Month'], ['year', 'Year']]), bool('alternate', 'Zig-zag layout'), select('order', 'Order', [['', 'Newest first'], ['asc', 'Oldest first']]), bool('compact', 'Hide images')],
  table: [{ attr: 'columns', label: 'Columns', type: 'columns', hint: 'Leave all unchecked for an automatic choice' }, bool('searchable', 'Search box')],
  map: [num('height', 'Height (pixels)', '420')],
  gallery: [bool('captions', 'Captions under images')],
  item: [{ attr: '_source', label: 'Which item', type: 'source' }, bool('details', 'List the other fields'), bool('set-title', 'Set the page title'), num('heading', 'Title heading level', '', '1 (default) to 6')],
  next: [bool('countdown', 'Countdown')],
  banner: [bool('dismissible', 'Visitors can close it'), num('rotate', 'Rotate every (milliseconds)', '', 'For more than one announcement, e.g. 6000')],
};

const state = new Map(); // stream slug -> { component, values, base }

function availability(id, stream, roles) {
  const has = (type) => stream.fields.some((f) => f.type === type);
  if (id === 'map' && !has('geopoint')) return 'Needs a map pin field';
  if (id === 'gallery' && !has('media')) return 'Needs a media field';
  if (id === 'item' && !stream.fields.length) return 'Needs fields';
  if ((id === 'calendar' || id === 'next') && !roles.start) return 'Uses the item date (no date field)';
  return null;
}

function recommend(stream, roles) {
  if (roles.level && stream.fields.some((f) => f.name === 'message')) return 'banner';
  if (roles.start) return 'calendar';
  if (stream.fields.some((f) => f.type === 'geopoint')) return 'map';
  if (roles.image) return 'cards';
  return 'list';
}

const escAttr = (v) => String(v).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');

export async function renderEmbed(container, { stream, config }) {
  const roles = fieldRoles(stream.fields || []);
  const key = stream.slug;
  if (!state.has(key)) {
    state.set(key, {
      component: recommend(stream, roles),
      values: { limit: '', sort: '', link: roles.slug ? `/${stream.slug}/{slug}` : '', live: true, theme: '', 'date-style': '', jsonld: Boolean(stream.schemaType), accent: '', radius: '' },
      base: (config?.publicUrl || location.origin).replace(/\/+$/, ''),
    });
  }
  const s = state.get(key);
  let items = null; // loaded on demand for the single-item picker

  const preview = h('div', { class: 'embed-preview', 'aria-live': 'polite' });
  const code = h('pre', { class: 'embed-code' });
  const optionsBox = h('div', { class: 'embed-options-fields' });
  const picker = h('div', { class: 'embed-picker', role: 'radiogroup', 'aria-label': 'Component' });

  const component = () => COMPONENTS.find((c) => c.id === s.component);

  /** The element's attributes, in a stable order, without src. */
  function attributes() {
    const v = s.values;
    const out = [];
    const add = (name, value) => { if (value !== '' && value != null && value !== false) out.push([name, value === true ? true : String(value)]); };
    for (const opt of OPTIONS[s.component] || []) {
      const val = v[`${s.component}:${opt.attr}`] ?? (opt.type === 'multi' ? opt.def : opt.def ?? '');
      if (opt.type === 'source') {
        const mode = v['item:mode'] || 'fixed';
        if (mode === 'path') add('slug-from-path', true);
        else if (mode === 'param') add('slug-param', 'slug');
        else if (v['item:value']) add(roles.slug ? 'slug' : 'item-id', v['item:value']);
      } else if (opt.type === 'multi') {
        const list = Array.isArray(val) ? val : opt.def;
        if (list.join(',') !== opt.def.join(',')) add(opt.attr, list.join(','));
      } else if (opt.type === 'columns') {
        if (Array.isArray(val) && val.length) add(opt.attr, val.join(','));
      } else if (opt.type === 'number') {
        if (val !== '' && val !== opt.def) add(opt.attr, val);
      } else add(opt.attr, val);
    }
    if (!['item', 'next'].includes(s.component)) add('limit', v.limit);
    if (!['item', 'calendar', 'next'].includes(s.component)) add('sort', v.sort);
    if (s.component !== 'item') add('link', v.link);
    add('date-style', v['date-style']);
    add('theme', v.theme);
    if (v.live) add('live', true);
    if (v.more && ['list', 'cards', 'table', 'timeline', 'gallery'].includes(s.component)) add('more', 'Load more');
    if (v.jsonld && stream.schemaType) add('jsonld', true);
    const style = [v.accent ? `--sui-accent: ${v.accent}` : '', v.radius !== '' ? `--sui-radius: ${v.radius}px` : ''].filter(Boolean).join('; ');
    if (style) add('style', style);
    return out;
  }

  function snippet() {
    const base = s.base.replace(/\/+$/, '');
    const c = component();
    const attrs = [['src', `${base}/api/streams/${stream.slug}`], ...attributes()];
    const parts = attrs.map(([n, v]) => (v === true ? n : `${n}="${escAttr(v)}"`));
    const open = parts.join(' ').length > 70 ? `<${c.tag}\n  ${parts.join('\n  ')}>` : `<${c.tag} ${parts.join(' ')}>`;
    return `<script type="module" src="${escAttr(base)}/ui/streams-ui.js"></script>\n\n${open}</${c.tag}>`;
  }

  let timer;
  function update() {
    code.textContent = snippet();
    clearTimeout(timer);
    timer = setTimeout(() => {
      const el = document.createElement(component().tag);
      el.setAttribute('src', `/api/streams/${stream.slug}`); // the preview reads this server directly
      for (const [n, v] of attributes()) el.setAttribute(n, v === true ? '' : v);
      if (s.component === 'item' && (s.values['item:mode'] || 'fixed') !== 'fixed') {
        // A page URL decides the item on the website; preview the newest one here.
        el.removeAttribute('slug-from-path');
        el.removeAttribute('slug-param');
        if (items?.[0]) el.setAttribute(roles.slug ? 'slug' : 'item-id', roles.slug ? items[0].data[roles.slug.name] : items[0].id);
      }
      preview.replaceChildren(el);
    }, 250);
  }

  const set = (k, v) => { s.values[k] = v; update(); };

  function control(opt) {
    const k = `${s.component}:${opt.attr}`;
    const val = s.values[k] ?? opt.def ?? '';
    const label = (input) => h('label', { class: opt.type === 'bool' ? 'check-inline' : '' },
      opt.type === 'bool' ? [input, opt.label] : [opt.label, input], opt.hint ? h('span', { class: 'hint' }, opt.hint) : null);
    switch (opt.type) {
      case 'bool':
        return label(h('input', { type: 'checkbox', checked: Boolean(val), onchange: (e) => set(k, e.target.checked) }));
      case 'number':
        return label(h('input', { type: 'number', min: 0, value: val, placeholder: opt.def || '', oninput: (e) => set(k, e.target.value) }));
      case 'select':
        return label(h('select', { onchange: (e) => set(k, e.target.value) }, opt.choices.map(([v, t]) => h('option', { value: v, selected: v === val }, t))));
      case 'field': {
        const fields = stream.fields.filter((f) => opt.types.includes(f.type));
        return label(h('select', { onchange: (e) => set(k, e.target.value) },
          h('option', { value: '' }, opt.empty), fields.map((f) => h('option', { value: f.name, selected: f.name === val }, f.name))));
      }
      case 'multi': {
        const current = Array.isArray(val) ? val : opt.def;
        return h('fieldset', { class: 'embed-chips' }, h('legend', {}, opt.label), opt.choices.map((c) => h('label', { class: 'chip' },
          h('input', { type: 'checkbox', checked: current.includes(c), onchange: (e) => {
            const now = Array.isArray(s.values[k]) ? s.values[k] : opt.def; // read at change time, not render time
            const next = opt.choices.filter((x) => (x === c ? e.target.checked : now.includes(x)));
            set(k, next.length ? next : [c]);
          } }), c)));
      }
      case 'columns': {
        const current = Array.isArray(val) ? val : [];
        const fields = stream.fields.filter((f) => !['richtext', 'json', 'uid'].includes(f.type));
        return h('fieldset', { class: 'embed-chips' }, h('legend', {}, opt.label), fields.map((f) => h('label', { class: 'chip' },
          h('input', { type: 'checkbox', checked: current.includes(f.name), onchange: (e) => {
            const now = Array.isArray(s.values[k]) ? s.values[k] : [];
            set(k, fields.map((x) => x.name).filter((n) => (n === f.name ? e.target.checked : now.includes(n))));
          } }), f.name)), opt.hint ? h('span', { class: 'hint' }, opt.hint) : null);
      }
      case 'source': {
        const mode = s.values['item:mode'] || 'fixed';
        const itemSelect = h('select', { 'aria-label': 'Item', onchange: (e) => set('item:value', e.target.value) }, h('option', { value: '' }, 'Loading…'));
        const fill = () => {
          const titleField = roles.title?.name;
          itemSelect.replaceChildren(h('option', { value: '' }, 'Choose an item…'), ...(items || []).map((it) => {
            const value = roles.slug ? it.data[roles.slug.name] : it.id;
            return h('option', { value, selected: value === s.values['item:value'] }, (titleField && it.data[titleField]) || `#${it.seq}`);
          }));
        };
        if (items) fill();
        else {
          api(`/api/streams/${encodeURIComponent(stream.slug)}/items?pageSize=100&sort=timestamp:desc`).then((r) => {
            items = r.data;
            if (!s.values['item:value'] && items[0]) s.values['item:value'] = roles.slug ? items[0].data[roles.slug.name] : items[0].id;
            fill();
            update();
          }).catch(() => { items = []; fill(); });
        }
        return h('div', { class: 'embed-source' },
          h('label', {}, opt.label, h('select', { onchange: (e) => { s.values['item:mode'] = e.target.value; renderOptions(); update(); } },
            h('option', { value: 'fixed', selected: mode === 'fixed' }, 'One fixed item'),
            roles.slug ? h('option', { value: 'path', selected: mode === 'path' }, 'From the page address (…/hello-world)') : null,
            roles.slug ? h('option', { value: 'param', selected: mode === 'param' }, 'From ?slug= in the page address') : null)),
          mode === 'fixed' ? h('label', {}, 'Item', itemSelect) : h('span', { class: 'hint' }, 'One template page can show every item. The preview shows the newest one.'));
      }
      default:
        return null;
    }
  }

  function sortChoices() {
    const choices = [['', 'Default'], ['timestamp:desc', 'Newest first'], ['timestamp:asc', 'Oldest first']];
    for (const f of stream.fields) {
      if (['json', 'richtext', 'tags', 'relation', 'media', 'geopoint'].includes(f.type)) continue;
      choices.push([`data.${f.name}:asc`, `${f.name} ↑`], [`data.${f.name}:desc`, `${f.name} ↓`]);
    }
    return choices;
  }

  function renderOptions() {
    const v = s.values;
    const common = [
      !['item', 'next'].includes(s.component) ? h('label', {}, 'Items to show', h('input', { type: 'number', min: 1, max: 500, value: v.limit, placeholder: 'Default', oninput: (e) => set('limit', e.target.value) })) : null,
      !['item', 'calendar', 'next'].includes(s.component) ? h('label', {}, 'Order', h('select', { onchange: (e) => set('sort', e.target.value) }, sortChoices().map(([val, t]) => h('option', { value: val, selected: val === v.sort }, t)))) : null,
      s.component !== 'item' ? h('label', {}, 'Link each item to', h('input', { value: v.link, placeholder: '/events/{slug}', oninput: (e) => set('link', e.target.value) }),
        h('span', { class: 'hint' }, 'A page on your website. Use {slug}, {id} or {fieldName}. Leave empty for no links.')) : null,
      h('div', { class: 'row-2' },
        h('label', {}, 'Theme', h('select', { onchange: (e) => set('theme', e.target.value) },
          [['', 'Light'], ['dark', 'Dark'], ['auto', 'Follow the visitor']].map(([val, t]) => h('option', { value: val, selected: val === v.theme }, t)))),
        h('label', {}, 'Dates', h('select', { onchange: (e) => set('date-style', e.target.value) },
          [['', 'Medium (Dec 1, 2026)'], ['short', 'Short (12/1/26)'], ['long', 'Long (December 1, 2026)'], ['full', 'Full (with weekday)']].map(([val, t]) => h('option', { value: val, selected: val === v['date-style'] }, t))))),
      h('div', { class: 'row-2' },
        h('label', {}, 'Accent colour', h('div', { class: 'color-row' },
          h('input', { type: 'color', value: v.accent || '#4945ff', oninput: (e) => set('accent', e.target.value) }),
          h('button', { type: 'button', class: 'btn btn-ghost btn-sm', onclick: () => { set('accent', ''); renderOptions(); } }, 'Default'))),
        h('label', {}, `Corner radius${v.radius !== '' ? ` (${v.radius}px)` : ''}`, h('input', { type: 'range', min: 0, max: 24, value: v.radius === '' ? 8 : v.radius, oninput: (e) => { set('radius', e.target.value); e.target.previousSibling.textContent = `Corner radius (${e.target.value}px)`; } }))),
      h('div', { class: 'embed-checks' },
        h('label', { class: 'check-inline' }, h('input', { type: 'checkbox', checked: v.live, onchange: (e) => set('live', e.target.checked) }), 'Live updates'),
        ['list', 'cards', 'table', 'timeline', 'gallery'].includes(s.component) ? h('label', { class: 'check-inline' }, h('input', { type: 'checkbox', checked: Boolean(v.more), onchange: (e) => set('more', e.target.checked) }), '“Load more” button') : null,
        stream.schemaType ? h('label', { class: 'check-inline', title: `Adds schema.org ${stream.schemaType} data` }, h('input', { type: 'checkbox', checked: v.jsonld, onchange: (e) => set('jsonld', e.target.checked) }), 'Structured data for search engines') : null),
    ];
    const specific = (OPTIONS[s.component] || []).map(control);
    optionsBox.replaceChildren(...[
      specific.length ? h('h3', { class: 'section-title' }, `${component().name} options`) : null, ...specific,
      h('h3', { class: 'section-title' }, 'General'), ...common,
    ].filter(Boolean)); // replaceChildren() would turn null into the text "null"
  }

  function renderPicker() {
    picker.replaceChildren(...COMPONENTS.map((c) => {
      const note = availability(c.id, stream, roles);
      const blocked = note && note.startsWith('Needs');
      return h('button', {
        type: 'button', role: 'radio', class: 'embed-choice', 'aria-checked': String(c.id === s.component), disabled: blocked,
        title: note || c.desc,
        onclick: () => { s.component = c.id; renderPicker(); renderOptions(); update(); },
      }, h('strong', {}, c.name), h('span', { class: 'small muted' }, note || c.desc));
    }));
  }

  const baseInput = h('input', { value: s.base, oninput: (e) => { s.base = e.target.value.trim() || location.origin; update(); } });
  const cors = config?.corsOrigins || [];
  const corsNote = cors.length
    ? h('p', { class: 'hint small' }, 'Websites allowed to use the API: ', h('code', {}, cors.join(', ')), '. To add one, start the server with ', h('code', {}, '--cors='), '.')
    : h('p', { class: 'embed-warning small' }, 'No other website may use the API yet. Start the server with ', h('code', {}, '--cors=https://your-site.example'), ' (the address of your website), or the components show an error there.');

  container.replaceChildren(h('div', { class: 'embed' },
    h('div', { class: 'embed-options' },
      h('h3', { class: 'section-title' }, 'Component'),
      picker,
      optionsBox),
    h('div', { class: 'embed-output' },
      h('div', { class: 'embed-head' }, h('h3', { class: 'section-title' }, 'Preview'),
        h('span', { class: 'hint small' }, 'What visitors see: published items only.')),
      preview,
      h('div', { class: 'embed-head' }, h('h3', { class: 'section-title' }, 'Code for your website'),
        h('button', { type: 'button', class: 'btn btn-primary btn-sm', id: 'copyEmbed', onclick: () => copyText(snippet()) }, 'Copy code')),
      code,
      h('label', { class: 'embed-base' }, 'Server address in the code', baseInput,
        h('span', { class: 'hint' }, 'The address your website uses to reach this server.')),
      corsNote,
      h('p', { class: 'hint small' }, 'More options and styling (CSS variables, ::part(), your own template): ',
        h('a', { href: '/ui/demo.html', target: '_blank', rel: 'noopener' }, 'demo page ↗'), ' and UI.md.'))));
  renderPicker();
  renderOptions();
  update();
}
