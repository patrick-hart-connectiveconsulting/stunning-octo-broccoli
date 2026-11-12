// Streams UI — <stream-calendar>: month, week and agenda views of dated items.

import { StreamElement, h } from './base.js';
import { monthGrid, weekDays, eventDays, toDate, addDays, startOfDay, sameDay, dayKey, weekStartFor, formatTime } from './core.js';

const VIEWS = ['month', 'week', 'agenda'];

export class StreamCalendar extends StreamElement {
  static defaultLimit = 500;
  static emptyText = 'No events.';
  static extraAttributes = ['view', 'views', 'date', 'week-start', 'max-per-day', 'color-field', 'no-responsive'];
  static css = `
.sui-cal-head { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; margin-bottom: 12px; }
.sui-cal-title { margin: 0 auto 0 4px; font-size: 1.25em; font-weight: 700; order: -1; flex: 1 1 auto; }
.sui-cal-nav, .sui-cal-views { display: flex; gap: 4px; }
.sui-cal-weekdays, .sui-cal-grid { display: grid; grid-template-columns: repeat(7, minmax(0, 1fr)); }
.sui-cal-weekdays { font-size: .75em; font-weight: 700; color: var(--_muted); text-transform: uppercase; letter-spacing: .04em; }
.sui-cal-weekdays > div { padding: 6px 8px; }
.sui-cal-grid { border-top: 1px solid var(--_border); border-left: 1px solid var(--_border); }
.sui-day { min-height: var(--sui-day-height, 104px); padding: 4px 6px 6px; border-right: 1px solid var(--_border); border-bottom: 1px solid var(--_border); background: var(--_surface); display: flex; flex-direction: column; gap: 3px; min-width: 0; }
.sui-day.sui-out { background: transparent; color: var(--_muted); }
.sui-daynum { font-size: .85em; font-weight: 600; width: 1.9em; height: 1.9em; display: inline-flex; align-items: center; justify-content: center; border-radius: 50%; }
.sui-today .sui-daynum { background: var(--_accent); color: var(--_accent-text); }
.sui-ev { all: unset; box-sizing: border-box; display: block; width: 100%; font-size: .78em; line-height: 1.3; padding: 2px 6px; border-radius: 4px; background: var(--_hover); border-left: 3px solid var(--_c, var(--_accent)); cursor: pointer; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.sui-ev:hover { filter: brightness(.96); }
.sui-ev:focus-visible { outline: 2px solid var(--_accent); }
.sui-ev.sui-allday { background: var(--_c, var(--_accent)); color: var(--_accent-text); }
.sui-ev time { font-variant-numeric: tabular-nums; opacity: .8; margin-right: 4px; }
.sui-morelink { all: unset; cursor: pointer; font-size: .75em; color: var(--_muted); padding: 0 6px; }
.sui-morelink:hover { color: var(--_accent); }
.sui-week { display: grid; grid-template-columns: repeat(7, minmax(0, 1fr)); gap: 8px; }
.sui-week-day { border: 1px solid var(--_border); border-radius: var(--_radius); padding: 8px; background: var(--_surface); min-height: 160px; display: flex; flex-direction: column; gap: 4px; }
.sui-week-day header { font-size: .8em; font-weight: 700; color: var(--_muted); }
.sui-week-day.sui-today header { color: var(--_accent); }
.sui-agenda { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 14px; }
.sui-agenda h3 { margin: 0 0 6px; font-size: .9em; color: var(--_muted); text-transform: uppercase; letter-spacing: .04em; }
.sui-agenda ul { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 6px; }
.sui-agenda-item { all: unset; box-sizing: border-box; width: 100%; display: grid; grid-template-columns: 5.5em 1fr; gap: 10px; padding: 8px 10px; border-radius: var(--_radius); border: 1px solid var(--_border); border-left: 4px solid var(--_c, var(--_accent)); background: var(--_surface); cursor: pointer; }
.sui-agenda-item:hover { border-color: var(--_accent); }
.sui-agenda-item:focus-visible { outline: 2px solid var(--_accent); }
.sui-agenda-time { color: var(--_muted); font-size: .85em; font-variant-numeric: tabular-nums; }
.sui-agenda-title { font-weight: 650; }
.sui-agenda-venue { display: block; color: var(--_muted); font-size: .85em; font-weight: 400; }
dialog { border: 1px solid var(--_border); border-radius: calc(var(--_radius) + 4px); padding: 0; width: min(440px, 92vw); background: var(--_surface); color: inherit; box-shadow: 0 20px 50px rgba(0,0,0,.25); }
dialog::backdrop { background: rgba(10, 10, 20, .35); }
.sui-pop { padding: 18px 20px; display: flex; flex-direction: column; gap: 8px; }
.sui-pop h3 { margin: 0; font-size: 1.15em; padding-right: 28px; }
.sui-pop-close { all: unset; position: absolute; top: 12px; right: 14px; cursor: pointer; font-size: 1.1em; padding: 2px 6px; border-radius: 4px; }
.sui-pop-close:focus-visible { outline: 2px solid var(--_accent); }
.sui-pop .sui-image { max-height: 180px; }
.sui-pop-list { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 6px; }
@media (max-width: 640px) { .sui-week { grid-template-columns: 1fr; } .sui-week-day { min-height: 0; } }
`;

