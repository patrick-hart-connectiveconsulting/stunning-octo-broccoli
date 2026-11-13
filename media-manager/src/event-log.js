// Append-only event storage, one JSON Lines file per stream.
//
// Every mutation appends an operation line ({op:"put",event} or {op:"del",id}),
// so writing an event costs one small append, not a full-file rewrite. The log
// is replayed into memory on load and compacted when superseded ops pile up.

import { readFile, appendFile, writeFile, rename, unlink, chmod } from 'node:fs/promises';

export class EventLog {
  constructor(file) {
    this.file = file;
    this.events = new Map();
    this.ops = 0;
    this.lastSeq = 0;
    this.queue = Promise.resolve();
  }

  async load() {
    let text = '';
    try {
      text = await readFile(this.file, 'utf8');
      await chmod(this.file, 0o600).catch(() => {}); // tighten files written by older versions
    } catch (err) {
      if (err.code !== 'ENOENT') throw err;
    }
    for (const line of text.split('\n')) {
      if (!line.trim()) continue;
      try {
        this.#apply(JSON.parse(line));
        this.ops++;
      } catch {
        // A torn final line from a crash mid-append; everything before it is intact.
      }
    }
    if (this.ops > Math.max(1000, this.events.size * 2)) await this.compact();
    return this;
  }

  #apply(op) {
    if (op.op === 'put') {
      this.events.set(op.event.id, op.event);
      if (op.event.seq > this.lastSeq) this.lastSeq = op.event.seq;
    } else if (op.op === 'del') {
      this.events.delete(op.id);
    }
  }

  #enqueue(task) {
    const run = this.queue.then(task);
    this.queue = run.catch(() => {});
    return run;
  }

  nextSeq() {
    return ++this.lastSeq;
  }

  get(id) {
    return this.events.get(id) || null;
  }

  all() {
    return [...this.events.values()];
  }

  get size() {
    return this.events.size;
  }

  /** Applies ops in memory immediately, then persists them in order. */
  write(ops) {
    for (const op of ops) this.#apply(op);
    this.ops += ops.length;
    const text = ops.map((op) => `${JSON.stringify(op)}\n`).join('');
    return this.#enqueue(() => appendFile(this.file, text, { mode: 0o600 }));
  }

  put(events) {
    return this.write(events.map((event) => ({ op: 'put', event })));
  }

  remove(ids) {
    return this.write(ids.map((id) => ({ op: 'del', id })));
  }

  compact() {
    return this.#enqueue(async () => {
      const tmp = `${this.file}.${process.pid}.tmp`;
      await unlink(tmp).catch(() => {}); // a stale file from a crash would keep its old permissions
      const text = this.all().map((event) => `${JSON.stringify({ op: 'put', event })}\n`).join('');
      await writeFile(tmp, text, { mode: 0o600 });
      await rename(tmp, this.file);
      this.ops = this.events.size;
    });
  }

  destroy() {
    this.events.clear();
    return this.#enqueue(() => unlink(this.file).catch(() => {}));
  }
}
