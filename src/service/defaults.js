import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

export const DEFAULTS = Object.freeze({
  codeLength: 7,
  defaultTtlSeconds: null, // null = links never expire unless ttlSeconds is supplied
  maxTtlSeconds: 365 * 24 * 3600,
  maxUrlLength: 2048,
  maxBodyBytes: 4096,
  rateLimit: { capacity: 10, refillPerMinute: 10 },
});

/** Merges defaults with spec-config.json (written by the implementation agent from the approved spec). */
export function loadSpecConfig() {
  const file = join(dirname(fileURLToPath(import.meta.url)), 'spec-config.json');
  if (!existsSync(file)) return { ...DEFAULTS };
  const overrides = JSON.parse(readFileSync(file, 'utf8'));
  return { ...DEFAULTS, ...overrides, rateLimit: { ...DEFAULTS.rateLimit, ...(overrides.rateLimit ?? {}) } };
}
