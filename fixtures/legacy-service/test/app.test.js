import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../src/app.js';

async function boot() {
  const server = createApp();
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return { base: `http://127.0.0.1:${server.address().port}`, close: () => new Promise((r) => server.close(r)) };
}

test('shortens an https URL and redirects to it', async () => {
  const { base, close } = await boot();
  const res = await fetch(`${base}/shorten`, { method: 'POST', body: JSON.stringify({ url: 'https://example.com/page' }) });
  assert.equal(res.status, 201);
  const { code } = await res.json();
  const r = await fetch(`${base}/${code}`, { redirect: 'manual' });
  assert.equal(r.status, 302);
  assert.equal(r.headers.get('location'), 'https://example.com/page');
  await close();
});

test('missing url is a 400 and unknown code is a 404', async () => {
  const { base, close } = await boot();
  assert.equal((await fetch(`${base}/shorten`, { method: 'POST', body: '{}' })).status, 400);
  assert.equal((await fetch(`${base}/nope`, { redirect: 'manual' })).status, 404);
  await close();
});
