// Outgoing webhooks: POST each item change to configured URLs, signed with
// HMAC-SHA256, retried with backoff, delivered in order per webhook.

import { createHmac, randomBytes, randomUUID } from 'node:crypto';

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

export function sign(secret, body) {
  return `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`;
}

export class WebhookDispatcher {
  constructor({ onResult = () => {}, retryDelays = [1000, 10000, 60000], timeoutMs = 10000 } = {}) {
    this.onResult = onResult;
    this.retryDelays = retryDelays;
    this.timeoutMs = timeoutMs;
    this.queues = new Map(); // webhook id -> promise chain (keeps deliveries in order)
    this.closed = false;
  }

  /** Queues delivery of an item change to every matching, enabled webhook of the stream. */
  dispatch(stream, type, item) {
    for (const hook of stream.webhooks || []) {
      if (!hook.enabled || !hook.events.includes(type)) continue;
      const payload = this.#payload(stream, `item.${type}`, item);
      const prev = this.queues.get(hook.id) || Promise.resolve();
      const next = prev.then(() => this.#deliver(stream, hook, payload, this.retryDelays));
      this.queues.set(hook.id, next.catch(() => {}));
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
      if (result.ok) break;
      if (attempt <= delays.length) await this.#sleep(delays[attempt - 1]);
    }
    if (!this.closed) this.onResult(stream.id, hook.id, result);
    return result;
  }

  async #attempt(hook, payload, body) {
    const at = new Date().toISOString();
    try {
      const res = await fetch(hook.url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'User-Agent': 'media-manager-webhooks/0.3',
          'X-Webhook-Event': payload.type,
          'X-Webhook-Delivery': payload.id,
          'X-Webhook-Signature': sign(hook.secret, body),
        },
        body,
        redirect: 'manual',
        signal: AbortSignal.timeout(this.timeoutMs),
      });
      await res.arrayBuffer().catch(() => {});
      return { at, type: payload.type, ok: res.status >= 200 && res.status < 300, status: res.status, error: null };
    } catch (err) {
      return { at, type: payload.type, ok: false, status: null, error: err.name === 'TimeoutError' ? 'Timed out' : err.cause?.code || err.message };
    }
  }

  #sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms).unref());
  }

  close() {
    this.closed = true;
  }
}
