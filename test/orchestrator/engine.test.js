import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Orchestrator, Status } from '../../src/orchestrator/engine.js';
import { WorkflowGraph } from '../../src/orchestrator/graph.js';
import { Workspace } from '../../src/orchestrator/workspace.js';
import { PolicyEngine } from '../../src/orchestrator/policy.js';
import { AuditLog } from '../../src/orchestrator/audit.js';
import { Metrics } from '../../src/orchestrator/metrics.js';
import { ContextStore } from '../../src/orchestrator/context.js';
import { ScriptedApprover } from '../../src/orchestrator/approvers.js';
import { parseNodeTestSummary } from '../../src/orchestrator/sandbox.js';

const ok = (output = {}, artifacts = []) => ({ output, artifacts });

function build({ nodes, agents, approver = new ScriptedApprover(), config = {}, hooks = {}, policy = new PolicyEngine() }) {
  const graph = new WorkflowGraph();
  nodes.forEach((n) => graph.addNode(n));
  const workspace = new Workspace(mkdtempSync(join(tmpdir(), 'orch-')));
  const audit = new AuditLog();
  const orch = new Orchestrator({ graph, agents, workspace, policy, approver, audit, metrics: new Metrics(), context: new ContextStore(), config, hooks });
  return { orch, graph, workspace, audit, approver };
}
const events = (audit, type) => audit.query(type);

test('node:test summaries parse spec and TAP reporter formats', () => {
  assert.deepEqual(parseNodeTestSummary('\u2139 tests 12\n\u2139 pass 10\n\u2139 fail 2'), { tests: 12, pass: 10, fail: 2 });
  assert.deepEqual(parseNodeTestSummary('# tests 3\n# pass 2\n# fail 1'), { tests: 3, pass: 2, fail: 1 });
});

test('graph validation: cycles, unknown deps and unapproved high-impact nodes are rejected', () => {
  const g = new WorkflowGraph().addNode({ id: 'a', agent: 'x', deps: ['b'] }).addNode({ id: 'b', agent: 'x', deps: ['a'] });
  assert.throws(() => g.validate(), /cycle/);
  assert.throws(() => new WorkflowGraph().addNode({ id: 'a', agent: 'x', deps: ['zzz'] }).validate(), /unknown node/);
  assert.throws(() => new WorkflowGraph().addNode({ id: 'a', agent: 'x', impact: 'high' }).validate(), /CHG-002/);
});

test('parallel branches run in one batch and synchronise before the join node', async () => {
  const order = [];
  const agent = (name) => async () => { order.push(`start:${name}`); await new Promise((r) => setTimeout(r, 20)); order.push(`end:${name}`); return ok({ name }); };
  const { orch, audit } = build({
    nodes: [{ id: 'root', agent: 'root' }, { id: 'left', agent: 'left', deps: ['root'] }, { id: 'right', agent: 'right', deps: ['root'] }, { id: 'join', agent: 'join', deps: ['left', 'right'] }],
    agents: { root: agent('root'), left: agent('left'), right: agent('right'), join: agent('join') },
  });
  const r = await orch.run('req');
  assert.equal(r.status, 'COMPLETED');
  assert.deepEqual(order.slice(2, 4), ['start:left', 'start:right'], 'siblings start together');
  assert.ok(order.indexOf('start:join') > order.indexOf('end:left') && order.indexOf('start:join') > order.indexOf('end:right'));
  assert.ok(events(audit, 'batch.started').some((e) => e.data.parallel));
});

test('bounded retry recovers from a transient failure and records MTTR/retry metrics', async () => {
  let calls = 0;
  const { orch, workspace } = build({
    nodes: [{ id: 'flaky', agent: 'flaky', retries: 2 }],
    agents: { flaky: async () => { calls += 1; if (calls < 3) throw new Error('transient'); return ok({ done: true }, [{ path: 'out.md', content: 'ok' }]); } },
  });
  const r = await orch.run('req');
  assert.equal(r.status, 'COMPLETED');
  assert.equal(calls, 3);
  assert.equal(r.metrics.retryCount, 2);
  assert.ok(r.metrics.mttrMs >= 0);
  assert.equal(workspace.read('out.md'), 'ok');
});

