import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { runCommand } from './sandbox.js';

export const Status = Object.freeze({
  PENDING: 'PENDING', RUNNING: 'RUNNING', AWAITING_APPROVAL: 'AWAITING_APPROVAL', SUCCEEDED: 'SUCCEEDED',
  FAILED: 'FAILED', SKIPPED: 'SKIPPED', REJECTED: 'REJECTED', ROLLED_BACK: 'ROLLED_BACK',
});

export class GateError extends Error {}
export class PolicyViolation extends Error {
  constructor(violations, critical) {
    super(violations.map((v) => `${v.rule}: ${v.reason}`).join('; '));
    this.violations = violations;
    this.critical = critical;
  }
}

const DEFAULT_CONFIG = {
  maxConcurrency: 3,
  maxTotalAttempts: 60, // safe-stop budget
  maxFailures: 12, // safe-stop budget
  maxReplans: 5,
  defaultRetries: 1, // bounded retries on the primary strategy
  backoffMs: 0,
  nodeTimeoutMs: 120_000,
  onFailure: 'rollback-all', // or 'isolate'
};

function withTimeout(promise, ms, label) {
  let timer;
  const t = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms); });
  return Promise.race([promise, t]).finally(() => clearTimeout(timer));
}

/**
 * Stateful, non-linear SDLC orchestrator.
 *  - explicit DAG with entry/exit gates, parallel batches and sync points
 *  - versioned cross-stage context, decision lineage, automatic staleness propagation (re-planning)
 *  - policy guardrails evaluated on every artifact/command/change
 *  - human approval checkpoints (mandatory for high impact, or escalated by policy)
 *  - bounded retries -> fallback strategy -> rollback; global budgets and safe-stop
 *  - hash-chained audit log and reliability metrics
 */
export class Orchestrator {
  constructor({ graph, agents, workspace, policy, approver, audit, metrics, context, config = {}, hooks = {}, evidenceDir = null }) {
    Object.assign(this, { graph, agents, workspace, policy, approver, audit, metrics, context, hooks, evidenceDir });
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.state = new Map();
    this.halted = null;
    this.failure = null;
    this.pendingReplans = [];
    this.replans = 0;
    this.totalAttempts = 0;
    this.totalFailures = 0;
    this.completionOrder = [];
    this.requirement = null;
  }

  ensureState(id) {
    if (!this.state.has(id)) this.state.set(id, { status: Status.PENDING, runs: 0, inputVersions: {}, version: 0, usedFallback: false, error: null, note: null });
    return this.state.get(id);
  }

  statuses() {
    return Object.fromEntries([...this.graph.nodes.keys()].map((id) => [id, this.ensureState(id).status]));
  }

  // ---------------------------------------------------------------- run loop
  async run(requirement) {
    this.graph.validate();
    this.requirement = requirement;
    for (const id of this.graph.nodes.keys()) this.ensureState(id);
    this.metrics.runStarted();
    this.audit.record('run.started', { requirement, nodes: [...this.graph.nodes.values()].map((n) => ({ id: n.id, stage: n.stage, deps: n.deps, impact: n.impact, approval: !!n.approval?.required })), config: this.config });

    while (!this.halted) {
      this.propagateSkips();
      const ready = this.readyNodes();
      if (!ready.length) break;
      const batch = ready.slice(0, this.config.maxConcurrency);
      this.audit.record('batch.started', { nodes: batch, parallel: batch.length > 1 });
      await Promise.all(batch.map((id) => this.executeNode(id)));
      this.audit.record('batch.synchronized', { nodes: batch, statuses: Object.fromEntries(batch.map((id) => [id, this.state.get(id).status])) });
      if (this.failure && !this.halted && this.config.onFailure === 'rollback-all') {
        this.rollbackRun(`node ${this.failure.nodeId} failed: ${this.failure.reason}`);
        break;
      }
      this.applyReplans();
      if (this.hooks.afterBatch && !this.halted) await this.hooks.afterBatch(this, batch);
    }

    for (const st of this.state.values()) if (st.status === Status.PENDING) { st.status = Status.SKIPPED; st.note = st.note ?? (this.halted ? 'run halted' : 'upstream did not complete'); }
    const statuses = this.statuses();
    const allDone = Object.values(statuses).every((s) => s === Status.SUCCEEDED);
    const status = this.halted ? 'HALTED' : allDone ? 'COMPLETED' : 'FAILED';
    this.metrics.runFinished();
    this.audit.record('run.finished', { status, halted: this.halted, failure: this.failure, statuses });
    const result = { status, halted: this.halted, failure: this.failure, statuses, metrics: this.metrics.summary(statuses), nodes: this.nodeReport() };
    this.writeEvidence(result);
    return result;
  }

