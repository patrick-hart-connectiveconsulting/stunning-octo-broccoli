import http from 'node:http';
import { createReadStream } from 'node:fs';
import { stat, writeFile, unlink, mkdir } from 'node:fs/promises';
import { join, resolve, extname, sep } from 'node:path';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { fileURLToPath } from 'node:url';

import { Store } from './store.js';
import { HttpError, send, readBody, readJson, paginate } from './http.js';
import { createStreamsApi } from './streams.js';
import { imageSize } from './image-size.js';
import { mimeFromExt, fileCategory } from './mime.js';

const ROOT = resolve(fileURLToPath(import.meta.url), '../..');

const STORED_NAME = /^[a-f0-9]{32}(\.[a-z0-9]{1,10})?$/;
// Types a browser could execute as active content if opened from our origin.
const ACTIVE_CONTENT = new Set(['text/html', 'image/svg+xml', 'application/xml']);

export async function createApp(options = {}) {
  const config = {
    dataDir: options.dataDir ?? process.env.MEDIA_DATA_DIR ?? join(ROOT, 'data'),
    publicDir: options.publicDir ?? join(ROOT, 'public'),
    token: options.token ?? process.env.MEDIA_API_TOKEN ?? '',
    maxFileSize: options.maxFileSize ?? Number(process.env.MEDIA_MAX_FILE_SIZE || 50 * 1024 * 1024),
  };
  const uploadDir = join(config.dataDir, 'uploads');
  await mkdir(uploadDir, { recursive: true });
  const store = await new Store(join(config.dataDir, 'db.json')).load();

  // ---- helpers -------------------------------------------------------------

  const readForm = async (req) => {
    const type = req.headers['content-type'] || '';
    if (!type.startsWith('multipart/form-data')) throw new HttpError(400, 'Expected multipart/form-data');
    // Allow a little room for multipart framing on top of the per-file cap;
    // individual files are re-checked below.
    const body = await readBody(req, config.maxFileSize * 20 + 1024 * 1024);
    try {
      return await new Request('http://local/', { method: 'POST', headers: { 'content-type': type }, body }).formData();
    } catch {
      throw new HttpError(400, 'Malformed multipart body');
    }
  };

  const authorize = (req) => {
    if (!config.token) return;
    const header = req.headers.authorization || '';
    const given = Buffer.from(header.startsWith('Bearer ') ? header.slice(7) : '');
    const expected = Buffer.from(config.token);
    if (given.length !== expected.length || !timingSafeEqual(given, expected)) {
      throw new HttpError(401, 'Missing or invalid API token');
    }
  };

  const cleanText = (value, field, { max = 1000, required = false } = {}) => {
    if (value === undefined) return undefined;
    if (value === null) {
      if (required) throw new HttpError(400, `${field} is required`);
      return null;
    }
    if (typeof value !== 'string') throw new HttpError(400, `${field} must be a string`);
    const v = value.trim();
    if (required && !v) throw new HttpError(400, `${field} is required`);
    if (v.length > max) throw new HttpError(400, `${field} is too long (max ${max})`);
    return v;
  };

  const folderRef = (value) => {
    if (value === undefined) return undefined;
    if (value === null || value === '' || value === 'root') return null;
    if (!store.getFolder(value)) throw new HttpError(400, 'Folder does not exist');
    return value;
  };

  const withFolder = (file) => ({ ...file, folderPath: store.folderPath(file.folder) });

  const storeBinary = async (blob) => {
    if (blob.size > config.maxFileSize) {
      throw new HttpError(413, `"${blob.name}" exceeds the ${formatBytes(config.maxFileSize)} limit`);
    }
    const rawExt = extname(blob.name || '').toLowerCase();
    const ext = /^\.[a-z0-9]{1,10}$/.test(rawExt) ? rawExt : '';
    const hash = randomBytes(16).toString('hex');
    const buf = Buffer.from(await blob.arrayBuffer());
    await writeFile(join(uploadDir, hash + ext), buf);
    const mime = mimeFromExt(ext) !== 'application/octet-stream' ? mimeFromExt(ext) : blob.type || 'application/octet-stream';
    const dims = mime.startsWith('image/') ? imageSize(buf) : null;
    return {
      hash,
      ext,
      mime,
      size: buf.length,
      width: dims?.width ?? null,
      height: dims?.height ?? null,
      url: `/uploads/${hash}${ext}`,
    };
  };

  const deleteBinary = (file) => unlink(join(uploadDir, file.hash + file.ext)).catch(() => {});

  const streams = await createStreamsApi({ store, dataDir: config.dataDir, authorize });

  // ---- route handlers ------------------------------------------------------

  async function listFiles(req, res, url) {
    const q = (url.searchParams.get('q') || '').toLowerCase().trim();
    const type = url.searchParams.get('type');
    const folder = url.searchParams.get('folder');
    const [sortField, sortDir] = (url.searchParams.get('sort') || 'createdAt:desc').split(':');
    let items = store.data.files;
    if (folder !== null) {
      const id = folder === '' || folder === 'root' ? null : folder;
      items = items.filter((f) => (f.folder ?? null) === id);
    }
    if (type) items = items.filter((f) => fileCategory(f.mime) === type);
    if (q) {
      items = items.filter((f) =>
        [f.name, f.alternativeText, f.caption].some((v) => v && v.toLowerCase().includes(q)),
      );
    }
    const field = ['name', 'createdAt', 'updatedAt', 'size'].includes(sortField) ? sortField : 'createdAt';
    const dir = sortDir === 'asc' ? 1 : -1;
    items = [...items].sort((a, b) => {
      const av = a[field];
      const bv = b[field];
      const cmp = typeof av === 'number' ? av - bv : String(av).localeCompare(String(bv), undefined, { sensitivity: 'base' });
      return cmp * dir;
    });

    const result = paginate(items, url, { defaultSize: 24 });
    send(res, 200, { ...result, data: result.data.map(withFolder) });
  }

  async function upload(req, res, url) {
    authorize(req);
    const form = await readForm(req);
    const blobs = form.getAll('files').filter((v) => typeof v === 'object');
    if (!blobs.length) throw new HttpError(400, 'No files provided (use the "files" field)');

    // Replace an existing file's binary: POST /api/upload?id=<fileId>
    const replaceId = url.searchParams.get('id');
    if (replaceId) {
      const existing = store.getFile(replaceId);
      if (!existing) throw new HttpError(404, 'File not found');
      const info = await storeBinary(blobs[0]);
      await deleteBinary(existing);
      const updated = await store.updateFile(replaceId, info);
      return send(res, 200, withFolder(updated));
    }

    let infos = [];
    const rawInfo = form.get('fileInfo');
    if (rawInfo) {
      try {
        const parsed = JSON.parse(rawInfo);
        infos = Array.isArray(parsed) ? parsed : [parsed];
      } catch {
        throw new HttpError(400, 'fileInfo must be valid JSON');
      }
    }
    const folder = folderRef(form.get('folder') ?? undefined) ?? null;

    const records = [];
    try {
      for (const [i, blob] of blobs.entries()) {
        const info = infos[i] || {};
        const binary = await storeBinary(blob);
        records.push({
          name: cleanText(info.name, 'name', { max: 255 }) || blob.name || 'untitled',
          alternativeText: cleanText(info.alternativeText, 'alternativeText') ?? null,
          caption: cleanText(info.caption, 'caption') ?? null,
          folder: info.folder !== undefined ? folderRef(info.folder) : folder,
          ...binary,
        });
      }
    } catch (err) {
      // Don't leave orphaned binaries behind if one file in the batch fails.
      await Promise.all(records.map(deleteBinary));
      throw err;
    }
    const created = await store.addFiles(records);
    send(res, 201, created.map(withFolder));
  }

  async function updateFile(req, res, id) {
    authorize(req);
    if (!store.getFile(id)) throw new HttpError(404, 'File not found');
    const body = await readJson(req);
    const patch = {};
    const name = cleanText(body.name, 'name', { max: 255, required: true });
    if (name !== undefined) patch.name = name;
    for (const key of ['alternativeText', 'caption']) {
      const v = cleanText(body[key], key);
      if (v !== undefined) patch[key] = v || null;
    }
    const folder = folderRef(body.folder);
    if (folder !== undefined) patch.folder = folder;
    send(res, 200, withFolder(await store.updateFile(id, patch)));
  }

  async function deleteFile(req, res, id) {
    authorize(req);
    const removed = await store.removeFile(id);
    if (!removed) throw new HttpError(404, 'File not found');
    await deleteBinary(removed);
    send(res, 200, removed);
  }

  const folderSummary = (folder) => ({
    ...folder,
    path: store.folderPath(folder.id),
    children: {
      folders: store.data.folders.filter((f) => f.parent === folder.id).length,
      files: store.data.files.filter((f) => f.folder === folder.id).length,
    },
  });

  const assertUniqueName = (name, parent, exceptId) => {
    const clash = store.data.folders.some(
      (f) => f.parent === parent && f.id !== exceptId && f.name.toLowerCase() === name.toLowerCase(),
    );
    if (clash) throw new HttpError(409, `A folder named "${name}" already exists here`);
  };

  async function listFolders(req, res, url) {
    const parentParam = url.searchParams.get('parent');
    let folders = store.data.folders;
    if (parentParam !== null) {
      const parent = parentParam === '' || parentParam === 'root' ? null : parentParam;
      folders = folders.filter((f) => f.parent === parent);
    }
    const data = [...folders].sort((a, b) => a.name.localeCompare(b.name)).map(folderSummary);
    send(res, 200, { data });
  }

  async function createFolder(req, res) {
    authorize(req);
    const body = await readJson(req);
    const name = cleanText(body.name, 'name', { max: 100, required: true });
    if (name === undefined) throw new HttpError(400, 'name is required');
    const parent = folderRef(body.parent) ?? null;
    assertUniqueName(name, parent);
    send(res, 201, folderSummary(await store.addFolder({ name, parent })));
  }

  async function updateFolder(req, res, id) {
    authorize(req);
    const folder = store.getFolder(id);
    if (!folder) throw new HttpError(404, 'Folder not found');
    const body = await readJson(req);
    const patch = {};
    const parent = folderRef(body.parent);
    if (parent !== undefined) {
      if (parent === id || store.isDescendant(parent, id)) {
        throw new HttpError(400, 'A folder cannot be moved into itself');
      }
      patch.parent = parent;
    }
    const name = cleanText(body.name, 'name', { max: 100, required: true });
    if (name !== undefined) patch.name = name;
    assertUniqueName(patch.name ?? folder.name, patch.parent !== undefined ? patch.parent : folder.parent, id);
    send(res, 200, folderSummary(await store.updateFolder(id, patch)));
  }

  async function deleteFolder(req, res, id) {
    authorize(req);
    const folder = store.getFolder(id);
    if (!folder) throw new HttpError(404, 'Folder not found');
    const { children } = folderSummary(folder);
    if (children.files || children.folders) {
      throw new HttpError(409, 'Folder is not empty — move or delete its contents first');
    }
    send(res, 200, await store.removeFolder(id));
  }

  // ---- static files --------------------------------------------------------

  async function serveFile(req, res, absPath, { mime, sandbox = false, cache = 'no-cache' }) {
    let info;
    try {
      info = await stat(absPath);
      if (!info.isFile()) throw new Error();
    } catch {
      throw new HttpError(404, 'Not found');
    }
    const headers = {
      'Content-Type': mime,
      'Accept-Ranges': 'bytes',
      'Cache-Control': cache,
      'X-Content-Type-Options': 'nosniff',
    };
    // Uploaded HTML/SVG must never run scripts on this origin.
    if (sandbox) headers['Content-Security-Policy'] = "sandbox; default-src 'none'; img-src 'self'; style-src 'unsafe-inline'";

    const range = req.headers.range && /^bytes=(\d*)-(\d*)$/.exec(req.headers.range);
    if (range && (range[1] || range[2])) {
      let start = range[1] ? Number(range[1]) : info.size - Number(range[2]);
      let end = range[1] && range[2] ? Number(range[2]) : info.size - 1;
      start = Math.max(0, start);
      end = Math.min(end, info.size - 1);
      if (start > end) {
        res.writeHead(416, { 'Content-Range': `bytes */${info.size}` });
        return res.end();
      }
      res.writeHead(206, { ...headers, 'Content-Range': `bytes ${start}-${end}/${info.size}`, 'Content-Length': end - start + 1 });
      if (req.method === 'HEAD') return res.end();
      return createReadStream(absPath, { start, end }).pipe(res);
    }
    res.writeHead(200, { ...headers, 'Content-Length': info.size });
    if (req.method === 'HEAD') return res.end();
    createReadStream(absPath).pipe(res);
  }

  async function serveUpload(req, res, name) {
    if (!STORED_NAME.test(name)) throw new HttpError(404, 'Not found');
    const mime = mimeFromExt(extname(name));
    const download = new URL(req.url, 'http://x').searchParams.has('download');
    if (download) {
      const file = store.data.files.find((f) => f.hash + f.ext === name);
      const fname = (file?.name || name).replace(/["\\\r\n]/g, '_');
      res.setHeader('Content-Disposition', `attachment; filename="${fname}"`);
    }
    await serveFile(req, res, join(uploadDir, name), {
      mime,
      sandbox: ACTIVE_CONTENT.has(mime),
      cache: 'public, max-age=31536000, immutable',
    });
  }

  async function servePublic(req, res, pathname) {
    const rel = pathname === '/' ? 'index.html' : decodeURIComponent(pathname.slice(1));
    const abs = resolve(config.publicDir, rel);
    if (!abs.startsWith(resolve(config.publicDir) + sep)) throw new HttpError(404, 'Not found');
    const mime = mimeFromExt(extname(abs)) + (/\.(html|css|js)$/.test(abs) ? '; charset=utf-8' : '');
    await serveFile(req, res, abs, { mime });
  }

  // ---- router --------------------------------------------------------------

  async function route(req, res) {
    const url = new URL(req.url, 'http://localhost');
    const { pathname } = url;
    const m = req.method;
    let match;

    if (pathname === '/api/health' && m === 'GET') return send(res, 200, { ok: true });
    if (pathname === '/api/config' && m === 'GET') {
      return send(res, 200, { authRequired: Boolean(config.token), maxFileSize: config.maxFileSize });
    }
    if (pathname === '/api/upload' && m === 'POST') return upload(req, res, url);
    if (pathname === '/api/upload/files' && m === 'GET') return listFiles(req, res, url);
    if ((match = pathname.match(/^\/api\/upload\/files\/([\w-]+)$/))) {
      const id = match[1];
      if (m === 'GET') {
        const file = store.getFile(id);
        if (!file) throw new HttpError(404, 'File not found');
        return send(res, 200, withFolder(file));
      }
      if (m === 'PUT' || m === 'PATCH') return updateFile(req, res, id);
      if (m === 'DELETE') return deleteFile(req, res, id);
    }
    if (pathname === '/api/upload/folders') {
      if (m === 'GET') return listFolders(req, res, url);
      if (m === 'POST') return createFolder(req, res);
    }
    if ((match = pathname.match(/^\/api\/upload\/folders\/([\w-]+)$/))) {
      const id = match[1];
      if (m === 'GET') {
        const folder = store.getFolder(id);
        if (!folder) throw new HttpError(404, 'Folder not found');
        return send(res, 200, folderSummary(folder));
      }
      if (m === 'PUT' || m === 'PATCH') return updateFolder(req, res, id);
      if (m === 'DELETE') return deleteFolder(req, res, id);
    }
    if ((pathname === '/api/streams' || pathname.startsWith('/api/streams/')) && (await streams.route(req, res, url))) return;
    if (pathname.startsWith('/api/')) throw new HttpError(404, 'Route not found');
    if ((match = pathname.match(/^\/uploads\/([^/]+)$/)) && (m === 'GET' || m === 'HEAD')) {
      return serveUpload(req, res, match[1]);
    }
    if (m === 'GET' || m === 'HEAD') return servePublic(req, res, pathname);
    throw new HttpError(405, 'Method not allowed');
  }

  const server = http.createServer(async (req, res) => {
    try {
      await route(req, res);
    } catch (err) {
      const status = err.status || 500;
      if (status === 500) console.error(err);
      if (!res.headersSent) send(res, status, { error: { status, message: status === 500 ? 'Internal server error' : err.message, ...(err.details ? { details: err.details } : {}) } });
      else res.destroy();
    }
  });

  const close = () => {
    streams.close();
    server.close();
    server.closeAllConnections?.();
  };

  return { server, store, config, close };
}

function formatBytes(n) {
  if (n < 1024) return `${n} B`;
  const units = ['KB', 'MB', 'GB'];
  let i = -1;
  do { n /= 1024; i++; } while (n >= 1024 && i < units.length - 1);
  return `${n.toFixed(n < 10 ? 1 : 0)} ${units[i]}`;
}

// Start when run directly: `node src/server.js`
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const port = Number(process.env.PORT || 1338);
  const host = process.env.HOST || '0.0.0.0';
  const { server, config } = await createApp();
  server.listen(port, host, () => {
    console.log(`Media manager running at http://localhost:${port}`);
    console.log(config.token ? 'API token required for write operations.' : 'Warning: MEDIA_API_TOKEN not set — write API is open.');
  });
}
