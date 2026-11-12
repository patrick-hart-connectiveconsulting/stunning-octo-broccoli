// Media Library admin page — vanilla JS, no build step.

import { $, h, svg, api, toast, formatBytes, formatDate, debounce, copyText, getToken, promptToken, initShell } from './common.js';

const ICONS = {
  folder: '<path d="M3 6a2 2 0 012-2h4l2 2h8a2 2 0 012 2v10a2 2 0 01-2 2H5a2 2 0 01-2-2z" fill="currentColor"/>',
  file: '<path d="M6 2h8l6 6v14H6z" fill="none" stroke="currentColor" stroke-width="1.5"/><path d="M14 2v6h6" fill="none" stroke="currentColor" stroke-width="1.5"/>',
  audio: '<path d="M9 18V5l12-2v13" fill="none" stroke="currentColor" stroke-width="1.5"/><circle cx="6" cy="18" r="3" fill="none" stroke="currentColor" stroke-width="1.5"/><circle cx="18" cy="16" r="3" fill="none" stroke="currentColor" stroke-width="1.5"/>',
  play: '<path d="M8 5v14l11-7z" fill="currentColor"/>',
};

// ---- state -----------------------------------------------------------------

const state = {
  folder: null, // current folder id (null = root)
  q: '',
  type: '',
  sort: 'createdAt:desc',
  page: 1,
  pageSize: 24,
  files: [],
  pagination: null,
  selected: new Set(),
  allFolders: [],
  config: { authRequired: false, maxFileSize: 0 },
};

// ---- API -------------------------------------------------------------------

/** Upload with progress events (fetch can't report upload progress). */
function uploadWithProgress(path, formData, onProgress) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', path);
    if (getToken()) xhr.setRequestHeader('Authorization', `Bearer ${getToken()}`);
    xhr.upload.onprogress = (e) => e.lengthComputable && onProgress(e.loaded / e.total);
    xhr.onload = () => {
      let data = null;
      try { data = JSON.parse(xhr.responseText); } catch { /* ignore */ }
      if (xhr.status >= 200 && xhr.status < 300) resolve(data);
      else {
        if (xhr.status === 401) promptToken();
        reject(new Error(data?.error?.message || `Upload failed (${xhr.status})`));
      }
    };
    xhr.onerror = () => reject(new Error('Network error'));
    xhr.send(formData);
  });
}

// ---- helpers ---------------------------------------------------------------

const kind = (mime) => (mime.startsWith('image/') ? 'image' : mime.startsWith('video/') ? 'video' : mime.startsWith('audio/') ? 'audio' : 'file');
const extLabel = (f) => (f.ext || '').replace('.', '') || f.mime.split('/')[1] || 'file';
const absoluteUrl = (url) => new URL(url, location.origin).href;

function folderLabel(f) {
  return f.path.map((p) => p.name).join(' / ');
}

function fillFolderSelect(select, selected, { exclude } = {}) {
  select.replaceChildren(h('option', { value: '' }, 'Media Library (root)'));
  for (const f of state.allFolders) {
    if (exclude && (f.id === exclude || f.path.some((p) => p.id === exclude))) continue;
    select.append(h('option', { value: f.id, selected: f.id === selected }, folderLabel(f)));
  }
  select.value = selected || '';
}

function preview(file, { large = false } = {}) {
  const k = kind(file.mime);
  if (k === 'image') {
    return h('div', { class: 'thumb' }, h('img', { src: file.url, alt: file.alternativeText || '', loading: 'lazy' }));
  }
  if (k === 'video') {
    return h('div', { class: 'thumb' },
      h('video', { src: file.url, preload: 'metadata', muted: true, controls: large }),
      large ? null : h('span', { class: 'play' }, svg(ICONS.play)));
  }
  if (k === 'audio' && large) {
    return h('div', { class: 'thumb file' }, h('audio', { src: file.url, controls: true }));
  }
  return h('div', { class: 'thumb file' }, svg(k === 'audio' ? ICONS.audio : ICONS.file));
}

// ---- rendering -------------------------------------------------------------

async function loadFolders() {
  const { data } = await api('/api/upload/folders');
  state.allFolders = data.sort((a, b) => folderLabel(a).localeCompare(folderLabel(b)));
}

