import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createApp } from '../../src/service/app.js';
import { MemoryStore } from '../../src/service/store.js';
import { RateLimiter } from '../../src/service/ratelimiter.js';
import { DEFAULTS } from '../../src/service/defaults.js';

let server, base, clock, store;
const KEY = 'test-key';

before(async () => {
  clock = 1_700_000_000_000;
  store = new MemoryStore();
  const rateLimiter = new RateLimiter({ capacity: 50, refillPerSecond: 1, now: () => clock });
  server = createServer(createApp({ store, baseUrl: 'http://short.test', apiKey: KEY, rateLimiter, now: () => clock, config: { ...DEFAULTS, maxTtlSeconds: 3600 } }));
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => server.close());

const post = (body, headers = {}) => fetch(`${base}/api/v1/links`, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });

test('home page serves the browser link-shortening form', async () => {
  const res = await fetch(`${base}/`);
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type'), /text\/html/);
  const html = await res.text();
  assert.match(html, /id="shorten-form"/);
  assert.match(html, /id="destination"/);
  assert.match(html, /fetch\('\/api\/v1\/links'/);
});

test('create then redirect with 302', async () => {
  const res = await post({ url: 'https://example.com/page' });
  assert.equal(res.status, 201);
  const body = await res.json();
  assert.match(body.code, /^[0-9A-Za-z]{7}$/);
  assert.equal(body.shortUrl, `http://short.test/${body.code}`);
  const r = await fetch(`${base}/${body.code}`, { redirect: 'manual' });
  assert.equal(r.status, 302);
  assert.equal(r.headers.get('location'), 'https://example.com/page');
});

test('rejects invalid input with 400 and structured error', async () => {
  for (const body of [{}, { url: 'javascript:alert(1)' }, { url: 'http://localhost/x' }, { url: 'https://short.test/abc' }, { url: 'https://e.com', ttlSeconds: -1 }, { url: 'https://e.com', customAlias: 'api' }]) {
    const res = await post(body);
    assert.equal(res.status, 400, JSON.stringify(body));
    assert.ok((await res.json()).error.code);
  }
  const bad = await fetch(`${base}/api/v1/links`, { method: 'POST', body: '{not json' });
  assert.equal(bad.status, 400);
});

test('rejects oversized bodies', async () => {
  const res = await post({ url: `https://e.com/${'a'.repeat(6000)}` }).catch(() => ({ status: 413 }));
  assert.equal(res.status, 413);
});

test('custom alias conflicts return 409', async () => {
  assert.equal((await post({ url: 'https://example.com/1', customAlias: 'my-alias' })).status, 201);
  assert.equal((await post({ url: 'https://example.com/2', customAlias: 'my-alias' })).status, 409);
});

test('unknown codes return 404; expired links return 410', async () => {
  assert.equal((await fetch(`${base}/doesnotexist`, { redirect: 'manual' })).status, 404);
  const { code } = await (await post({ url: 'https://example.com/ttl', ttlSeconds: 60 })).json();
  assert.equal((await fetch(`${base}/${code}`, { redirect: 'manual' })).status, 302);
  clock += 61_000;
  assert.equal((await fetch(`${base}/${code}`, { redirect: 'manual' })).status, 410);
});

test('ttl above configured maximum is rejected', async () => {
  assert.equal((await post({ url: 'https://example.com/x', ttlSeconds: 7200 })).status, 400);
});

test('analytics counts clicks per day and referrer; requires API key', async () => {
  const { code } = await (await post({ url: 'https://example.com/a' })).json();
  await fetch(`${base}/${code}`, { redirect: 'manual', headers: { referer: 'https://news.test/story' } });
  await fetch(`${base}/${code}`, { redirect: 'manual', headers: { referer: 'https://news.test/other' } });
  await fetch(`${base}/${code}`, { redirect: 'manual' });
  assert.equal((await fetch(`${base}/api/v1/links/${code}/analytics`)).status, 401);
  assert.equal((await fetch(`${base}/api/v1/links/${code}/analytics`, { headers: { 'x-api-key': 'wrong' } })).status, 401);
  const res = await fetch(`${base}/api/v1/links/${code}/analytics`, { headers: { 'x-api-key': KEY } });
  const a = await res.json();
  assert.equal(a.totalClicks, 3);
  assert.deepEqual(a.topReferrers[0], { host: 'news.test', clicks: 2 });
  assert.equal(Object.values(a.clicksByDay).reduce((x, y) => x + y, 0), 3);
});

test('delete requires API key and removes the link', async () => {
  const { code } = await (await post({ url: 'https://example.com/del' })).json();
  assert.equal((await fetch(`${base}/api/v1/links/${code}`, { method: 'DELETE' })).status, 401);
  assert.equal((await fetch(`${base}/api/v1/links/${code}`, { method: 'DELETE', headers: { 'x-api-key': KEY } })).status, 204);
  assert.equal((await fetch(`${base}/${code}`, { redirect: 'manual' })).status, 404);
});

test('analytics failure never breaks the redirect', async () => {
  const { code } = await (await post({ url: 'https://example.com/resilient' })).json();
  const original = store.recordClick;
  store.recordClick = async () => { throw new Error('disk full'); };
  try {
    assert.equal((await fetch(`${base}/${code}`, { redirect: 'manual' })).status, 302);
  } finally {
    store.recordClick = original;
  }
});

test('health and metrics endpoints', async () => {
  assert.equal((await (await fetch(`${base}/healthz`)).json()).status, 'ok');
  assert.ok((await (await fetch(`${base}/metrics`)).json()).requests > 0);
});

test('rate limiting returns 429 with Retry-After', async () => {
  let t = 0;
  const srv = createServer(createApp({ store: new MemoryStore(), baseUrl: 'http://short.test', apiKey: KEY, rateLimiter: new RateLimiter({ capacity: 2, refillPerSecond: 0.1, now: () => t }) }));
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const b = `http://127.0.0.1:${srv.address().port}`;
  const p = () => fetch(`${b}/api/v1/links`, { method: 'POST', body: JSON.stringify({ url: 'https://example.com' }) });
  assert.equal((await p()).status, 201);
  assert.equal((await p()).status, 201);
  const limited = await p();
  assert.equal(limited.status, 429);
  assert.ok(Number(limited.headers.get('retry-after')) > 0);
  srv.close();
});

test('management endpoints are disabled when no API key is configured', async () => {
  const srv = createServer(createApp({ store: new MemoryStore(), baseUrl: 'http://short.test' }));
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const res = await fetch(`http://127.0.0.1:${srv.address().port}/api/v1/links/abc/analytics`, { headers: { 'x-api-key': 'anything' } });
  assert.equal(res.status, 403);
  srv.close();
});
