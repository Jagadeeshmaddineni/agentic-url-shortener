import { createHash } from 'node:crypto';
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

const sha = (s) => createHash('sha256').update(s).digest('hex');

/** Append-only, hash-chained audit log. Any tampering with a past event breaks verification. */
export class AuditLog {
  constructor({ file = null, now = () => Date.now() } = {}) {
    this.file = file;
    this.now = now;
    this.events = [];
    this.prevHash = 'GENESIS';
    if (file) {
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, '');
    }
  }

  record(type, data = {}) {
    const core = { seq: this.events.length + 1, ts: this.now(), type, data, prevHash: this.prevHash };
    const event = { ...core, hash: sha(JSON.stringify(core)) };
    this.prevHash = event.hash;
    this.events.push(event);
    if (this.file) appendFileSync(this.file, `${JSON.stringify(event)}\n`);
    return event;
  }

  query(type) {
    return this.events.filter((e) => e.type === type);
  }

  static verify(events) {
    let prev = 'GENESIS';
    for (const e of events) {
      const { hash, ...core } = e;
      if (core.prevHash !== prev || sha(JSON.stringify(core)) !== hash) return { ok: false, brokenAtSeq: e.seq };
      prev = hash;
    }
    return { ok: true, count: events.length };
  }

  static verifyFile(file) {
    const events = readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
    return AuditLog.verify(events);
  }
}
