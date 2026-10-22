import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateUrl, validateAlias, validateTtl, isValidCode } from '../../src/service/validator.js';

test('accepts http and https URLs and normalizes them', () => {
  assert.equal(validateUrl('https://example.com/a?b=1').ok, true);
  assert.equal(validateUrl(' http://example.com ').url, 'http://example.com/');
});

test('rejects dangerous schemes', () => {
  for (const u of ['javascript:alert(1)', 'ftp://example.com', 'data:text/html,hi', 'file:///etc/passwd', 'httpevil:foo']) {
    assert.equal(validateUrl(u).ok, false, u);
  }
});

test('rejects private, loopback and link-local hosts', () => {
  for (const u of ['http://localhost/x', 'http://127.0.0.1/', 'http://10.1.2.3/', 'http://172.20.0.1/', 'http://192.168.1.1/', 'http://169.254.169.254/latest', 'http://[::1]/', 'http://db.internal/']) {
    assert.equal(validateUrl(u).ok, false, u);
  }
  assert.equal(validateUrl('http://172.32.0.1/').ok, true);
});

test('rejects credentials, empty, oversized and self-referential URLs', () => {
  assert.equal(validateUrl('https://user:pw@example.com').ok, false);
  assert.equal(validateUrl('').ok, false);
  assert.equal(validateUrl(42).ok, false);
  assert.equal(validateUrl(`https://example.com/${'a'.repeat(3000)}`).ok, false);
  assert.equal(validateUrl('http://short.test/abc', { selfHosts: ['short.test'] }).ok, false);
});

test('alias rules', () => {
  assert.equal(validateAlias('my-link_1').ok, true);
  for (const a of ['ab', 'has space', 'api', 'ADMIN', 'a/b', 'x'.repeat(33), 5]) assert.equal(validateAlias(a).ok, false, String(a));
});

test('ttl rules and code format', () => {
  assert.equal(validateTtl(60, { maxTtlSeconds: 100 }).ok, true);
  assert.equal(validateTtl(0, { maxTtlSeconds: 100 }).ok, false);
  assert.equal(validateTtl(101, { maxTtlSeconds: 100 }).ok, false);
  assert.equal(validateTtl(1.5, { maxTtlSeconds: 100 }).ok, false);
  assert.equal(isValidCode('abc123'), true);
  assert.equal(isValidCode('../etc'), false);
});
