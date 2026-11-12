// Shared HTTP helpers used by every API module.

export class HttpError extends Error {
  constructor(status, message, details) {
    super(message);
    this.status = status;
    this.details = details;
  }
}

export function send(res, status, body) {
  const payload = body === undefined ? '' : JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(payload);
}

export function readBody(req, limit) {
  return new Promise((ok, fail) => {
    const declared = Number(req.headers['content-length'] || 0);
    if (declared > limit) return fail(new HttpError(413, 'Payload too large'));
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) {
        fail(new HttpError(413, 'Payload too large'));
        req.destroy();
      } else chunks.push(c);
    });
    req.on('end', () => ok(Buffer.concat(chunks)));
    req.on('error', fail);
  });
}

export async function readJson(req, limit = 1024 * 1024) {
  const buf = await readBody(req, limit);
  try {
    return buf.length ? JSON.parse(buf.toString('utf8')) : {};
  } catch {
    throw new HttpError(400, 'Invalid JSON body');
  }
}

/** Parses `page` / `pageSize` query params and slices `items` accordingly. */
export function paginate(items, url, { defaultSize = 25, maxSize = 100 } = {}) {
  const page = Math.max(1, parseInt(url.searchParams.get('page'), 10) || 1);
  const pageSize = Math.min(maxSize, Math.max(1, parseInt(url.searchParams.get('pageSize'), 10) || defaultSize));
  const total = items.length;
  return {
    data: items.slice((page - 1) * pageSize, page * pageSize),
    meta: { pagination: { page, pageSize, pageCount: Math.max(1, Math.ceil(total / pageSize)), total } },
  };
}