test('retries are bounded, then the fallback strategy is used', async () => {
  let primary = 0;
  const { orch, audit } = build({
    nodes: [{ id: 'n', agent: 'primary', retries: 1, fallbackAgent: 'fallback' }],
    agents: { primary: async () => { primary += 1; throw new Error('always fails'); }, fallback: async () => ok({ via: 'fallback' }) },
  });
  const r = await orch.run('req');
  assert.equal(primary, 2, '1 try + 1 retry, no more');
  assert.equal(r.status, 'COMPLETED');
  assert.equal(r.metrics.fallbackCount, 1);
  assert.equal(events(audit, 'node.fallback').length, 1);
});

test('terminal failure rolls back every committed node and skips dependents', async () => {
  const { orch, workspace } = build({
    nodes: [{ id: 'a', agent: 'a' }, { id: 'b', agent: 'b', deps: ['a'], retries: 0 }, { id: 'c', agent: 'c', deps: ['b'] }],
    agents: {
      a: async () => ok({}, [{ path: 'a.md', content: 'A' }]),
      b: async () => { throw new Error('boom'); },
      c: async () => ok({}),
    },
  });
  const r = await orch.run('req');
  assert.equal(r.status, 'FAILED');
  assert.equal(r.statuses.a, Status.ROLLED_BACK);
  assert.equal(r.statuses.b, Status.FAILED);
  assert.equal(r.statuses.c, Status.SKIPPED);
  assert.equal(workspace.exists('a.md'), false, 'committed artifacts are reverted');
  assert.ok(r.metrics.rollbackCount >= 1);
});

test('exit gate failure reverts partial artifacts of the attempt', async () => {
  const { orch, workspace } = build({
    nodes: [{ id: 'g', agent: 'g', retries: 0, exitGate: async (_o, v) => ({ ok: v.exists('x.md') && false, reason: 'not good enough' }) }],
    agents: { g: async () => ok({}, [{ path: 'x.md', content: 'partial' }]) },
  });
  const r = await orch.run('req');
  assert.equal(r.statuses.g, Status.FAILED);
  assert.equal(workspace.exists('x.md'), false);
});

test('entry gate blocks execution when preconditions are not met', async () => {
  let ran = false;
  const { orch } = build({
    nodes: [{ id: 'e', agent: 'e', entryGate: async () => ({ ok: false, reason: 'precondition' }) }],
    agents: { e: async () => { ran = true; return ok({}); } },
  });
  const r = await orch.run('req');
  assert.equal(ran, false);
  assert.equal(r.statuses.e, Status.FAILED);
});

test('high-impact node requires approval; rejection reverts its work and safe-stops the run', async () => {
  const approver = new ScriptedApprover({ decisions: { release: 'reject' } });
  const { orch, workspace, audit } = build({
    nodes: [{ id: 'build', agent: 'build' }, { id: 'release', agent: 'release', deps: ['build'], impact: 'high', approval: { required: true } }, { id: 'after', agent: 'after', deps: ['release'] }],
    agents: { build: async () => ok({}, [{ path: 'b.md', content: 'b' }]), release: async () => ok({}, [{ path: 'r.md', content: 'r' }]), after: async () => ok({}) },
    approver,
  });
  const r = await orch.run('req');
  assert.equal(r.status, 'HALTED');
  assert.equal(r.statuses.release, Status.REJECTED);
  assert.equal(r.statuses.after, Status.SKIPPED);
  assert.equal(workspace.exists('r.md'), false);
  assert.equal(workspace.exists('b.md'), true, 'earlier approved work is retained');
  assert.equal(events(audit, 'approval.decided')[0].data.approved, false);
  assert.equal(approver.requests.length, 1);
});

