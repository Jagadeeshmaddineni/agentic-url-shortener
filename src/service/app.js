import { timingSafeEqual, randomUUID } from 'node:crypto';
import { generateCode } from './shortcode.js';
import { isValidCode, validateAlias, validateTtl, validateUrl } from './validator.js';
import { DEFAULTS } from './defaults.js';
import { homePage } from './web.js';

class HttpError extends Error {
  constructor(status, code, message, headers = {}) {
    super(message);
    this.status = status;
    this.code = code;
    this.headers = headers;
  }
}

function safeEqual(a, b) {
  const ba = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  return ba.length === bb.length && timingSafeEqual(ba, bb);
}

function readJson(req, maxBytes) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > maxBytes) {
        reject(new HttpError(413, 'payload_too_large', `body exceeds ${maxBytes} bytes`));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      try {
        resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {});
      } catch {
        reject(new HttpError(400, 'invalid_json', 'body must be valid JSON'));
      }
    });
    req.on('error', reject);
  });
}

/**
 * Creates the request handler. All collaborators are injected so the app is unit/integration testable
 * without network, disk or wall-clock dependencies.
 */
export function createApp({
  store,
  baseUrl = 'http://localhost:3000',
  apiKey,
  rateLimiter,
  config = DEFAULTS,
  now = () => Date.now(),
  log = () => {},
} = {}) {
  if (!store) throw new Error('store is required');
  const selfHost = new URL(baseUrl).host;
  const counters = { requests: 0, created: 0, redirects: 0, notFound: 0, expired: 0, rateLimited: 0, errors: 0, analyticsFailures: 0 };

  function requireApiKey(req) {
    if (!apiKey) throw new HttpError(403, 'management_disabled', 'management endpoints are disabled: no API key configured');
    const provided = req.headers['x-api-key'];
    if (!provided || !safeEqual(provided, apiKey)) throw new HttpError(401, 'unauthorized', 'missing or invalid X-API-Key');
  }

  const send = (res, status, body, headers = {}) => {
    const payload = body === undefined ? '' : JSON.stringify(body);
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...headers });
    res.end(payload);
  };

  async function createLink(req, res) {
    const client = req.socket.remoteAddress ?? 'unknown';
    if (rateLimiter) {
      const r = rateLimiter.take(client);
      if (!r.allowed) {
        counters.rateLimited += 1;
        throw new HttpError(429, 'rate_limited', 'too many requests', { 'retry-after': String(r.retryAfterSeconds) });
      }
    }
    const body = await readJson(req, config.maxBodyBytes);
    const v = validateUrl(body.url, { maxLength: config.maxUrlLength, selfHosts: [selfHost] });
    if (!v.ok) throw new HttpError(400, 'invalid_url', v.error);

    let ttlSeconds = config.defaultTtlSeconds;
    if (body.ttlSeconds !== undefined) {
      const t = validateTtl(body.ttlSeconds, config);
      if (!t.ok) throw new HttpError(400, 'invalid_ttl', t.error);
      ttlSeconds = t.ttlSeconds;
    }
    const createdAt = now();
    const expiresAt = ttlSeconds ? createdAt + ttlSeconds * 1000 : null;
    const base = { originalUrl: v.url, createdAt, expiresAt };

    let code;
    if (body.customAlias !== undefined) {
      const a = validateAlias(body.customAlias);
      if (!a.ok) throw new HttpError(400, 'invalid_alias', a.error);
      if (!(await store.create({ code: a.alias, ...base }))) throw new HttpError(409, 'alias_taken', 'customAlias is already in use');
      code = a.alias;
    } else {
      for (let attempt = 0; attempt < 5 && !code; attempt += 1) {
        const candidate = generateCode(config.codeLength);
        if (await store.create({ code: candidate, ...base })) code = candidate;
      }
      if (!code) throw new HttpError(503, 'code_space_exhausted', 'could not allocate a unique code, retry later');
    }
    counters.created += 1;
    const shortUrl = `${baseUrl}/${code}`;
    send(res, 201, { code, shortUrl, originalUrl: base.originalUrl, createdAt: new Date(createdAt).toISOString(), expiresAt: expiresAt ? new Date(expiresAt).toISOString() : null }, { location: shortUrl });
  }

  async function redirect(req, res, code) {
    if (!isValidCode(code)) throw new HttpError(404, 'not_found', 'short link not found');
    const link = await store.get(code);
    if (!link) {
      counters.notFound += 1;
      throw new HttpError(404, 'not_found', 'short link not found');
    }
    if (link.expiresAt && link.expiresAt <= now()) {
      counters.expired += 1;
      throw new HttpError(410, 'expired', 'short link has expired');
    }
    // Analytics is best-effort: a failure here must never break the redirect.
    try {
      let referrerHost = null;
      try { referrerHost = req.headers.referer ? new URL(req.headers.referer).host : null; } catch { /* ignore malformed referer */ }
      await store.recordClick(code, { at: now(), referrerHost });
    } catch (err) {
      counters.analyticsFailures += 1;
      log({ level: 'warn', msg: 'analytics_failed', code, err: err.message });
    }
    counters.redirects += 1;
    res.writeHead(302, { location: link.originalUrl, 'cache-control': 'private, max-age=0' });
    res.end();
  }

  async function route(req, res) {
    const url = new URL(req.url, 'http://internal');
    const path = url.pathname;
    const method = req.method;

    if (method === 'GET' && path === '/healthz') return send(res, 200, { status: 'ok', links: await store.count() });
    if (method === 'GET' && path === '/metrics') return send(res, 200, counters);
    if (method === 'GET' && path === '/') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
      res.end(homePage);
      return;
    }
    if (method === 'POST' && path === '/api/v1/links') return createLink(req, res);

    const m = path.match(/^\/api\/v1\/links\/([^/]+)(\/analytics)?$/);
    if (m) {
      requireApiKey(req);
      const code = decodeURIComponent(m[1]);
      if (!isValidCode(code)) throw new HttpError(404, 'not_found', 'short link not found');
      if (method === 'DELETE' && !m[2]) {
        if (!(await store.delete(code))) throw new HttpError(404, 'not_found', 'short link not found');
        return send(res, 204);
      }
      if (method === 'GET') {
        const link = await store.get(code);
        if (!link) throw new HttpError(404, 'not_found', 'short link not found');
        if (m[2]) {
          const topReferrers = Object.entries(link.analytics.byReferrer).sort((a, b) => b[1] - a[1]).slice(0, 10).map(([host, clicks]) => ({ host, clicks }));
          return send(res, 200, { code, totalClicks: link.analytics.totalClicks, lastClickAt: link.analytics.lastClickAt ? new Date(link.analytics.lastClickAt).toISOString() : null, clicksByDay: link.analytics.byDay, topReferrers });
        }
        return send(res, 200, { code, originalUrl: link.originalUrl, createdAt: new Date(link.createdAt).toISOString(), expiresAt: link.expiresAt ? new Date(link.expiresAt).toISOString() : null });
      }
      throw new HttpError(405, 'method_not_allowed', 'method not allowed');
    }

    const r = path.match(/^\/([^/]+)$/);
    if (r && (method === 'GET' || method === 'HEAD')) return redirect(req, res, decodeURIComponent(r[1]));
    throw new HttpError(404, 'not_found', 'route not found');
  }

  return async function handler(req, res) {
    const started = now();
    const requestId = randomUUID();
    counters.requests += 1;
    try {
      await route(req, res);
    } catch (err) {
      if (!(err instanceof HttpError)) {
        counters.errors += 1;
        log({ level: 'error', msg: 'unhandled', requestId, err: err.message });
        err = new HttpError(500, 'internal_error', 'internal server error');
      }
      if (!res.headersSent) send(res, err.status, { error: { code: err.code, message: err.message } }, err.headers);
    } finally {
      log({ level: 'info', msg: 'request', requestId, method: req.method, status: res.statusCode, ms: now() - started });
    }
  };
}
