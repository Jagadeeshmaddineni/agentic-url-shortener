import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runScenario, AMBIGUOUS_ANSWERS } from '../../src/scenarios/index.js';
import { AutoApprover, ScriptedApprover } from '../../src/orchestrator/approvers.js';
import { AuditLog } from '../../src/orchestrator/audit.js';

const out = () => mkdtempSync(join(tmpdir(), 'scn-'));
const read = (r, p) => readFileSync(join(r.workspaceDir, p), 'utf8');

test('greenfield: parallel branches, approvals, generated project passes its own tests', async () => {
  const r = await runScenario('greenfield', { outDir: out(), approver: new AutoApprover() });
  assert.equal(r.status, 'COMPLETED');
  assert.equal(r.auditChain.ok, true);
  assert.equal(r.metrics.approvals.granted, 2, 'api-spec and release-readiness');
  const parallel = r.orchestrator.audit.query('batch.started').find((e) => e.data.nodes.includes('unit-tests'));
  assert.deepEqual(parallel.data.nodes.sort(), ['docs', 'security-scan', 'unit-tests']);
  for (const f of ['openapi.yaml', 'README.md', 'docs/ARCHITECTURE.md', 'docs/RISKS.md', 'docs/ENGINEERING_SUMMARY.md', 'src/service/app.js', 'test/service/acceptance.generated.test.js']) assert.ok(existsSync(join(r.workspaceDir, f)), f);
  assert.match(read(r, 'src/service/spec-config.json'), /"maxTtlSeconds": 2592000/);
  assert.ok(existsSync(join(r.evidenceDir, 'metrics.json')));
});

test('greenfield with chaos: transient failures are retried and MTTR is recorded', async () => {
  const r = await runScenario('greenfield', { outDir: out(), chaos: true, approver: new AutoApprover() });
  assert.equal(r.status, 'COMPLETED');
  assert.ok(r.metrics.retryCount >= 2);
  assert.ok(r.metrics.firstAttemptSuccessRate < 1);
});

test('greenfield: reviewer rejecting the API contract halts before any implementation exists', async () => {
  const r = await runScenario('greenfield', { outDir: out(), approver: new ScriptedApprover({ decisions: { 'api-spec': 'reject' } }) });
  assert.equal(r.status, 'HALTED');
  assert.equal(r.statuses['api-spec'], 'REJECTED');
  assert.equal(r.statuses.implementation, 'SKIPPED');
  assert.equal(existsSync(join(r.workspaceDir, 'src/service/app.js')), false);
  assert.equal(existsSync(join(r.workspaceDir, 'openapi.yaml')), false, 'rejected artifacts are reverted');
});

test('brownfield: bug reproduced red, naive patch fails gate, fallback strategy fixes it', async () => {
  const r = await runScenario('brownfield', { outDir: out(), approver: new AutoApprover() });
  assert.equal(r.status, 'COMPLETED');
  const patch = r.nodes.find((n) => n.id === 'patch');
  assert.equal(patch.usedFallback, true);
  assert.equal(r.metrics.fallbackCount, 1);
  assert.match(read(r, 'src/app.js'), /validateDestination/);
  assert.doesNotMatch(read(r, 'src/app.js'), /startsWith/);
  assert.match(read(r, 'docs/IMPACT_ANALYSIS.md'), /Direct change: src\/app\.js/);
  const gate = r.orchestrator.audit.query('gate.exit').find((e) => e.data.node === 'reproduce');
  assert.equal(gate.data.evidence.reproduced, true);
});

test('brownfield: rejecting the breaking-change plan stops before any code is touched', async () => {
  const r = await runScenario('brownfield', { outDir: out(), approver: new ScriptedApprover({ decisions: { 'change-plan': 'reject' } }) });
  assert.equal(r.status, 'HALTED');
  assert.doesNotMatch(read(r, 'src/app.js'), /validateDestination|startsWith/);
});

test('brownfield: a tiny change budget escalates the patch to human approval', async () => {
  const approver = new ScriptedApprover();
  const r = await runScenario('brownfield', { outDir: out(), approver, limits: { maxChangedLines: 1 } });
  assert.equal(r.status, 'COMPLETED');
  assert.ok(approver.requests.some((q) => q.nodeId === 'patch' && q.escalatedByPolicy));
});

test('ambiguous: re-plans with a clarification node, applies a mid-run revision, regenerates downstream', async () => {
  const r = await runScenario('ambiguous', { outDir: out(), approver: new AutoApprover({ answers: AMBIGUOUS_ANSWERS }) });
  assert.equal(r.status, 'COMPLETED');
  assert.equal(r.metrics.replanCount, 1);
  assert.ok(r.metrics.invalidationCount >= 2);
  const arch = r.nodes.find((n) => n.id === 'architecture');
  assert.equal(arch.version, 2);
  assert.equal(JSON.parse(read(r, 'src/service/spec-config.json')).defaultTtlSeconds, 7 * 86400, 'final code reflects the revised answer');
  assert.match(read(r, 'docs/REQUIREMENTS.md'), /AMB-3/);
  const assumptions = r.orchestrator.context.get('clarify').spec.assumptions.map((a) => a.id);
  assert.ok(assumptions.includes('ASM-AMB-2'), 'unanswered questions are recorded as assumptions');
});

test('ambiguous without revision never re-generates architecture', async () => {
  const r = await runScenario('ambiguous', { outDir: out(), revise: false, approver: new AutoApprover({ answers: AMBIGUOUS_ANSWERS }) });
  assert.equal(r.status, 'COMPLETED');
  assert.equal(r.nodes.find((n) => n.id === 'architecture').version, 1);
  assert.equal(JSON.parse(read(r, 'src/service/spec-config.json')).defaultTtlSeconds, 14 * 86400);
});

test('audit log files verify and detect tampering', async () => {
  const r = await runScenario('brownfield', { outDir: out(), approver: new AutoApprover() });
  assert.equal(AuditLog.verifyFile(join(r.evidenceDir, 'audit.jsonl')).ok, true);
});
