// Outgoing webhooks: POST each item change to configured URLs, signed with
// HMAC-SHA256, retried with backoff, delivered in order per webhook.

import { createHmac, randomBytes, randomUUID } from 'node:crypto';
import http from 'node:http';
import https from 'node:https';
import { isIP } from 'node:net';
import { lookup as dnsLookup } from 'node:dns';

export const WEBHOOK_EVENTS = ['created', 'updated', 'deleted', 'published', 'unpublished'];
const MAX_WEBHOOKS = 10;

/** Validates a stream's webhook list, keeping ids/secrets/delivery status of existing ones. */
export function normalizeWebhooks(input, existing = []) {
  if (input === undefined || input === null) return { webhooks: [] };
  if (!Array.isArray(input)) return { errors: [{ path: 'webhooks', message: 'must be an array' }] };
  if (input.length > MAX_WEBHOOKS) return { errors: [{ path: 'webhooks', message: `At most ${MAX_WEBHOOKS} webhooks per stream` }] };

  const errors = [];
  const byId = new Map(existing.map((w) => [w.id, w]));
  const webhooks = input.map((raw, i) => {
    const path = `webhooks[${i}]`;
    if (!raw || typeof raw !== 'object') {
      errors.push({ path, message: 'must be an object' });
      return null;
    }
    let url;
    try {
      url = new URL(raw.url);
      if (!['http:', 'https:'].includes(url.protocol)) throw new Error();
      if (String(raw.url).length > 2000) throw new Error();
    } catch {
      errors.push({ path: `${path}.url`, message: 'must be an http(s) URL (max 2000 chars)' });
    }
    const events = raw.events === undefined ? [...WEBHOOK_EVENTS] : raw.events;
    if (!Array.isArray(events) || !events.length || events.some((e) => !WEBHOOK_EVENTS.includes(e))) {
      errors.push({ path: `${path}.events`, message: `must be a non-empty list of: ${WEBHOOK_EVENTS.join(', ')}` });
    }
    const prev = raw.id ? byId.get(raw.id) : null;
    return {
      id: prev?.id ?? randomUUID(),
      url: url?.href ?? raw.url,
      events: Array.isArray(events) ? [...new Set(events)] : [],
      enabled: raw.enabled !== false,
      // Secrets are server-generated; send `rotateSecret: true` to replace one.
      secret: prev && !raw.rotateSecret ? prev.secret : randomBytes(24).toString('hex'),
      lastDelivery: prev?.lastDelivery ?? null,
    };
  });
  return errors.length ? { errors } : { webhooks };
}

/**
 * Signature over `${timestamp}.${body}` (HMAC-SHA256, hex). Including the
 * timestamp lets receivers reject old, replayed deliveries.
 */
export function sign(secret, body, timestamp) {
  return `sha256=${createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('hex')}`;
}

// ---- destination checks (SSRF protection) -----------------------------------------

const v4ToInt = (ip) => ip.split('.').reduce((n, part) => (n << 8) + Number(part), 0) >>> 0;
const V4_BLOCKED = [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16], ['172.16.0.0', 12],
  ['192.0.0.0', 24], ['192.0.2.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15], ['198.51.100.0', 24], ['203.0.113.0', 24],
  ['224.0.0.0', 4], ['240.0.0.0', 4],
].map(([base, bits]) => [v4ToInt(base), bits === 0 ? 0 : (~0 << (32 - bits)) >>> 0]);

/**
 * True for addresses a webhook must not reach by default: loopback, private,
 * link-local (cloud metadata), carrier-grade NAT, multicast, reserved and the
 * IPv6 equivalents (including IPv4-mapped forms).
 */
export function isPrivateAddress(address) {
  const ip = String(address).toLowerCase().replace(/^\[|\]$/g, '').replace(/%.*$/, '');
  if (isIP(ip) === 4) {
    const n = v4ToInt(ip);
    return V4_BLOCKED.some(([base, mask]) => (n & mask) === (base & mask));
  }
  if (isIP(ip) !== 6) return true; // not an IP address at all
  const g = expandV6(ip);
  // IPv4-mapped (::ffff:a.b.c.d), IPv4-compatible (::a.b.c.d) and NAT64 (64:ff9b::/96): check the embedded IPv4.
  const embedded = `${g[6] >> 8}.${g[6] & 255}.${g[7] >> 8}.${g[7] & 255}`;
  if (g.slice(0, 5).every((x) => x === 0) && (g[5] === 0xffff || g[5] === 0)) {
    if (g[5] === 0 && g[6] === 0 && g[7] <= 1) return true; // :: and ::1
    return isPrivateAddress(embedded);
  }
  if (g[0] === 0x64 && g[1] === 0xff9b && g.slice(2, 6).every((x) => x === 0)) return isPrivateAddress(embedded);
  return (g[0] & 0xfe00) === 0xfc00 // fc00::/7 unique local
    || (g[0] & 0xffc0) === 0xfe80 // fe80::/10 link-local
    || (g[0] & 0xff00) === 0xff00 // multicast
    || (g[0] === 0x2001 && g[1] === 0x0db8); // documentation
}

/** "::ffff:7f00:1" -> [0,0,0,0,0,0xffff,0x7f00,1] (dotted IPv4 tails are converted too). */
function expandV6(ip) {
  let s = ip;
  const dotted = /(\d+\.\d+\.\d+\.\d+)$/.exec(s);
  if (dotted) {
    const n = v4ToInt(dotted[1]);
    s = `${s.slice(0, -dotted[1].length)}${(n >>> 16).toString(16)}:${(n & 0xffff).toString(16)}`;
  }
  const [head, tail] = s.split('::');
  const a = head ? head.split(':') : [];
  const b = tail !== undefined && tail ? tail.split(':') : [];
  const fill = s.includes('::') ? Array(8 - a.length - b.length).fill('0') : [];
  return [...a, ...fill, ...b].map((x) => parseInt(x || '0', 16));
}