  readyNodes() {
    const ids = [...this.graph.nodes.values()].filter((n) => this.state.get(n.id).status === Status.PENDING && n.deps.every((d) => this.state.get(d)?.status === Status.SUCCEEDED)).map((n) => n.id);
    return this.graph.sortIds(ids);
  }

  propagateSkips() {
    let changed = true;
    while (changed) {
      changed = false;
      for (const n of this.graph.nodes.values()) {
        const st = this.state.get(n.id);
        if (st.status !== Status.PENDING) continue;
        const bad = n.deps.find((d) => [Status.FAILED, Status.SKIPPED, Status.REJECTED, Status.ROLLED_BACK].includes(this.state.get(d).status));
        if (bad) { st.status = Status.SKIPPED; st.note = `upstream ${bad} did not succeed`; this.audit.record('node.skipped', { node: n.id, because: bad }); changed = true; }
      }
    }
  }

  // ---------------------------------------------------------------- node execution
  async executeNode(id) {
    const def = this.graph.nodes.get(id);
    const st = this.state.get(id);
    st.status = Status.RUNNING;
    st.runs += 1;
    st.error = null;
    st.inputVersions = Object.fromEntries(def.deps.map((d) => [d, this.context.version(d)]));
    const startedAt = Date.now();
    this.metrics.entry(id).attempts = 0;
    this.audit.record('node.started', { node: id, run: st.runs, inputVersions: st.inputVersions });

    if (def.entryGate) {
      const g = await def.entryGate(this.buildContext(id, 'gate', 0));
      this.audit.record('gate.entry', { node: id, ok: g.ok, reason: g.reason ?? null });
      if (!g.ok) return this.failNode(id, `entry gate failed: ${g.reason}`);
    }

    const strategies = [{ agent: def.agent, name: 'primary', attempts: 1 + (def.retries ?? this.config.defaultRetries) }];
    if (def.fallbackAgent) strategies.push({ agent: def.fallbackAgent, name: 'fallback', attempts: 1 });

    let result = null;
    let lastError = null;
    outer: for (const strat of strategies) {
      if (strat.name === 'fallback') {
        st.usedFallback = true;
        this.metrics.count('fallbacks');
        this.audit.record('node.fallback', { node: id, agent: strat.agent, after: lastError?.message });
      }
      for (let attempt = 1; attempt <= strat.attempts; attempt += 1) {
        if (this.halted) return this.abortNode(id);
        this.totalAttempts += 1;
        if (this.totalAttempts > this.config.maxTotalAttempts) { this.safeStop(`attempt budget exhausted (${this.config.maxTotalAttempts})`); return this.abortNode(id); }
        this.metrics.attempt(id);
        this.audit.record('node.attempt', { node: id, strategy: strat.name, agent: strat.agent, attempt });
        try {
          result = await this.runAgent(id, strat, attempt);
          break outer;
        } catch (err) {
          lastError = err;
          this.revertNode(id, `attempt ${attempt} (${strat.name}) failed`);
          this.metrics.attemptFailed(id);
          this.totalFailures += 1;
          const kind = err instanceof PolicyViolation ? 'policy' : err instanceof GateError ? 'gate' : 'error';
          this.audit.record('node.attempt_failed', { node: id, strategy: strat.name, attempt, kind, error: err.message });
          if (err instanceof PolicyViolation) {
            this.metrics.count('policyBlocks');
            this.audit.record('policy.blocked', { node: id, violations: err.violations ?? [], critical: !!err.critical });
            if (err.critical) { this.safeStop(`critical policy violation in ${id}: ${err.message}`); return this.abortNode(id); }
          }
          if (this.totalFailures > this.config.maxFailures) { this.safeStop(`failure budget exhausted (${this.config.maxFailures})`); return this.abortNode(id); }
          if (attempt < strat.attempts) {
            this.audit.record('node.retry', { node: id, nextAttempt: attempt + 1 });
            if (this.config.backoffMs) await sleep(this.config.backoffMs * 2 ** (attempt - 1));
          }
        }
      }
    }
    if (!result) return this.failNode(id, lastError?.message ?? 'unknown failure');
    if (this.halted) { this.revertNode(id, 'run halted before commit'); return this.abortNode(id); }

    // ---- human approval checkpoint
    const required = !!def.approval?.required;
    if (required || result.escalate) {
      st.status = Status.AWAITING_APPROVAL;
      this.metrics.count('approvalsRequested');
      const request = {
        nodeId: id, stage: def.stage, impact: def.impact,
        summary: def.approval?.summary ? def.approval.summary(result) : (result.summary ?? ''),
        artifacts: this.workspace.writtenBy(id), policyFindings: result.findings, escalatedByPolicy: !required,
      };
      this.audit.record('approval.requested', { node: id, impact: def.impact, escalatedByPolicy: !required, artifacts: request.artifacts, findings: request.policyFindings });
      const waitStart = Date.now();
      let decision;
      try {
        decision = await this.approver.decide(request);
      } catch (err) {
        this.revertNode(id, 'approval unavailable');
        this.safeStop(`approval for ${id} could not be obtained: ${err.message}`);
        return this.abortNode(id);
      }
      this.metrics.approvalWait(Date.now() - waitStart);
      this.audit.record('approval.decided', { node: id, approved: decision.approved, reviewer: decision.reviewer, mode: decision.mode, comment: decision.comment });
      this.context.decide({ by: decision.reviewer, nodeId: id, decision: decision.approved ? 'approved' : 'rejected', rationale: `${decision.comment ?? ''} [${decision.mode}]` });
      if (!decision.approved) {
        this.metrics.count('approvalsRejected');
        this.revertNode(id, `rejected by ${decision.reviewer}`);
        st.status = Status.REJECTED;
        st.error = decision.comment ?? 'rejected';
        this.safeStop(`${id} rejected by ${decision.reviewer}: ${decision.comment ?? ''}`);
        return undefined;
      }
      this.metrics.count('approvalsGranted');
    }

    // ---- commit
    const { version, changed, firstTime } = this.context.set(id, result.output, st.inputVersions);
    st.version = version;
    st.status = Status.SUCCEEDED;
    this.completionOrder = this.completionOrder.filter((x) => x !== id);
    this.completionOrder.push(id);
    for (const d of result.decisions ?? []) this.context.decide({ by: id, nodeId: id, ...d });
    const durationMs = Date.now() - startedAt;
    this.metrics.nodeSucceeded(id, durationMs);
    this.audit.record('node.succeeded', { node: id, version, changed, strategy: st.usedFallback ? 'fallback' : 'primary', artifacts: this.workspace.writtenBy(id).map((p) => ({ path: p, sha256: this.workspace.index.get(p)?.sha256 })), durationMs });
    if (result.replan) this.pendingReplans.push({ from: id, ...result.replan });
    if (!firstTime && changed) this.invalidateDescendants(id, `output of ${id} changed (now v${version})`);
    return undefined;
  }