async function load() {
  const params = new URLSearchParams({
    sort: state.sort,
    page: state.page,
    pageSize: state.pageSize,
  });
  if (state.q) params.set('q', state.q);
  if (state.type) params.set('type', state.type);
  // While searching or filtering, search across all folders like Strapi does.
  if (!state.q && !state.type) params.set('folder', state.folder || 'root');

  try {
    const [{ data, meta }] = await Promise.all([api(`/api/upload/files?${params}`), loadFolders()]);
    if (state.page > meta.pagination.pageCount) {
      state.page = meta.pagination.pageCount;
      return load();
    }
    state.files = data;
    state.pagination = meta.pagination;
    state.selected = new Set([...state.selected].filter((id) => data.some((f) => f.id === id)));
    render();
  } catch (err) {
    toast(err.message, 'error');
  }
}

function render() {
  renderBreadcrumbs();
  renderFolders();
  renderAssets();
  renderPagination();
  renderBulk();

  const total = state.pagination.total;
  const filtering = state.q || state.type;
  $('#summary').textContent = `${total} asset${total === 1 ? '' : 's'}${filtering ? ' found' : ''}`;
  $('#assetCount').textContent = `(${total})`;
}

function renderBreadcrumbs() {
  const nav = $('#breadcrumbs');
  const current = state.allFolders.find((f) => f.id === state.folder);
  const trail = [{ id: null, name: 'Media Library' }, ...(current?.path || [])];
  nav.replaceChildren();
  trail.forEach((crumb, i) => {
    if (i) nav.append(h('span', { class: 'sep' }, '/'));
    if (i === trail.length - 1) nav.append(h('span', { class: 'current' }, crumb.name));
    else nav.append(h('a', { href: '#', onclick: (e) => { e.preventDefault(); openFolder(crumb.id); } }, crumb.name));
  });
  if (current) {
    nav.append(h('button', {
      class: 'icon-btn', title: 'Edit folder', 'aria-label': 'Edit folder', style: 'margin-left:8px;width:28px;height:28px',
      onclick: () => editFolder(current),
    }, '✎'));
  }
}

function renderFolders() {
  const filtering = state.q || state.type;
  const folders = filtering ? [] : state.allFolders.filter((f) => f.parent === state.folder);
  $('#foldersSection').hidden = folders.length === 0;
  $('#folderCount').textContent = `(${folders.length})`;
  $('#folders').replaceChildren(...folders.map((f) =>
    h('div', {
      class: 'folder-card', tabindex: 0, role: 'button',
      onclick: () => openFolder(f.id),
      onkeydown: (e) => e.key === 'Enter' && openFolder(f.id),
    },
    h('span', { class: 'folder-icon' }, svg(ICONS.folder)),
    h('div', { class: 'folder-text' },
      h('div', { class: 'folder-name', title: f.name }, f.name),
      h('div', { class: 'folder-sub' }, `${f.children.folders} folder${f.children.folders === 1 ? '' : 's'}, ${f.children.files} asset${f.children.files === 1 ? '' : 's'}`)),
    h('button', {
      class: 'icon-btn', title: 'Edit folder', 'aria-label': `Edit ${f.name}`,
      onclick: (e) => { e.stopPropagation(); editFolder(f); },
    }, '✎')),
  ));
}

function renderAssets() {
  const grid = $('#assets');
  grid.replaceChildren(...state.files.map((f) => {
    const selected = state.selected.has(f.id);
    const sub = [f.width && f.height ? `${f.width}×${f.height}` : null, formatBytes(f.size)].filter(Boolean).join(' · ');
    return h('article', {
      class: `asset-card${selected ? ' selected' : ''}`, tabindex: 0,
      onclick: () => openAsset(f),
      onkeydown: (e) => e.key === 'Enter' && openAsset(f),
    },
    h('label', { class: 'check', onclick: (e) => e.stopPropagation() },
      h('input', {
        type: 'checkbox', checked: selected, 'aria-label': `Select ${f.name}`,
        onchange: (e) => { e.target.checked ? state.selected.add(f.id) : state.selected.delete(f.id); renderAssets(); renderBulk(); },
      })),
    preview(f),
    h('div', { class: 'asset-info' },
      h('div', { style: 'min-width:0' },
        h('div', { class: 'asset-name', title: f.name }, f.name),
        h('div', { class: 'asset-sub' }, sub),
        (state.q || state.type) && f.folderPath.length
          ? h('div', { class: 'asset-sub' }, `in ${f.folderPath.map((p) => p.name).join(' / ')}`)
          : null),
      h('span', { class: 'badge' }, extLabel(f))));
  }));

  const empty = state.files.length === 0;
  $('#empty').hidden = !empty;
  $('#emptyText').textContent = state.q || state.type
    ? 'No assets match your search.'
    : state.folder ? 'This folder has no assets yet.' : 'Upload your first assets…';
  $('#emptyUpload').hidden = Boolean(state.q || state.type);
}

