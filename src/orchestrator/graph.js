/**
 * Explicit workflow dependency graph (DAG). Supports sequential and parallel paths: any nodes whose
 * dependencies are satisfied are eligible together, and a node with several deps is a sync (join) point.
 *
 * node = {
 *   id, stage, agent, deps[], impact: 'low'|'medium'|'high',
 *   approval: { required, summary? }, retries, fallbackAgent,
 *   entryGate(view) -> {ok, reason}, exitGate(result, view) -> {ok, reason}, timeoutMs
 * }
 */
export class WorkflowGraph {
  constructor() {
    this.nodes = new Map();
  }

  addNode(def) {
    if (!def.id || !def.agent) throw new Error('node requires id and agent');
    if (this.nodes.has(def.id)) throw new Error(`duplicate node ${def.id}`);
    this.nodes.set(def.id, { deps: [], impact: 'low', stage: 'general', ...def, deps: [...(def.deps ?? [])] });
    return this;
  }

  addDependency(id, dep) {
    const n = this.nodes.get(id);
    if (!n) throw new Error(`unknown node ${id}`);
    if (!n.deps.includes(dep)) n.deps.push(dep);
  }

  snapshot() {
    return new Map([...this.nodes].map(([k, v]) => [k, { ...v, deps: [...v.deps] }]));
  }

  restore(snap) {
    this.nodes = snap;
  }

  /** Throws on: unknown deps, cycles, and high-impact nodes lacking a human approval requirement. */
  validate() {
    for (const n of this.nodes.values()) {
      for (const d of n.deps) if (!this.nodes.has(d)) throw new Error(`node ${n.id} depends on unknown node ${d}`);
      if (n.impact === 'high' && !n.approval?.required) throw new Error(`policy CHG-002: high-impact node ${n.id} must require human approval`);
    }
    this.topoLevels(); // throws on cycles
    return true;
  }

  /** Kahn's algorithm grouped into levels; nodes in one level can run in parallel. */
  topoLevels() {
    const indeg = new Map([...this.nodes].map(([id, n]) => [id, n.deps.length]));
    const levels = [];
    let frontier = [...indeg].filter(([, d]) => d === 0).map(([id]) => id);
    let seen = 0;
    while (frontier.length) {
      levels.push(frontier);
      seen += frontier.length;
      const next = [];
      for (const id of frontier) {
        for (const dep of this.dependentsOf(id)) {
          indeg.set(dep, indeg.get(dep) - 1);
          if (indeg.get(dep) === 0) next.push(dep);
        }
      }
      frontier = next;
    }
    if (seen !== this.nodes.size) throw new Error('workflow graph contains a cycle');
    return levels;
  }

  dependentsOf(id) {
    return [...this.nodes.values()].filter((n) => n.deps.includes(id)).map((n) => n.id);
  }

  ancestorsOf(id) {
    const out = new Set();
    const walk = (x) => { for (const d of this.nodes.get(x).deps) if (!out.has(d)) { out.add(d); walk(d); } };
    walk(id);
    return out;
  }

  descendantsOf(id) {
    const out = new Set();
    const walk = (x) => { for (const d of this.dependentsOf(x)) if (!out.has(d)) { out.add(d); walk(d); } };
    walk(id);
    return out;
  }

  /** Order list of ids by topological position. */
  sortIds(ids) {
    const order = this.topoLevels().flat();
    return [...ids].sort((a, b) => order.indexOf(a) - order.indexOf(b));
  }

  toMermaid() {
    const lines = ['flowchart TD'];
    for (const n of this.nodes.values()) {
      const shape = n.approval?.required ? `{{"${n.id}<br/>(approval)"}}` : `["${n.id}"]`;
      lines.push(`  ${n.id.replace(/\W/g, '_')}${shape}`);
    }
    for (const n of this.nodes.values()) for (const d of n.deps) lines.push(`  ${d.replace(/\W/g, '_')} --> ${n.id.replace(/\W/g, '_')}`);
    return lines.join('\n');
  }
}