  async runAgent(id, strat, attempt) {
    const def = this.graph.nodes.get(id);
    const agent = this.agents[strat.agent];
    if (typeof agent !== 'function') throw new Error(`unknown agent: ${strat.agent}`);
    const ctx = this.buildContext(id, strat.name, attempt);
    const out = await withTimeout(Promise.resolve(agent(ctx)), def.timeoutMs ?? this.config.nodeTimeoutMs, `agent ${strat.agent}`);
    if (!out || typeof out.output !== 'object' || out.output === null) throw new Error(`agent ${strat.agent} returned an invalid result (missing output object)`);

    const findings = [];
    const artifacts = out.artifacts ?? [];
    for (const a of artifacts) {
      const e = this.policy.evaluate('artifact', a);
      if (e.violations.length) {
        const tagged = e.violations.map((v) => ({ ...v, path: a.path }));
        findings.push(...tagged);
        this.audit.record('policy.evaluated', { node: id, path: a.path, violations: tagged });
        if (e.critical) throw new PolicyViolation(tagged, true);
        if (!e.allowed) throw new PolicyViolation(tagged, false);
      }
    }
    let escalate = false;
    if (out.change) {
      const e = this.policy.evaluate('change', out.change);
      if (e.violations.length) { findings.push(...e.violations); this.audit.record('policy.evaluated', { node: id, change: out.change, violations: e.violations }); }
      escalate = e.escalate;
    }
    for (const a of artifacts) this.workspace.write(id, a.path, a.content);

    let output = out.output;
    if (def.exitGate) {
      const g = await def.exitGate(out, this.buildContext(id, 'gate', attempt));
      this.audit.record('gate.exit', { node: id, ok: g.ok, reason: g.reason ?? null, evidence: g.evidence ?? null });
      if (!g.ok) throw new GateError(`exit gate failed: ${g.reason}`);
      if (g.evidence) output = { ...output, validation: g.evidence };
    }
    return { ...out, output, findings, escalate };
  }