function renderPagination() {
  const { page, pageCount } = state.pagination;
  const pages = h('div', { class: 'pages' });
  const btn = (label, target, opts = {}) => h('button', {
    class: `page-btn${opts.active ? ' active' : ''}`, disabled: opts.disabled, 'aria-label': opts.label,
    onclick: () => { state.page = target; load(); },
  }, label);

  pages.append(btn('‹', page - 1, { disabled: page === 1, label: 'Previous page' }));
  const shown = new Set([1, pageCount, page - 1, page, page + 1].filter((p) => p >= 1 && p <= pageCount));
  let prev = 0;
  for (const p of [...shown].sort((a, b) => a - b)) {
    if (p - prev > 1) pages.append(h('span', { class: 'page-btn', 'aria-hidden': 'true' }, '…'));
    pages.append(btn(p, p, { active: p === page }));
    prev = p;
  }
  pages.append(btn('›', page + 1, { disabled: page === pageCount, label: 'Next page' }));

  const size = h('select', {
    'aria-label': 'Entries per page',
    onchange: (e) => { state.pageSize = Number(e.target.value); state.page = 1; load(); },
  }, ...[12, 24, 48, 96].map((n) => h('option', { value: n, selected: n === state.pageSize }, n)));

  $('#pagination').replaceChildren(h('div', { class: 'page-size' }, size, 'entries per page'), pages);
}

function renderBulk() {
  const n = state.selected.size;
  $('#bulkBar').hidden = n === 0;
  $('#bulkCount').textContent = `${n} asset${n === 1 ? '' : 's'} selected`;
  const all = $('#selectAll');
  all.checked = n > 0 && n === state.files.length;
  all.indeterminate = n > 0 && n < state.files.length;
}

function openFolder(id) {
  state.folder = id;
  state.page = 1;
  state.selected.clear();
  const url = new URL(location);
  if (id) url.searchParams.set('folder', id); else url.searchParams.delete('folder');
  history.pushState({ folder: id }, '', url);
  load();
}

// ---- upload ----------------------------------------------------------------

const queue = [];

function openUpload(files) {
  queue.length = 0;
  $('#queue').replaceChildren();
  const dest = state.allFolders.find((f) => f.id === state.folder);
  $('#uploadDest').textContent = `Uploading to: ${dest ? `Media Library / ${folderLabel(dest)}` : 'Media Library'}`;
  $('#uploadLimit').textContent = state.config.maxFileSize ? `Max ${formatBytes(state.config.maxFileSize)} per file` : '';
  if (files?.length) addToQueue(files);
  updateUploadButton();
  if (!$('#uploadDialog').open) $('#uploadDialog').showModal();
}

function addToQueue(fileList) {
  for (const file of fileList) {
    const tooBig = state.config.maxFileSize && file.size > state.config.maxFileSize;
    const item = { file, status: tooBig ? 'error' : 'pending' };
    item.bar = h('span');
    item.err = h('div', { class: 'qerr' }, tooBig ? 'File is too large' : '');
    item.el = h('li', { class: tooBig ? 'error' : '' },
      h('span', { class: 'qname', title: file.name }, file.name),
      h('span', { class: 'qsize' }, formatBytes(file.size)),
      h('button', {
        type: 'button', class: 'remove', 'aria-label': `Remove ${file.name}`,
        onclick: () => { queue.splice(queue.indexOf(item), 1); item.el.remove(); updateUploadButton(); },
      }, '✕'),
      h('div', { class: 'bar' }, item.bar),
      item.err);
    queue.push(item);
    $('#queue').append(item.el);
  }
  updateUploadButton();
}

function updateUploadButton() {
  const n = queue.filter((q) => q.status === 'pending').length;
  const btn = $('#startUpload');
  btn.disabled = n === 0;
  btn.textContent = n ? `Upload ${n} asset${n === 1 ? '' : 's'}` : 'Upload assets';
}

