// Streams UI — <stream-map>: items with a map pin on an interactive map.
// Uses the bundled Leaflet 1.9.4 (BSD-2-Clause) and OpenStreetMap tiles by default.

import { StreamElement, h } from './base.js';

const LEAFLET_JS = new URL('./vendor/leaflet/leaflet.js', import.meta.url).href;
const LEAFLET_CSS = new URL('./vendor/leaflet/leaflet.css', import.meta.url).href;
const OSM_TILES = 'https://tile.openstreetmap.org/{z}/{x}/{y}.png';
const OSM_ATTRIBUTION = '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors';

let leafletPromise = null;
function loadLeaflet(src) {
  if (window.L?.map) return Promise.resolve(window.L);
  leafletPromise ??= new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = src;
    s.async = true;
    s.onload = () => (window.L?.map ? resolve(window.L) : reject(new Error('The map library did not load')));
    s.onerror = () => {
      leafletPromise = null;
      reject(new Error('The map library could not be loaded'));
    };
    document.head.append(s);
  });
  return leafletPromise;
}

export class StreamMap extends StreamElement {
  static defaultLimit = 200;
  static emptyText = 'No locations to show.';
  static extraAttributes = ['height', 'tiles', 'attribution', 'zoom', 'max-zoom', 'leaflet-src'];
  static css = `
.sui-map { width: 100%; height: var(--_h, 420px); border-radius: var(--_radius); overflow: hidden; border: 1px solid var(--_border); background: #e8eef3; }
.sui-pin { display: block; width: 26px; height: 26px; border-radius: 50% 50% 50% 0; transform: rotate(-45deg); background: var(--_accent); border: 3px solid #fff; box-shadow: 0 2px 6px rgba(0,0,0,.35); }
.sui-pin-wrap:focus-visible .sui-pin { outline: 3px solid #111; }
.leaflet-popup-content { margin: 12px 14px; font: inherit; }
.leaflet-popup-content .sui-title { font-size: 1em; }
.leaflet-popup-content p { margin: 4px 0 0; }
.leaflet-container { font: inherit; }
.sui-map-fallback { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 8px; }
`;

  renderView(items) {
    this._points = items.map((item) => ({ item, info: this.info(item) })).filter(({ info }) => info.pin && Number.isFinite(info.pin.lat));
    if (!this._points.length) return h('p', { class: 'sui-message', part: 'message empty' }, this.getAttribute('empty-text') || this.constructor.emptyText);
    const height = this.getAttribute('height');
    this._el = h('div', { class: 'sui-map', part: 'map', role: 'region', 'aria-label': `Map: ${this.stream?.name || 'locations'}`, style: height ? `--_h: ${/^\d+$/.test(height) ? `${height}px` : height}` : null });
    const css = h('link', { rel: 'stylesheet', href: LEAFLET_CSS });
    if (this.hasAttribute('unstyled')) {
      if (!document.querySelector(`link[href="${LEAFLET_CSS}"]`)) document.head.append(css);
      return this._el;
    }
    return [css, this._el];
  }

  async afterRender() {
    this._map?.remove();
    this._map = null;
    if (!this._el) return;
    const el = this._el;
    let L;
    try {
      L = await loadLeaflet(this.getAttribute('leaflet-src') || LEAFLET_JS);
    } catch (err) {
      // Without the map library (offline, or blocked by a Content-Security-Policy), list the places instead.
      el.replaceWith(h('ul', { class: 'sui-map-fallback', part: 'fallback' }, this._points.map(({ info }) => h('li', {},
        h('strong', {}, info.title), ' — ',
        h('a', { href: `https://www.openstreetmap.org/?mlat=${info.pin.lat}&mlon=${info.pin.lng}#map=15/${info.pin.lat}/${info.pin.lng}`, target: '_blank', rel: 'noopener' },
          info.venue || `${info.pin.lat.toFixed(4)}, ${info.pin.lng.toFixed(4)}`)))));
      this.dispatchEvent(new CustomEvent('stream-error', { detail: { error: err }, bubbles: true, composed: true }));
      return;
    }
    if (el !== this._el || !el.isConnected) return; // re-rendered meanwhile
    const map = L.map(el, { scrollWheelZoom: false, maxZoom: parseInt(this.getAttribute('max-zoom'), 10) || 19 });
    this._map = map;
    L.tileLayer(this.getAttribute('tiles') || OSM_TILES, {
      attribution: this.getAttribute('attribution') || (this.getAttribute('tiles') ? '' : OSM_ATTRIBUTION),
      maxZoom: parseInt(this.getAttribute('max-zoom'), 10) || 19,
    }).addTo(map);
    const icon = L.divIcon({ className: 'sui-pin-wrap', html: '<span class="sui-pin" part="pin"></span>', iconSize: [26, 34], iconAnchor: [13, 34], popupAnchor: [0, -30] });
    const bounds = [];
    for (const { item, info } of this._points) {
      const marker = L.marker([info.pin.lat, info.pin.lng], { icon, title: info.title, alt: info.title, keyboard: true }).addTo(map);
      const dateText = this.dateLabel(info);
      marker.bindPopup(h('div', { part: 'popup' },
        h('div', { class: 'sui-title' }, info.link ? h('a', { href: info.link }, info.title) : info.title),
        dateText ? h('div', { class: 'sui-date' }, dateText) : null,
        info.venue ? h('div', { class: 'sui-meta' }, info.venue) : null,
        info.description ? h('p', { class: 'sui-description' }, info.description) : null));
      marker.on('click', () => this.dispatchEvent(new CustomEvent('stream-select', { detail: { item, info }, bubbles: true, composed: true })));
      bounds.push([info.pin.lat, info.pin.lng]);
    }
    const zoom = parseInt(this.getAttribute('zoom'), 10);
    if (bounds.length === 1 || Number.isFinite(zoom)) map.setView(bounds.length === 1 ? bounds[0] : L.latLngBounds(bounds).getCenter(), Number.isFinite(zoom) ? zoom : 13);
    else map.fitBounds(bounds, { padding: [36, 36], maxZoom: 15 });
    // Let wheel zoom work after the user clicks into the map (avoids hijacking page scroll).
    map.once('focus', () => map.scrollWheelZoom.enable());
    this._ro?.disconnect();
    if ('ResizeObserver' in window) {
      this._ro = new ResizeObserver(() => map.invalidateSize());
      this._ro.observe(el);
    }
  }

  teardown() {
    this._ro?.disconnect();
    this._map?.remove();
    this._map = null;
  }
}
