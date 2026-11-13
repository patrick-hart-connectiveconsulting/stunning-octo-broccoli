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

/**
 * Reads the request body up to `limit` bytes. A larger body is refused with
 * 413: reading stops, and the error asks the server to answer and then close
 * the connection (destroying the socket here would drop the 413 response).
 */
export function readBody(req, limit) {
  return new Promise((ok, fail) => {
    const tooLarge = () => {
      req.removeAllListeners('data');
      req.pause();
      const err = new HttpError(413, `Payload too large (limit ${limit} bytes)`);
      err.closeConnection = true;
      fail(err);
    };
    const declared = Number(req.headers['content-length'] || 0);
    if (declared > limit) return tooLarge();
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) tooLarge();
      else chunks.push(c);
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

/** Like readJson, but the body must be a JSON object (not null, an array or a primitive). */
export async function readJsonObject(req, limit) {
  const body = await readJson(req, limit);
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new HttpError(400, 'The request body must be a JSON object');
  return body;
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
