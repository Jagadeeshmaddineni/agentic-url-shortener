import { createHash } from 'node:crypto';

const hashOf = (v) => createHash('sha256').update(JSON.stringify(v ?? null)).digest('hex').slice(0, 16);

/**
 * Cross-stage context + decision lineage.
 * Each node output is versioned; the version only advances when the content hash changes, which is
 * what drives staleness detection and re-planning downstream.
 */
export class ContextStore {
  constructor(now = () => Date.now()) {
    this.now = now;
    this.outputs = new Map(); // nodeId -> { version, hash, value }
    this.lineage = []; // { nodeId, version, hash, consumed, ts }
    this.decisions = []; // { id, by, nodeId, decision, rationale, ts }
  }

  set(nodeId, value, consumed = {}) {
    const hash = hashOf(value);
    const prev = this.outputs.get(nodeId);
    const changed = !prev || prev.hash !== hash;
    const version = prev ? (changed ? prev.version + 1 : prev.version) : 1;
    this.outputs.set(nodeId, { version, hash, value });
    this.lineage.push({ nodeId, version, hash, consumed, changed, ts: this.now() });
    return { version, changed, firstTime: !prev };
  }

  get(nodeId) { return this.outputs.get(nodeId)?.value; }
  version(nodeId) { return this.outputs.get(nodeId)?.version ?? 0; }
  has(nodeId) { return this.outputs.has(nodeId); }
  clear(nodeId) { /* keep last version so a re-run can detect real change */ void nodeId; }

  decide({ by, nodeId, decision, rationale }) {
    const d = { id: `D-${this.decisions.length + 1}`, by, nodeId, decision, rationale, ts: this.now() };
    this.decisions.push(d);
    return d;
  }

  snapshot() {
    return {
      versions: Object.fromEntries([...this.outputs].map(([k, v]) => [k, { version: v.version, hash: v.hash }])),
      lineage: this.lineage,
      decisions: this.decisions,
    };
  }
}
