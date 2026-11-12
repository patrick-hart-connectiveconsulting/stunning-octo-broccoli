// A tiny JSON-file metadata store. Everything lives in memory and is flushed
// to disk atomically (write temp file + rename) after each mutation. Writes are
// serialised so concurrent requests can never interleave a flush.

import { readFile, writeFile, rename, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';

export class Store {
  constructor(file) {
    this.file = file;
    this.data = { files: [], folders: [], streams: [] };
    this.queue = Promise.resolve();
  }

  async load() {
    await mkdir(dirname(this.file), { recursive: true });
    try {
      const parsed = JSON.parse(await readFile(this.file, 'utf8'));
      this.data.files = parsed.files || [];
      this.data.folders = parsed.folders || [];
      this.data.streams = parsed.streams || [];
    } catch (err) {
      if (err.code !== 'ENOENT') throw err;
      await this.flush();
    }
    return this;
  }

  flush() {
    const snapshot = JSON.stringify(this.data, null, 2);
    const write = this.queue.then(async () => {
      const tmp = `${this.file}.${process.pid}.tmp`;
      await writeFile(tmp, snapshot);
      await rename(tmp, this.file);
    });
    // Keep the chain alive even if one write fails; the caller still sees the error.
    this.queue = write.catch(() => {});
    return write;
  }

  // ---- files -------------------------------------------------------------

  getFile(id) {
    return this.data.files.find((f) => f.id === id) || null;
  }

  async addFiles(records) {
    const now = new Date().toISOString();
    const created = records.map((r) => ({ id: randomUUID(), ...r, createdAt: now, updatedAt: now }));
    this.data.files.push(...created);
    await this.flush();
    return created;
  }

  async updateFile(id, patch) {
    const file = this.getFile(id);
    if (!file) return null;
    Object.assign(file, patch, { updatedAt: new Date().toISOString() });
    await this.flush();
    return file;
  }

  async removeFile(id) {
    const idx = this.data.files.findIndex((f) => f.id === id);
    if (idx === -1) return null;
    const [removed] = this.data.files.splice(idx, 1);
    await this.flush();
    return removed;
  }

  // ---- folders -----------------------------------------------------------

  getFolder(id) {
    return this.data.folders.find((f) => f.id === id) || null;
  }

  folderPath(id) {
    const path = [];
    let cur = id ? this.getFolder(id) : null;
    while (cur) {
      path.unshift({ id: cur.id, name: cur.name });
      cur = cur.parent ? this.getFolder(cur.parent) : null;
    }
    return path;
  }

  isDescendant(folderId, ancestorId) {
    let cur = folderId ? this.getFolder(folderId) : null;
    while (cur) {
      if (cur.id === ancestorId) return true;
      cur = cur.parent ? this.getFolder(cur.parent) : null;
    }
    return false;
  }

  async addFolder({ name, parent = null }) {
    const now = new Date().toISOString();
    const folder = { id: randomUUID(), name, parent, createdAt: now, updatedAt: now };
    this.data.folders.push(folder);
    await this.flush();
    return folder;
  }

  async updateFolder(id, patch) {
    const folder = this.getFolder(id);
    if (!folder) return null;
    Object.assign(folder, patch, { updatedAt: new Date().toISOString() });
    await this.flush();
    return folder;
  }

  async removeFolder(id) {
    const idx = this.data.folders.findIndex((f) => f.id === id);
    if (idx === -1) return null;
    const [removed] = this.data.folders.splice(idx, 1);
    await this.flush();
    return removed;
  }

  // ---- streams -----------------------------------------------------------

  getStream(slugOrId) {
    return this.data.streams.find((s) => s.slug === slugOrId || s.id === slugOrId) || null;
  }

  async addStream(fields) {
    const now = new Date().toISOString();
    const stream = { id: randomUUID(), ...fields, createdAt: now, updatedAt: now };
    this.data.streams.push(stream);
    await this.flush();
    return stream;
  }

  async updateStream(id, patch) {
    const stream = this.getStream(id);
    if (!stream) return null;
    Object.assign(stream, patch, { updatedAt: new Date().toISOString() });
    await this.flush();
    return stream;
  }

  async removeStream(id) {
    const idx = this.data.streams.findIndex((s) => s.id === id);
    if (idx === -1) return null;
    const [removed] = this.data.streams.splice(idx, 1);
    await this.flush();
    return removed;
  }
}