async function startUpload() {
  const pending = queue.filter((q) => q.status === 'pending');
  $('#startUpload').disabled = true;
  let ok = 0;
  // Upload a few at a time so a large batch doesn't open dozens of connections.
  const workers = Array.from({ length: Math.min(3, pending.length) }, async () => {
    while (pending.length) {
      const item = pending.shift();
      item.status = 'uploading';
      item.el.querySelector('.remove').disabled = true;
      const fd = new FormData();
      fd.append('files', item.file);
      if (state.folder) fd.append('folder', state.folder);
      try {
        await uploadWithProgress('/api/upload', fd, (p) => { item.bar.style.width = `${Math.round(p * 100)}%`; });
        item.status = 'done';
        item.bar.style.width = '100%';
        item.el.classList.add('done');
        ok++;
      } catch (err) {
        item.status = 'error';
        item.el.classList.add('error');
        item.err.textContent = err.message;
      }
    }
  });
  await Promise.all(workers);
  if (ok) toast(`${ok} asset${ok === 1 ? '' : 's'} uploaded`);
  if (queue.every((q) => q.status === 'done')) $('#uploadDialog').close();
  updateUploadButton();
  state.page = 1;
  load();
}

// ---- asset details ---------------------------------------------------------

let currentAsset = null;

function openAsset(file) {
  currentAsset = file;
  const form = $('#assetForm');
  form.name.value = file.name;
  form.alternativeText.value = file.alternativeText || '';
  form.caption.value = file.caption || '';
  fillFolderSelect($('#assetFolder'), file.folder);

  const p = preview(file, { large: true });
  p.classList.add('preview');
  $('#assetPreview').replaceWith(p);
  p.id = 'assetPreview';

  const meta = [
    ['Size', formatBytes(file.size)],
    ['Dimensions', file.width && file.height ? `${file.width}×${file.height}` : '—'],
    ['Date', formatDate(file.createdAt)],
    ['Extension', extLabel(file)],
    ['MIME type', file.mime],
    ['Asset ID', file.id.slice(0, 8)],
  ];
  $('#assetMeta').replaceChildren(...meta.flatMap(([k, v]) => [h('div', {}, h('dt', {}, k), h('dd', {}, v))]));
  $('#downloadLink').href = `${file.url}?download`;
  $('#assetDialog').showModal();
}

async function saveAsset(e) {
  e.preventDefault();
  const form = $('#assetForm');
  try {
    await api(`/api/upload/files/${currentAsset.id}`, {
      method: 'PUT',
      json: {
        name: form.name.value,
        alternativeText: form.alternativeText.value,
        caption: form.caption.value,
        folder: form.folder.value || null,
      },
    });
    $('#assetDialog').close();
    toast('Asset updated');
    load();
  } catch (err) {
    toast(err.message, 'error');
  }
}

async function deleteAssets(ids) {
  const n = ids.length;
  if (!confirm(`Delete ${n === 1 ? 'this asset' : `${n} assets`}? This cannot be undone.`)) return false;
  const results = await Promise.allSettled(ids.map((id) => api(`/api/upload/files/${id}`, { method: 'DELETE' })));
  const failed = results.filter((r) => r.status === 'rejected');
  if (failed.length) toast(failed[0].reason.message, 'error');
  const done = n - failed.length;
  if (done) toast(`${done} asset${done === 1 ? '' : 's'} deleted`);
  ids.forEach((id) => state.selected.delete(id));
  load();
  return failed.length === 0;
}

async function replaceAsset(file) {
  const fd = new FormData();
  fd.append('files', file);
  try {
    const updated = await uploadWithProgress(`/api/upload?id=${encodeURIComponent(currentAsset.id)}`, fd, () => {});
    toast('Media replaced');
    openAsset(updated);
    load();
  } catch (err) {
    toast(err.message, 'error');
  }
}

// ---- folders ---------------------------------------------------------------

let editingFolder = null;

function editFolder(folder = null) {
  editingFolder = folder;
  const form = $('#folderForm');
  $('#folderDialogTitle').textContent = folder ? 'Edit folder' : 'Add new folder';
  form.name.value = folder?.name || '';
  fillFolderSelect($('#folderParent'), folder ? folder.parent : state.folder, { exclude: folder?.id });
  $('#deleteFolder').hidden = !folder;
  $('#folderDialog').showModal();
  form.name.focus();
}

async function saveFolder(e) {
  e.preventDefault();
  const form = $('#folderForm');
  const json = { name: form.name.value, parent: form.parent.value || null };
  try {
    if (editingFolder) await api(`/api/upload/folders/${editingFolder.id}`, { method: 'PUT', json });
    else await api('/api/upload/folders', { method: 'POST', json });
    $('#folderDialog').close();
    toast(editingFolder ? 'Folder updated' : 'Folder created');
    load();
  } catch (err) {
    toast(err.message, 'error');
  }
}

