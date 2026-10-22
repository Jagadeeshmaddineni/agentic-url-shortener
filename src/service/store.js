import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

/**
 * Storage port. The app depends only on this async interface so MemoryStore / FileStore can be
 * swapped for Redis or a SQL database without touching business logic.
 */
export class MemoryStore {
  constructor() {
    this.links = new Map();
  }

  async create(link) {
    if (this.links.has(link.code)) return false;
    this.links.set(link.code, { ...link, analytics: emptyAnalytics() });
    await this.persist();
    return true;
  }

  async get(code) {
    const l = this.links.get(code);
    return l ? structuredClone(l) : null;
  }

  async delete(code) {
    const had = this.links.delete(code);
    if (had) await this.persist();
    return had;
  }

  async recordClick(code, { at, referrerHost }) {
    const l = this.links.get(code);
    if (!l) return;
    const a = l.analytics;
    a.totalClicks += 1;
    a.lastClickAt = at;
    const day = new Date(at).toISOString().slice(0, 10);
    a.byDay[day] = (a.byDay[day] ?? 0) + 1;
    const ref = referrerHost ?? 'direct';
    if (Object.keys(a.byReferrer).length < 500 || ref in a.byReferrer) a.byReferrer[ref] = (a.byReferrer[ref] ?? 0) + 1;
    await this.persist();
  }

  async count() {
    return this.links.size;
  }

  async persist() {}
}

export class FileStore extends MemoryStore {
  constructor(file) {
    super();
    this.file = file;
    if (existsSync(file)) {
      const data = JSON.parse(readFileSync(file, 'utf8'));
      for (const l of data.links ?? []) this.links.set(l.code, l);
    }
  }

  // Write-to-temp + rename is atomic on POSIX, so a crash never leaves a half-written file.
  async persist() {
    mkdirSync(dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp`;
    writeFileSync(tmp, JSON.stringify({ version: 1, links: [...this.links.values()] }));
    renameSync(tmp, this.file);
  }
}

function emptyAnalytics() {
  return { totalClicks: 0, lastClickAt: null, byDay: {}, byReferrer: {} };
}