const blocked = (host) => Object.assign(new Error(`Blocked: ${host} is a private or reserved network address`), { code: 'EBLOCKED' });

export class WebhookDispatcher {
  constructor({ onResult = () => {}, retryDelays = [1000, 10000, 60000], timeoutMs = 10000, allowPrivate = false, maxQueue = 500 } = {}) {
    this.onResult = onResult;
    this.retryDelays = retryDelays;
    this.timeoutMs = timeoutMs;
    this.allowPrivate = allowPrivate;
    this.maxQueue = maxQueue;
    this.queues = new Map(); // webhook id -> { tail: promise chain (keeps order), pending: number }
    this.closed = false;
  }

  /** Queues delivery of an item change to every matching, enabled webhook of the stream. */
  dispatch(stream, type, item) {
    for (const hook of stream.webhooks || []) {
      if (!hook.enabled || !hook.events.includes(type)) continue;
      const q = this.queues.get(hook.id) ?? { tail: Promise.resolve(), pending: 0, dropped: 0 };
      if (q.pending >= this.maxQueue) {
        // A slow or failing receiver must not make the queue (and memory) grow without limit.
        q.dropped++;
        this.onResult(stream.id, hook.id, {
          at: new Date().toISOString(), type: `item.${type}`, ok: false, status: null, attempts: 0,
          error: `Queue full (${this.maxQueue} waiting): ${q.dropped} deliveries dropped`,
        });
        continue;
      }
      const payload = this.#payload(stream, `item.${type}`, item);
      q.pending++;
      q.tail = q.tail.then(() => this.#deliver(stream, hook, payload, this.retryDelays)).catch(() => {}).then(() => {
        q.pending--;
        if (q.pending === 0 && this.queues.get(hook.id) === q) this.queues.delete(hook.id);
      });
      this.queues.set(hook.id, q);
    }
  }

  /** Sends a single `ping` delivery (no retries) and returns the result. */
  test(stream, hook) {
    return this.#deliver(stream, hook, this.#payload(stream, 'ping', null), []);
  }

  #payload(stream, type, item) {
    return {
      id: randomUUID(),
      type,
      stream: { id: stream.id, slug: stream.slug, name: stream.name },
      item,
      createdAt: new Date().toISOString(),
    };
  }

  async #deliver(stream, hook, payload, delays) {
    const body = JSON.stringify(payload);
    let result;
    for (let attempt = 1; attempt <= delays.length + 1; attempt++) {
      if (this.closed) return result;
      result = await this.#attempt(hook, payload, body);
      result.attempts = attempt;
      if (result.ok || result.error?.startsWith('Blocked:')) break; // retrying a blocked address is pointless
      if (attempt <= delays.length) await this.#sleep(delays[attempt - 1]);
    }
    if (!this.closed) this.onResult(stream.id, hook.id, result);
    return result;
  }

  /**
   * One POST. Uses node:http(s) with a DNS lookup that refuses private
   * addresses, so the check applies to the address actually connected to
   * (no DNS-rebinding gap between a check and the request). Redirects are not followed.
   */
  #attempt(hook, payload, body) {
    const at = new Date().toISOString();
    const done = (status, error) => ({ at, type: payload.type, ok: status >= 200 && status < 300, status, error });
    return new Promise((resolve) => {
      let url;
      try {
        url = new URL(hook.url);
      } catch {
        return resolve(done(null, 'Invalid URL'));
      }
      const host = url.hostname.replace(/^\[|\]$/g, '');
      if (!this.allowPrivate && isIP(host) && isPrivateAddress(host)) return resolve(done(null, blocked(host).message));
      const lookup = (hostname, options, callback) => {
        dnsLookup(hostname, { ...options, all: true }, (err, addresses) => {
          if (err) return callback(err);
          if (!this.allowPrivate) {
            const bad = addresses.find((a) => isPrivateAddress(a.address));
            if (bad) return callback(blocked(hostname));
          }
          if (options.all) return callback(null, addresses);
          return callback(null, addresses[0].address, addresses[0].family);
        });
      };
      const timestamp = Math.floor(Date.now() / 1000);
      const req = (url.protocol === 'https:' ? https : http).request(url, {
        method: 'POST',
        lookup,
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(body),
          'User-Agent': 'media-manager-webhooks/0.8',
          'X-Webhook-Event': payload.type,
          'X-Webhook-Delivery': payload.id,
          'X-Webhook-Timestamp': String(timestamp),
          'X-Webhook-Signature': sign(hook.secret, body, timestamp),
        },
        signal: AbortSignal.timeout(this.timeoutMs),
      }, (res) => {
        res.resume(); // discard the response body
        res.on('end', () => resolve(done(res.statusCode, null)));
        res.on('error', (err) => resolve(done(res.statusCode, err.message)));
      });
      req.on('error', (err) => {
        const message = err.code === 'EBLOCKED' ? err.message
          : err.name === 'AbortError' || err.name === 'TimeoutError' ? 'Timed out'
            : err.code || err.message;
        resolve(done(null, message));
      });
      req.end(body);
    });
  }

  #sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms).unref());
  }

  close() {
    this.closed = true;
  }
}