  buildContext(id, strategy, attempt) {
    const upstream = () => this.graph.ancestorsOf(id);
    return {
      nodeId: id, strategy, attempt, requirement: this.requirement,
      get: (nid) => {
        if (!upstream().has(nid)) throw new Error(`${id} may not read ${nid}: not an upstream dependency`);
        return this.context.has(nid) ? structuredClone(this.context.get(nid)) : undefined;
      },
      has: (nid) => upstream().has(nid) && this.context.has(nid),
      read: (p) => this.workspace.read(p),
      exists: (p) => this.workspace.exists(p),
      list: (p) => this.workspace.list(p),
      exec: (command, args = [], opts = {}) => this.exec(id, command, args, opts),
      decisions: () => structuredClone(this.context.decisions),
      runInfo: () => ({ nodes: this.nodeReport(), metrics: this.metrics.summary(this.statuses()), files: this.workspace.list() }),
      ask: async (questions) => {
        this.audit.record('clarification.requested', { node: id, questions: questions.map((q) => q.id) });
        const r = await this.approver.answer(questions);
        this.audit.record('clarification.answered', { node: id, reviewer: r.reviewer, mode: r.mode, answers: r.answers, usedDefaults: r.usedDefaults ?? [] });
        return r;
      },
    };
  }

  exec(id, command, args, opts) {
    const e = this.policy.evaluate('command', { command, args });
    this.audit.record('command.requested', { node: id, command, args });
    if (!e.allowed) throw new PolicyViolation(e.violations, true);
    const r = runCommand(command, args, { cwd: opts.cwd ? this.workspace.resolveSafe(opts.cwd) : this.workspace.root, timeoutMs: opts.timeoutMs ?? 30_000 });
    this.audit.record('command.completed', { node: id, command, code: r.code, durationMs: r.durationMs, timedOut: r.timedOut });
    return r;
  }

  // ---------------------------------------------------------------- failure, rollback, safe-stop
  failNode(id, reason) {
    const st = this.state.get(id);
    st.status = Status.FAILED;
    st.error = reason;
    this.audit.record('node.failed', { node: id, reason });
    this.failure ??= { nodeId: id, reason };
  }

  abortNode(id) {
    const st = this.state.get(id);
    this.revertNode(id, 'aborted');
    st.status = Status.PENDING;
    st.note = 'aborted by safe-stop';
  }

  revertNode(id, why) {
    const paths = this.workspace.revert(id);
    if (paths.length) {
      this.metrics.count('rollbacks');
      this.audit.record('rollback', { node: id, why, restored: paths });
    }
    return paths;
  }

  rollbackRun(reason) {
    this.audit.record('run.rollback_started', { reason, order: [...this.completionOrder].reverse() });
    for (const id of [...this.completionOrder].reverse()) {
      this.revertNode(id, 'run rollback');
      this.state.get(id).status = Status.ROLLED_BACK;
    }
    this.completionOrder = [];
  }

  safeStop(reason) {
    if (this.halted) return;
    this.halted = reason;
    this.metrics.count('safeStops');
    this.audit.record('run.safe_stop', { reason });
  }