async function removeFolder() {
  if (!editingFolder || !confirm(`Delete folder "${editingFolder.name}"?`)) return;
  try {
    await api(`/api/upload/folders/${editingFolder.id}`, { method: 'DELETE' });
    $('#folderDialog').close();
    toast('Folder deleted');
    if (state.folder === editingFolder.id) openFolder(editingFolder.parent);
    else load();
  } catch (err) {
    toast(err.message, 'error');
  }
}

// ---- wiring ----------------------------------------------------------------

$('#search').addEventListener('input', debounce((e) => { state.q = e.target.value.trim(); state.page = 1; load(); }, 250));
$('#typeFilter').addEventListener('change', (e) => { state.type = e.target.value; state.page = 1; load(); });
$('#sort').addEventListener('change', (e) => { state.sort = e.target.value; load(); });
$('#selectAll').addEventListener('change', (e) => {
  state.selected = e.target.checked ? new Set(state.files.map((f) => f.id)) : new Set();
  renderAssets();
  renderBulk();
});
$('#bulkDelete').addEventListener('click', () => deleteAssets([...state.selected]));
$('#bulkMove').addEventListener('click', () => {
  fillFolderSelect($('#moveFolder'), state.folder);
  $('#moveDialog').showModal();
});
$('#moveForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const folder = $('#moveFolder').value || null;
  const ids = [...state.selected];
  const results = await Promise.allSettled(ids.map((id) => api(`/api/upload/files/${id}`, { method: 'PUT', json: { folder } })));
  const failed = results.filter((r) => r.status === 'rejected');
  if (failed.length) toast(failed[0].reason.message, 'error');
  else toast(`${ids.length} asset${ids.length === 1 ? '' : 's'} moved`);
  $('#moveDialog').close();
  state.selected.clear();
  load();
});

$('#uploadBtn').addEventListener('click', () => openUpload());
$('#emptyUpload').addEventListener('click', () => openUpload());
$('#newFolderBtn').addEventListener('click', () => editFolder());
$('[data-nav=root]').addEventListener('click', (e) => { e.preventDefault(); openFolder(null); });

$('#fileInput').addEventListener('change', (e) => { addToQueue(e.target.files); e.target.value = ''; });
$('#startUpload').addEventListener('click', startUpload);
const dz = $('#dropzone');
dz.addEventListener('dragover', (e) => { e.preventDefault(); dz.classList.add('over'); });
dz.addEventListener('dragleave', () => dz.classList.remove('over'));
dz.addEventListener('drop', (e) => { e.preventDefault(); e.stopPropagation(); dz.classList.remove('over'); addToQueue(e.dataTransfer.files); });

$('#assetForm').addEventListener('submit', saveAsset);
$('#deleteAsset').addEventListener('click', async () => {
  if (await deleteAssets([currentAsset.id])) $('#assetDialog').close();
});
$('#copyLink').addEventListener('click', () => copyText(absoluteUrl(currentAsset.url)));
$('#replaceBtn').addEventListener('click', () => $('#replaceInput').click());
$('#replaceInput').addEventListener('change', (e) => {
  if (e.target.files[0]) replaceAsset(e.target.files[0]);
  e.target.value = '';
});
$('#assetDialog').addEventListener('close', () => {
  // Stop any playing media when the dialog closes.
  $('#assetPreview').querySelectorAll('video,audio').forEach((m) => m.pause());
});

$('#folderForm').addEventListener('submit', saveFolder);
$('#deleteFolder').addEventListener('click', removeFolder);

// Page-wide drag & drop opens the upload dialog.
let dragDepth = 0;
const hasFiles = (e) => [...(e.dataTransfer?.types || [])].includes('Files');
window.addEventListener('dragenter', (e) => { if (hasFiles(e) && !$('#uploadDialog').open) { dragDepth++; $('#dropOverlay').hidden = false; } });
window.addEventListener('dragleave', () => { if (dragDepth && --dragDepth === 0) $('#dropOverlay').hidden = true; });
window.addEventListener('dragover', (e) => { if (hasFiles(e)) e.preventDefault(); });
window.addEventListener('drop', (e) => {
  if (!hasFiles(e)) return;
  e.preventDefault();
  dragDepth = 0;
  $('#dropOverlay').hidden = true;
  openUpload(e.dataTransfer.files);
});

window.addEventListener('popstate', () => {
  state.folder = new URL(location).searchParams.get('folder');
  state.page = 1;
  load();
});

(async function init() {
  state.folder = new URL(location).searchParams.get('folder');
  state.config = await initShell();
  await load();
})();
