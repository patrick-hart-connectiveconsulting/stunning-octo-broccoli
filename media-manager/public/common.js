// Helpers shared by every admin page.

export const $ = (sel, root = document) => root.querySelector(sel);

/** Tiny DOM builder. Text is always set via textContent, never innerHTML. */
export function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k in el && typeof v !== 'string') el[k] = v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat()) {
    if (c == null || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return el;
}

/** Builds an inline SVG icon from static, trusted markup. */
export function svg(markup, viewBox = '0 0 24 24') {
  const el = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  el.setAttribute('viewBox', viewBox);
  el.setAttribute('aria-hidden', 'true');
  el.innerHTML = markup;
  return el;
}

export function safeStorage(op, key, value) {
  try {
    if (op === 'get') return localStorage.getItem(key);
    if (op === 'set') localStorage.setItem(key, value);
    if (op === 'del') localStorage.removeItem(key);
  } catch { /* storage unavailable (private mode, blocked) */ }
  return null;
}

// ---- auth ------------------------------------------------------------------

let token = safeStorage('get', 'mm-token') || '';
export const getToken = () => token;

export function promptToken() {
  const value = prompt('This server requires an API token for changes.\nEnter the MEDIA_API_TOKEN value:', token);
  if (value === null) return;
  token = value.trim();
  if (token) safeStorage('set', 'mm-token', token);
  else safeStorage('del', 'mm-token');
  updateTokenLabel();
}

let authRequired = false;
function updateTokenLabel() {
  const btn = $('#tokenBtn');
  if (!btn) return;
  btn.hidden = !authRequired;
  $('#tokenLabel').textContent = token ? 'API token set' : 'Set API token';
}

// ---- API -------------------------------------------------------------------

export class ApiError extends Error {
  constructor(message, status, details) {
    super(message);
    this.status = status;
    this.details = details;
  }
}

export async function api(path, { method = 'GET', body, json } = {}) {
  const headers = {};
  if (token) headers.Authorization = `Bearer ${token}`;
  if (json !== undefined) {
    headers['Content-Type'] = 'application/json';
    body = JSON.stringify(json);
  }
  const res = await fetch(path, { method, headers, body });
  const data = await res.json().catch(() => null);
  if (!res.ok) {
    if (res.status === 401) promptToken();
    const err = data?.error;
    const first = err?.details?.errors?.[0];
    const message = first ? `${err.message}: ${first.path} ${first.message}` : err?.message || `Request failed (${res.status})`;
    throw new ApiError(message, res.status, err?.details);
  }
  return data;
}

// ---- UI bits ---------------------------------------------------------------

export function toast(message, type = 'success') {
  const el = h('div', { class: `toast ${type}`, role: type === 'error' ? 'alert' : 'status' }, message);
  $('#toasts').append(el);
  setTimeout(() => el.remove(), type === 'error' ? 6000 : 4000);
}

export function formatBytes(n) {
  if (n == null) return '—';
  if (n < 1024) return `${n} B`;
  const units = ['KB', 'MB', 'GB'];
  let i = -1;
  do { n /= 1024; i++; } while (n >= 1024 && i < units.length - 1);
  return `${n.toFixed(n < 10 ? 1 : 0)} ${units[i]}`;
}

export const formatDate = (iso) =>
  iso ? new Date(iso).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }) : '—';

export function debounce(fn, ms) {
  let t;
  return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), ms); };
}

export async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    toast('Copied to clipboard');
  } catch {
    prompt('Copy this:', text);
  }
}

/** Wires up the parts of the page shell every admin page shares. Returns /api/config. */
export async function initShell() {
  document.querySelectorAll('[data-close]').forEach((b) => b.addEventListener('click', () => b.closest('dialog').close()));
  $('#tokenBtn')?.addEventListener('click', promptToken);
  let config = { authRequired: false, maxFileSize: 0 };
  try {
    config = await api('/api/config');
  } catch { /* fall back to defaults */ }
  authRequired = config.authRequired;
  updateTokenLabel();
  return config;
}