  /** External kill switch (operator action). */
  requestSafeStop(reason) { this.safeStop(`operator: ${reason}`); }

  // ---------------------------------------------------------------- dynamic re-planning
  applyReplans() {
    const pending = this.pendingReplans.splice(0);
    for (const r of pending) {
      const inserts = (r.insert ?? []).filter((d) => !this.graph.nodes.has(d.id));
      if (!inserts.length && !(r.before ?? []).length) continue;
      if (inserts.length === 0) continue; // idempotent: already applied
      if (this.replans + 1 > this.config.maxReplans) { this.safeStop(`re-plan budget exhausted (${this.config.maxReplans})`); return; }
      const snap = this.graph.snapshot();
      try {
        for (const d of inserts) this.graph.addNode(d);
        for (const target of r.before ?? []) for (const d of inserts) this.graph.addDependency(target, d.id);
        this.graph.validate();
      } catch (err) {
        this.graph.restore(snap);
        this.audit.record('replan.rejected', { from: r.from, reason: err.message });
        continue;
      }
      this.replans += 1;
      this.metrics.count('replans');
      for (const d of inserts) this.ensureState(d.id);
      for (const target of r.before ?? []) {
        const st = this.state.get(target);
        if (st.status !== Status.PENDING) this.invalidateNodes([target, ...this.graph.descendantsOf(target)], `re-plan inserted dependency before ${target}`);
      }
      this.audit.record('replan.applied', { from: r.from, inserted: inserts.map((d) => d.id), before: r.before ?? [], reason: r.reason ?? '' });
      this.context.decide({ by: r.from, nodeId: r.from, decision: `re-plan: insert ${inserts.map((d) => d.id).join(', ')}`, rationale: r.reason ?? '' });
    }
  }

  invalidateNodes(ids, reason) {
    for (const id of this.graph.sortIds(ids).reverse()) {
      const st = this.state.get(id);
      if (!st || [Status.PENDING, Status.RUNNING].includes(st.status)) continue;
      this.revertNode(id, reason);
      st.status = Status.PENDING;
      st.note = `stale: ${reason}`;
      this.completionOrder = this.completionOrder.filter((x) => x !== id);
      this.metrics.count('invalidations');
      this.audit.record('node.invalidated', { node: id, reason });
    }
  }

  invalidateDescendants(id, reason) {
    this.invalidateNodes([...this.graph.descendantsOf(id)], reason);
  }

  /** Upstream change (e.g. stakeholder revises an answer): new version, stale downstream, governed re-execution. */
  updateOutput(id, value, { by = 'operator', reason = '' } = {}) {
    const r = this.context.set(id, value, this.state.get(id).inputVersions);
    this.audit.record('context.updated', { node: id, by, reason, version: r.version, changed: r.changed });
    this.context.decide({ by, nodeId: id, decision: `updated output of ${id} to v${r.version}`, rationale: reason });
    if (r.changed) this.invalidateDescendants(id, `${id} updated to v${r.version}: ${reason}`);
    return r;
  }

  // ---------------------------------------------------------------- reporting
  nodeReport() {
    return [...this.graph.nodes.values()].map((n) => {
      const st = this.state.get(n.id);
      return { id: n.id, stage: n.stage, deps: n.deps, impact: n.impact, status: st.status, runs: st.runs, version: st.version, usedFallback: st.usedFallback, error: st.error, note: st.note, inputVersions: st.inputVersions, artifacts: this.workspace.writtenBy(n.id) };
    });
  }

  writeEvidence(result) {
    if (!this.evidenceDir) return;
    mkdirSync(this.evidenceDir, { recursive: true });
    const w = (name, data) => writeFileSync(join(this.evidenceDir, name), typeof data === 'string' ? data : JSON.stringify(data, null, 2));
    w('metrics.json', result.metrics);
    w('run-state.json', { status: result.status, halted: result.halted, failure: result.failure, nodes: result.nodes });
    w('lineage.json', { ...this.context.snapshot(), artifacts: Object.fromEntries(this.workspace.index) });
    w('workflow.mmd', this.graph.toMermaid());
  }
}
