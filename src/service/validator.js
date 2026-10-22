// Input validation for the URL shortener. Pure functions, no I/O.

const RESERVED_ALIASES = new Set(['api', 'healthz', 'metrics', 'admin', 'static', 'favicon.ico']);
const ALIAS_PATTERN = /^[A-Za-z0-9_-]{3,32}$/;
const CODE_PATTERN = /^[A-Za-z0-9_-]{3,32}$/;

function isPrivateIPv4(host) {
  const m = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (!m) return false;
  const [a, b] = [Number(m[1]), Number(m[2])];
  return (
    a === 0 || a === 10 || a === 127 ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168)
  );
}

function isPrivateHost(hostname) {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || host.endsWith('.internal')) return true;
  if (isPrivateIPv4(host)) return true;
  if (host === '::1' || host === '::' || host.startsWith('fc') || host.startsWith('fd') || host.startsWith('fe80')) {
    return host.includes(':');
  }
  return false;
}

/**
 * Validates a destination URL.
 * Only http/https, no embedded credentials, no private/loopback hosts (SSRF / internal link abuse),
 * and not pointing back at the shortener itself (redirect loops).
 */
export function validateUrl(raw, { maxLength = 2048, allowPrivateHosts = false, selfHosts = [] } = {}) {
  if (typeof raw !== 'string' || raw.trim() === '') return { ok: false, error: 'url is required' };
  const value = raw.trim();
  if (value.length > maxLength) return { ok: false, error: `url exceeds ${maxLength} characters` };
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    return { ok: false, error: 'url is not a valid absolute URL' };
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return { ok: false, error: 'only http and https URLs are allowed' };
  }
  if (parsed.username || parsed.password) return { ok: false, error: 'urls with embedded credentials are not allowed' };
  if (!allowPrivateHosts && isPrivateHost(parsed.hostname)) {
    return { ok: false, error: 'urls pointing to private or loopback hosts are not allowed' };
  }
  if (selfHosts.map((h) => h.toLowerCase()).includes(parsed.host.toLowerCase())) {
    return { ok: false, error: 'urls pointing to the shortener itself are not allowed' };
  }
  return { ok: true, url: parsed.toString() };
}

export function validateAlias(alias) {
  if (typeof alias !== 'string' || !ALIAS_PATTERN.test(alias)) {
    return { ok: false, error: 'customAlias must be 3-32 characters of A-Z, a-z, 0-9, _ or -' };
  }
  if (RESERVED_ALIASES.has(alias.toLowerCase())) return { ok: false, error: 'customAlias is reserved' };
  return { ok: true, alias };
}

export function isValidCode(code) {
  return typeof code === 'string' && CODE_PATTERN.test(code);
}

export function validateTtl(ttlSeconds, { maxTtlSeconds }) {
  if (!Number.isInteger(ttlSeconds) || ttlSeconds <= 0) return { ok: false, error: 'ttlSeconds must be a positive integer' };
  if (ttlSeconds > maxTtlSeconds) return { ok: false, error: `ttlSeconds must not exceed ${maxTtlSeconds}` };
  return { ok: true, ttlSeconds };
}
