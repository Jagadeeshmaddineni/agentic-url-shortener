/** In-memory token bucket per key, with bounded memory and an injectable clock for tests. */
export class RateLimiter {
  constructor({ capacity = 10, refillPerSecond = 10 / 60, maxKeys = 10000, now = () => Date.now() } = {}) {
    this.capacity = capacity;
    this.refillPerSecond = refillPerSecond;
    this.maxKeys = maxKeys;
    this.now = now;
    this.buckets = new Map();
  }

  /** Returns { allowed, remaining, retryAfterSeconds }. */
  take(key) {
    const t = this.now();
    let b = this.buckets.get(key);
    if (!b) {
      if (this.buckets.size >= this.maxKeys) this.buckets.delete(this.buckets.keys().next().value);
      b = { tokens: this.capacity, last: t };
    } else {
      const elapsed = Math.max(0, (t - b.last) / 1000);
      b.tokens = Math.min(this.capacity, b.tokens + elapsed * this.refillPerSecond);
      b.last = t;
      this.buckets.delete(key); // re-insert to keep Map in LRU order
    }
    this.buckets.set(key, b);
    if (b.tokens >= 1) {
      b.tokens -= 1;
      return { allowed: true, remaining: Math.floor(b.tokens), retryAfterSeconds: 0 };
    }
    const retryAfterSeconds = Math.ceil((1 - b.tokens) / this.refillPerSecond);
    return { allowed: false, remaining: 0, retryAfterSeconds };
  }
}
