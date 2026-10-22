/** Reliability metrics derived from orchestration events. */
export class Metrics {
  constructor(now = () => Date.now()) {
    this.now = now;
    this.runStart = null;
    this.runEnd = null;
    this.nodes = new Map();
    this.counters = { attempts: 0, failures: 0, retries: 0, fallbacks: 0, rollbacks: 0, replans: 0, invalidations: 0, approvalsRequested: 0, approvalsGranted: 0, approvalsRejected: 0, policyBlocks: 0, safeStops: 0 };
    this.recoveryTimes = [];
    this.approvalWaits = [];
  }

  entry(id) {
    if (!this.nodes.has(id)) this.nodes.set(id, { firstFailureAt: null, firstAttemptSucceeded: null, durationMs: 0, attempts: 0 });
    return this.nodes.get(id);
  }

  runStarted() { this.runStart = this.now(); }
  runFinished() { this.runEnd = this.now(); }

  attempt(id) {
    this.counters.attempts += 1;
    const e = this.entry(id);
    e.attempts += 1;
    if (e.attempts > 1) this.counters.retries += 1;
  }

  attemptFailed(id) {
    this.counters.failures += 1;
    const e = this.entry(id);
    if (e.firstAttemptSucceeded === null) e.firstAttemptSucceeded = false;
    if (e.firstFailureAt === null) e.firstFailureAt = this.now();
  }

  nodeSucceeded(id, durationMs) {
    const e = this.entry(id);
    if (e.firstAttemptSucceeded === null) e.firstAttemptSucceeded = true;
    e.durationMs += durationMs;
    if (e.firstFailureAt !== null) {
      this.recoveryTimes.push(this.now() - e.firstFailureAt);
      e.firstFailureAt = null;
    }
  }

  count(name, n = 1) { this.counters[name] += n; }
  approvalWait(ms) { this.approvalWaits.push(ms); }

  summary(statuses = {}) {
    const ids = Object.keys(statuses);
    const total = ids.length;
    const succeeded = ids.filter((i) => statuses[i] === 'SUCCEEDED').length;
    const firstTry = [...this.nodes.values()].filter((n) => n.firstAttemptSucceeded === true).length;
    const avg = (a) => (a.length ? Math.round(a.reduce((x, y) => x + y, 0) / a.length) : 0);
    return {
      nodesTotal: total,
      nodesSucceeded: succeeded,
      successRate: total ? +(succeeded / total).toFixed(3) : 0,
      firstAttemptSuccessRate: this.nodes.size ? +(firstTry / this.nodes.size).toFixed(3) : 0,
      retryCount: this.counters.retries,
      rollbackCount: this.counters.rollbacks,
      retryRatePerNode: total ? +(this.counters.retries / total).toFixed(3) : 0,
      fallbackCount: this.counters.fallbacks,
      replanCount: this.counters.replans,
      invalidationCount: this.counters.invalidations,
      policyBlocks: this.counters.policyBlocks,
      safeStops: this.counters.safeStops,
      approvals: { requested: this.counters.approvalsRequested, granted: this.counters.approvalsGranted, rejected: this.counters.approvalsRejected, avgWaitMs: avg(this.approvalWaits) },
      mttrMs: avg(this.recoveryTimes),
      endToEndLatencyMs: this.runStart && this.runEnd ? this.runEnd - this.runStart : null,
      perNode: Object.fromEntries([...this.nodes].map(([id, n]) => [id, { attempts: n.attempts, durationMs: n.durationMs }])),
      counters: { ...this.counters },
    };
  }
}