  allowEmptyView = true;

  connectedCallback() {
    super.connectedCallback();
    if (!this._ro && 'ResizeObserver' in window) {
      this._ro = new ResizeObserver(() => {
        const narrow = this.isNarrow();
        if (narrow !== this._wasNarrow && this.stream) {
          this._wasNarrow = narrow;
          this.render();
        }
      });
      this._ro.observe(this);
    }
  }

  teardown() {
    this._ro?.disconnect();
    this._ro = null;
  }

  attributeChangedCallback(name, oldValue, newValue) {
    if (name === 'date' || name === 'view') {
      this._cursor = null;
      this._view = null;
    }
    super.attributeChangedCallback(name, oldValue, newValue);
  }

  isNarrow() {
    return !this.hasAttribute('no-responsive') && this.clientWidth > 0 && this.clientWidth < 560;
  }

  get views() {
    const list = (this.getAttribute('views') || 'month,week,agenda').split(',').map((s) => s.trim()).filter((v) => VIEWS.includes(v));
    return list.length ? list : ['month'];
  }

  get view() {
    if (!this._view) {
      const v = this.getAttribute('view');
      this._view = VIEWS.includes(v) ? v : this.views[0];
    }
    return this._view;
  }

  /** The view actually drawn: month becomes agenda on narrow screens. */
  get shownView() {
    return this.view === 'month' && this.isNarrow() ? 'agenda' : this.view;
  }

  get cursor() {
    if (!this._cursor) {
      const attr = this.getAttribute('date');
      const m = /^(\d{4})-(\d{2})(?:-(\d{2}))?$/.exec(attr || '');
      this._cursor = m ? new Date(+m[1], +m[2] - 1, +(m[3] || 1)) : startOfDay(new Date());
    }
    return this._cursor;
  }

  get weekStart() {
    const n = parseInt(this.getAttribute('week-start'), 10);
    return n >= 0 && n <= 6 ? n : weekStartFor(this.locale);
  }

  /** [first day, day after the last day] of the visible range. */
  range() {
    const c = this.cursor;
    const view = this.shownView;
    if (view === 'week') {
      const days = weekDays(c, this.weekStart);
      return [days[0], addDays(days[6], 1)];
    }
    if (view === 'agenda') {
      const first = new Date(c.getFullYear(), c.getMonth(), 1);
      const today = startOfDay(new Date());
      const from = today > first && today.getMonth() === c.getMonth() && today.getFullYear() === c.getFullYear() ? today : first;
      return [from, new Date(c.getFullYear(), c.getMonth() + 1, 1)];
    }
    const grid = monthGrid(c.getFullYear(), c.getMonth(), this.weekStart);
    return [grid[0], addDays(grid[grid.length - 1], 1)];
  }

  query(page) {
    const params = super.query(page);
    const [from, to] = this.range();
    const f = this.roles?.start;
    // Events that start up to 62 days before the range can still overlap it.
    const lo = addDays(from, -62);
    if (f) {
      const fmt = (d) => (f.type === 'date' ? dayKey(d) : d.toISOString());
      params.set(`filter[${f.name}][gte]`, fmt(lo));
      params.set(`filter[${f.name}][lt]`, fmt(to));
      if (!this.getAttribute('sort')) params.set('sort', `data.${f.name}:asc`);
    } else {
      params.set('since', lo.toISOString());
      params.set('until', to.toISOString());
      if (!this.getAttribute('sort')) params.set('sort', 'timestamp:asc');
    }
    return params;
  }

