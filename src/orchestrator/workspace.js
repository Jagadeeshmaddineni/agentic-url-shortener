import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';

/**
 * Sandboxed artifact workspace. All writes are confined to `root` and journaled per node so a node's
 * output can be reverted exactly (rollback) without touching other nodes' artifacts.
 */
export class Workspace {
  constructor(root) {
    this.root = resolve(root);
    mkdirSync(this.root, { recursive: true });
    this.journal = new Map(); // nodeId -> [{ path, prev }]
    this.index = new Map(); // path -> { nodeId, sha256, bytes }
  }

  resolveSafe(rel) {
    const abs = resolve(this.root, rel);
    if (abs !== this.root && !abs.startsWith(this.root + sep)) throw new Error(`path escapes workspace: ${rel}`);
    return abs;
  }

  exists(rel) { return existsSync(this.resolveSafe(rel)); }
  read(rel) { return readFileSync(this.resolveSafe(rel), 'utf8'); }

  list(rel = '.') {
    const base = this.resolveSafe(rel);
    if (!existsSync(base)) return [];
    const out = [];
    const walk = (dir) => {
      for (const name of readdirSync(dir)) {
        const p = join(dir, name);
        if (name === 'node_modules') continue;
        if (statSync(p).isDirectory()) walk(p); else out.push(relative(this.root, p).split(sep).join('/'));
      }
    };
    walk(base);
    return out.sort();
  }

  /** Seed pre-existing (brownfield) files. Not journaled: this is the baseline, not agent output. */
  seed(rel, content) {
    const abs = this.resolveSafe(rel);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, content);
  }

  write(nodeId, rel, content) {
    const abs = this.resolveSafe(rel);
    const prev = existsSync(abs) ? readFileSync(abs, 'utf8') : null;
    if (!this.journal.has(nodeId)) this.journal.set(nodeId, []);
    this.journal.get(nodeId).push({ path: rel, prev });
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, content);
    this.index.set(rel, { nodeId, sha256: createHash('sha256').update(content).digest('hex'), bytes: Buffer.byteLength(content) });
  }

  /** Reverts all writes of a node in reverse order. Returns the paths restored. */
  revert(nodeId) {
    const entries = this.journal.get(nodeId) ?? [];
    const paths = [];
    for (const { path, prev } of [...entries].reverse()) {
      const abs = this.resolveSafe(path);
      if (prev === null) rmSync(abs, { force: true }); else writeFileSync(abs, prev);
      this.index.delete(path);
      paths.push(path);
    }
    this.journal.delete(nodeId);
    return paths;
  }

  writtenBy(nodeId) { return (this.journal.get(nodeId) ?? []).map((e) => e.path); }
}