test('approved high-impact node proceeds and the decision is on the lineage', async () => {
  const { orch } = build({
    nodes: [{ id: 'r', agent: 'r', impact: 'high', approval: { required: true } }],
    agents: { r: async () => ok({}) },
  });
  const r = await orch.run('req');
  assert.equal(r.status, 'COMPLETED');
  assert.equal(r.metrics.approvals.granted, 1);
  assert.equal(orch.context.decisions[0].decision, 'approved');
});

test('policy: dangerous API is blocked and retried; critical secret leak safe-stops immediately', async () => {
  let n = 0;
  const a = build({
    nodes: [{ id: 'impl', agent: 'impl', retries: 1 }],
    agents: { impl: async () => { n += 1; return ok({}, [{ path: 'x.js', content: n === 1 ? 'eval("1")' : 'export const x = 1;' }]); } },
  });
  const r1 = await a.orch.run('req');
  assert.equal(r1.status, 'COMPLETED');
  assert.equal(r1.metrics.policyBlocks, 1);

  const b = build({
    nodes: [{ id: 'impl', agent: 'impl' }, { id: 'next', agent: 'next', deps: ['impl'] }],
    agents: { impl: async () => ok({}, [{ path: 'cfg.js', content: 'const k = "AKIAABCDEFGHIJKLMNOP";' }]), next: async () => ok({}) },
  });
  const r2 = await b.orch.run('req');
  assert.equal(r2.status, 'HALTED');
  assert.match(r2.halted, /SEC-001/);
  assert.equal(b.workspace.exists('cfg.js'), false);
});

test('policy: path traversal attempts are critical', async () => {
  const { orch } = build({ nodes: [{ id: 'x', agent: 'x' }], agents: { x: async () => ok({}, [{ path: '../evil.md', content: 'x' }]) } });
  const r = await orch.run('req');
  assert.equal(r.status, 'HALTED');
  assert.match(r.halted, /SEC-003/);
});

test('policy: non-allow-listed commands are critical; change budget escalates to approval', async () => {
  const a = build({ nodes: [{ id: 'x', agent: 'x' }], agents: { x: async (ctx) => { ctx.exec('curl', ['http://example.com']); return ok({}); } } });
  assert.equal((await a.orch.run('req')).status, 'HALTED');

  const approver = new ScriptedApprover();
  const b = build({ nodes: [{ id: 'patch', agent: 'patch' }], agents: { patch: async () => ({ ...ok({}), change: { changedLines: 500 } }) }, approver });
  const r = await b.orch.run('req');
  assert.equal(r.status, 'COMPLETED');
  assert.equal(approver.requests.length, 1);
  assert.equal(approver.requests[0].escalatedByPolicy, true);
});

test('safe-stop: attempt budget halts a runaway workflow', async () => {
  const { orch } = build({
    nodes: [{ id: 'a', agent: 'a', retries: 50 }],
    agents: { a: async () => { throw new Error('nope'); } },
    config: { maxTotalAttempts: 3, maxFailures: 100 },
  });
  const r = await orch.run('req');
  assert.equal(r.status, 'HALTED');
  assert.match(r.halted, /attempt budget/);
});

test('safe-stop: operator kill switch between batches', async () => {
  const { orch } = build({
    nodes: [{ id: 'a', agent: 'a' }, { id: 'b', agent: 'b', deps: ['a'] }],
    agents: { a: async () => ok({}), b: async () => ok({}) },
    hooks: { afterBatch: async (o) => o.requestSafeStop('incident declared') },
  });
  const r = await orch.run('req');
  assert.equal(r.status, 'HALTED');
  assert.equal(r.statuses.b, Status.SKIPPED);
});