  /** Events with their local-day span, limited to the visible range. */
  events() {
    const [from, to] = this.range();
    const last = addDays(to, -1);
    const colorField = this.getAttribute('color-field');
    return this.items.map((item) => {
      const info = this.info(item);
      const span = eventDays(info.start, info.end);
      if (!span || span[1] < from || span[0] > last) return null;
      let color = null;
      if (colorField) {
        const v = item.data?.[colorField];
        const key = Array.isArray(v) ? v[0] : v;
        if (key != null) {
          let hash = 0;
          for (const ch of String(key)) hash = (hash * 31 + ch.codePointAt(0)) >>> 0;
          color = `hsl(${hash % 360} 65% 45%)`;
        }
      }
      return { item, info, first: span[0], last: span[1], color };
    }).filter(Boolean);
  }

  eventsOn(day, events) {
    return events.filter((e) => day >= e.first && day <= e.last)
      .sort((a, b) => (b.info.allDay - a.info.allDay) || (toDate(a.info.start) - toDate(b.info.start)));
  }

  move(step) {
    const c = this.cursor;
    const view = this.shownView;
    this._cursor = view === 'week' ? addDays(c, 7 * step) : new Date(c.getFullYear(), c.getMonth() + step, 1);
    this.refresh({ quiet: true });
  }

  title() {
    const c = this.cursor;
    if (this.shownView === 'week') {
      const days = weekDays(c, this.weekStart);
      try {
        return new Intl.DateTimeFormat(this.locale, { month: 'short', day: 'numeric', year: 'numeric' }).formatRange(days[0], days[6]);
      } catch {
        return `${days[0].toLocaleDateString()} – ${days[6].toLocaleDateString()}`;
      }
    }
    return new Intl.DateTimeFormat(this.locale, { month: 'long', year: 'numeric' }).format(c);
  }

  renderView() {
    const events = this.events();
    const view = this.shownView;
    const head = h('div', { class: 'sui-cal-head', part: 'header' },
      h('h2', { class: 'sui-cal-title', part: 'title', 'aria-live': 'polite' }, this.title()),
      h('div', { class: 'sui-cal-nav', part: 'nav' },
        h('button', { type: 'button', class: 'sui-button', part: 'button prev', 'aria-label': view === 'week' ? 'Previous week' : 'Previous month', onclick: () => this.move(-1) }, '‹'),
        h('button', { type: 'button', class: 'sui-button', part: 'button today', onclick: () => { this._cursor = startOfDay(new Date()); this.refresh({ quiet: true }); } }, this.getAttribute('today-label') || 'Today'),
        h('button', { type: 'button', class: 'sui-button', part: 'button next', 'aria-label': view === 'week' ? 'Next week' : 'Next month', onclick: () => this.move(1) }, '›')),
      this.views.length > 1 ? h('div', { class: 'sui-cal-views', part: 'views', role: 'group', 'aria-label': 'View' },
        this.views.map((v) => h('button', {
          type: 'button', class: 'sui-button', part: 'button view', 'aria-pressed': String(this.view === v),
          onclick: () => { this._view = v; this.refresh({ quiet: true }); },
        }, v[0].toUpperCase() + v.slice(1)))) : null);
    this._dialog = h('dialog', { part: 'popup' });
    this._dialog.addEventListener('click', (e) => { if (e.target === this._dialog) this._dialog.close(); });
    const body = view === 'week' ? this.renderWeek(events) : view === 'agenda' ? this.renderAgenda(events) : this.renderMonth(events);
    return [head, body, this._dialog];
  }

  chip(e, day) {
    const startsToday = sameDay(toDate(e.info.start), day);
    const time = !e.info.allDay && startsToday ? formatTime(e.info.start, this.locale) : '';
    return h('button', {
      type: 'button', class: `sui-ev${e.info.allDay || !startsToday ? ' sui-allday' : ''}`, part: 'event',
      style: e.color ? `--_c: ${e.color}` : null, title: e.info.title, onclick: () => this.show(e),
    }, time ? h('time', { datetime: e.info.start }, time) : null, e.info.title);
  }

