import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generateCode } from '../../src/service/shortcode.js';
import { RateLimiter } from '../../src/service/ratelimiter.js';
import { FileStore, MemoryStore } from '../../src/service/store.js';

test('generateCode produces base62 codes of requested length with low collision rate', () => {
  const seen = new Set();
  for (let i = 0; i < 5000; i += 1) {
    const c = generateCode(7);
    assert.match(c, /^[0-9A-Za-z]{7}$/);
    seen.add(c);
  }
  assert.equal(seen.size, 5000);
});

test('rate limiter allows burst up to capacity, then refills over time', () => {
  let t = 0;
  const rl = new RateLimiter({ capacity: 3, refillPerSecond: 1, now: () => t });
  assert.equal(rl.take('a').allowed, true);
  assert.equal(rl.take('a').allowed, true);
  assert.equal(rl.take('a').allowed, true);
  const denied = rl.take('a');
  assert.equal(denied.allowed, false);
  assert.equal(denied.retryAfterSeconds, 1);
  assert.equal(rl.take('b').allowed, true, 'keys are isolated');
  t = 1000;
  assert.equal(rl.take('a').allowed, true);
  assert.equal(rl.take('a').allowed, false);
});

test('rate limiter bounds memory by evicting the oldest key', () => {
  const rl = new RateLimiter({ capacity: 1, refillPerSecond: 0.001, maxKeys: 2 });
  rl.take('a'); rl.take('b'); rl.take('c');
  assert.equal(rl.buckets.size, 2);
  assert.equal(rl.buckets.has('a'), false);
});

test('store: create is exclusive, analytics aggregate, delete works', async () => {
  const s = new MemoryStore();
  assert.equal(await s.create({ code: 'abc', originalUrl: 'https://e.com/', createdAt: 1, expiresAt: null }), true);
  assert.equal(await s.create({ code: 'abc', originalUrl: 'https://x.com/', createdAt: 1, expiresAt: null }), false);
  const at = Date.UTC(2026, 0, 2, 12);
  await s.recordClick('abc', { at, referrerHost: 'news.com' });
  await s.recordClick('abc', { at, referrerHost: null });
  const l = await s.get('abc');
  assert.equal(l.analytics.totalClicks, 2);
  assert.deepEqual(l.analytics.byDay, { '2026-01-02': 2 });
  assert.deepEqual(l.analytics.byReferrer, { 'news.com': 1, direct: 1 });
  assert.equal(await s.delete('abc'), true);
  assert.equal(await s.get('abc'), null);
});

test('file store persists atomically and reloads', async () => {
  const file = join(mkdtempSync(join(tmpdir(), 'fs-')), 'data.json');
  const a = new FileStore(file);
  await a.create({ code: 'zzz', originalUrl: 'https://e.com/', createdAt: 1, expiresAt: null });
  await a.recordClick('zzz', { at: 1000, referrerHost: null });
  assert.equal(JSON.parse(readFileSync(file, 'utf8')).links.length, 1);
  const b = new FileStore(file);
  assert.equal((await b.get('zzz')).analytics.totalClicks, 1);
});