test('dynamic re-plan inserts a node before a dependent, and rejects invalid plans', async () => {
  const ran = [];
  const mk = (n, extra) => async () => { ran.push(n); return { ...ok({ n }), ...extra }; };
  const { orch, audit } = build({
    nodes: [{ id: 'req', agent: 'req' }, { id: 'design', agent: 'design', deps: ['req'] }],
    agents: {
      req: mk('req', { replan: { reason: 'ambiguity', insert: [{ id: 'clarify', agent: 'clarify', deps: ['req'] }], before: ['design'] } }),
      clarify: mk('clarify'), design: mk('design'),
    },
  });
  const r = await orch.run('req');
  assert.equal(r.status, 'COMPLETED');
  assert.deepEqual(ran, ['req', 'clarify', 'design']);
  assert.equal(r.metrics.replanCount, 1);
  assert.equal(events(audit, 'replan.applied').length, 1);

  const bad = build({
    nodes: [{ id: 'req', agent: 'req' }],
    agents: { req: mk('req', { replan: { insert: [{ id: 'danger', agent: 'danger', impact: 'high' }], before: [] } }), danger: mk('danger') },
  });
  const r2 = await bad.orch.run('req');
  assert.equal(r2.metrics.replanCount, 0);
  assert.equal(events(bad.audit, 'replan.rejected').length, 1);
});

test('upstream change invalidates downstream nodes, which re-run with new input versions (decision lineage)', async () => {
  const seen = [];
  let flipped = false;
  const { orch, workspace } = build({
    nodes: [{ id: 'spec', agent: 'spec' }, { id: 'design', agent: 'design', deps: ['spec'] }, { id: 'impl', agent: 'impl', deps: ['design'], impact: 'high', approval: { required: true } }],
    agents: {
      spec: async () => ok({ ttl: 30 }),
      design: async (ctx) => ok({ ttl: ctx.get('spec').ttl }, [{ path: 'design.md', content: `ttl=${ctx.get('spec').ttl}` }]),
      impl: async (ctx) => { seen.push(ctx.get('design').ttl); return ok({}); },
    },
    hooks: { afterBatch: async (o, batch) => { if (!flipped && batch.includes('design')) { flipped = true; o.updateOutput('spec', { ttl: 7 }, { by: 'stakeholder', reason: 'requirement revised' }); } } },
  });
  const r = await orch.run('req');
  assert.equal(r.status, 'COMPLETED');
  assert.deepEqual(seen, [7], 'impl only ever ran against the revised design');
  assert.equal(workspace.read('design.md'), 'ttl=7');
  assert.equal(orch.context.version('spec'), 2);
  assert.equal(orch.context.version('design'), 2);
  assert.equal(r.nodes.find((n) => n.id === 'design').inputVersions.spec, 2);
  assert.ok(r.metrics.invalidationCount >= 1);
  assert.equal(r.metrics.approvals.granted, 1, 'approval is requested again only after re-execution');
});

test('agents can only read upstream context (no hidden coupling)', async () => {
  const { orch } = build({
    nodes: [{ id: 'a', agent: 'a' }, { id: 'b', agent: 'b' }],
    agents: { a: async () => ok({ secret: 1 }), b: async (ctx) => { ctx.get('a'); return ok({}); } },
  });
  const r = await orch.run('req');
  assert.equal(r.statuses.b, Status.FAILED);
});

test('audit log is hash-chained and tamper-evident', async () => {
  const { orch, audit } = build({ nodes: [{ id: 'a', agent: 'a' }], agents: { a: async () => ok({}) } });
  await orch.run('req');
  assert.equal(AuditLog.verify(audit.events).ok, true);
  const tampered = structuredClone(audit.events);
  tampered[2].data = { forged: true };
  const v = AuditLog.verify(tampered);
  assert.equal(v.ok, false);
  assert.equal(v.brokenAtSeq, 3);
});

test('workspace confines paths and journals reverts exactly', () => {
  const ws = new Workspace(mkdtempSync(join(tmpdir(), 'ws-')));
  assert.throws(() => ws.write('n', '../escape.txt', 'x'), /escapes workspace/);
  ws.seed('f.md', 'original');
  ws.write('n', 'f.md', 'changed');
  ws.write('n', 'new.md', 'new');
  assert.deepEqual(ws.revert('n').sort(), ['f.md', 'new.md']);
  assert.equal(ws.read('f.md'), 'original');
  assert.equal(ws.exists('new.md'), false);
});