  renderMonth(events) {
    const c = this.cursor;
    const grid = monthGrid(c.getFullYear(), c.getMonth(), this.weekStart);
    const today = new Date();
    const max = Math.max(1, parseInt(this.getAttribute('max-per-day'), 10) || 3);
    const names = grid.slice(0, 7).map((d) => new Intl.DateTimeFormat(this.locale, { weekday: 'short' }).format(d));
    const cells = grid.map((day) => {
      const list = this.eventsOn(day, events);
      const out = day.getMonth() !== c.getMonth();
      const label = new Intl.DateTimeFormat(this.locale, { dateStyle: 'full' }).format(day);
      return h('div', { class: `sui-day${out ? ' sui-out' : ''}${sameDay(day, today) ? ' sui-today' : ''}`, part: `day${out ? ' day-outside' : ''}${sameDay(day, today) ? ' day-today' : ''}`, role: 'gridcell', 'aria-label': `${label}, ${list.length} ${list.length === 1 ? 'event' : 'events'}` },
        h('span', { class: 'sui-daynum', 'aria-hidden': 'true' }, String(day.getDate())),
        list.slice(0, max).map((e) => this.chip(e, day)),
        list.length > max ? h('button', { type: 'button', class: 'sui-morelink', part: 'more-events', onclick: () => this.showDay(day, list) }, `+${list.length - max} more`) : null);
    });
    return h('div', { class: 'sui-cal-month', part: 'month', role: 'grid', 'aria-label': this.title() },
      h('div', { class: 'sui-cal-weekdays', role: 'row' }, names.map((n) => h('div', { role: 'columnheader' }, n))),
      h('div', { class: 'sui-cal-grid' }, cells));
  }

  renderWeek(events) {
    const today = new Date();
    return h('div', { class: 'sui-week', part: 'week' }, weekDays(this.cursor, this.weekStart).map((day) => {
      const list = this.eventsOn(day, events);
      return h('section', { class: `sui-week-day${sameDay(day, today) ? ' sui-today' : ''}`, part: 'day', 'aria-label': new Intl.DateTimeFormat(this.locale, { dateStyle: 'full' }).format(day) },
        h('header', {}, new Intl.DateTimeFormat(this.locale, { weekday: 'short', day: 'numeric' }).format(day)),
        list.map((e) => this.chip(e, day)));
    }));
  }

  renderAgenda(events) {
    const [from, to] = this.range();
    const days = [];
    for (let d = from; d < to; d = addDays(d, 1)) {
      const list = this.eventsOn(d, events);
      if (list.length) days.push([d, list]);
    }
    if (!days.length) return h('p', { class: 'sui-message', part: 'message empty' }, this.getAttribute('empty-text') || 'No events in this period.');
    return h('ol', { class: 'sui-agenda', part: 'agenda' }, days.map(([day, list]) => h('li', {},
      h('h3', { part: 'agenda-day' }, new Intl.DateTimeFormat(this.locale, { weekday: 'long', month: 'long', day: 'numeric' }).format(day)),
      h('ul', {}, list.map((e) => h('li', {},
        h('button', { type: 'button', class: 'sui-agenda-item', part: 'event', style: e.color ? `--_c: ${e.color}` : null, onclick: () => this.show(e) },
          h('span', { class: 'sui-agenda-time' }, e.info.allDay || !sameDay(toDate(e.info.start), day) ? 'All day' : formatTime(e.info.start, this.locale)),
          h('span', { class: 'sui-agenda-title' }, e.info.title, e.info.venue ? h('span', { class: 'sui-agenda-venue' }, e.info.venue) : null))))))));
  }

  popup(...content) {
    this._dialog.replaceChildren(h('div', { class: 'sui-pop', part: 'popup-body' },
      h('button', { type: 'button', class: 'sui-pop-close', 'aria-label': 'Close', onclick: () => this._dialog.close() }, '✕'), ...content));
    this._dialog.showModal();
  }

  show(e) {
    const { info, item } = e;
    this.dispatchEvent(new CustomEvent('stream-select', { detail: { item, info }, bubbles: true, composed: true }));
    this.popup(
      h('h3', { part: 'popup-title' }, info.title),
      h('div', { class: 'sui-date' }, this.dateLabel(info)),
      info.venue ? h('div', { class: 'sui-meta' }, info.venue) : null,
      info.image?.src ? h('img', { class: 'sui-image', src: info.image.src, alt: info.image.alt }) : null,
      info.description ? h('p', { class: 'sui-description' }, info.description) : null,
      info.link ? h('a', { href: info.link, part: 'popup-link' }, this.getAttribute('link-label') || 'More details →') : null);
  }

  showDay(day, list) {
    this.popup(
      h('h3', {}, new Intl.DateTimeFormat(this.locale, { dateStyle: 'full' }).format(day)),
      h('ul', { class: 'sui-pop-list' }, list.map((e) => h('li', {}, this.chip(e, day)))));
  }
}
