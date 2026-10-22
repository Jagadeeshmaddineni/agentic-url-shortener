import { mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { Orchestrator } from '../orchestrator/engine.js';
import { Workspace } from '../orchestrator/workspace.js';
import { PolicyEngine } from '../orchestrator/policy.js';
import { AuditLog } from '../orchestrator/audit.js';
import { Metrics } from '../orchestrator/metrics.js';
import { ContextStore } from '../orchestrator/context.js';
import { AutoApprover } from '../orchestrator/approvers.js';
import { resolveSpec } from '../agents/requirements.js';
import { PROJECT_ROOT, mdTable } from '../agents/common.js';
import { AGENTS, buildBrownfieldGraph, buildGreenfieldGraph } from './graphs.js';

export const REQUIREMENTS = {
  greenfield: 'Build a URL shortener service. Users create short links through a REST API (optional custom alias, optional expiry in seconds up to 30 days). Short links redirect with HTTP 302. Provide per-link analytics: total clicks, clicks per day and top referrers. Limit link creation to 10 requests per minute per client. Management endpoints (analytics, delete) must be protected by an API key. Data must survive restarts (file persistence) and analytics failures must never break redirects.',
  brownfield: 'SECURITY BUG: POST /shorten accepts any URL scheme, including javascript:, data: and file:, so short links can become XSS and open-redirect vectors. Reject every URL that is not http or https with HTTP 400. Valid http(s) URLs must keep working exactly as before.',
  ambiguous: 'We need something to make long links short and not live forever. People should be able to see how their links are doing. It has to be fast and safe, and ideally scalable.',
};

/** Stakeholder answers used in demo mode; unanswered questions fall back to documented defaults (recorded as assumptions). */
export const AMBIGUOUS_ANSWERS = { 'AMB-1': '14', 'AMB-3': '100' };

/** Wraps agents so selected nodes fail transiently on their first N calls (reliability demo / tests). */
export function withChaos(agents, plan) {
  const calls = {};
  const wrapped = { ...agents };
  for (const [agentName, failTimes] of Object.entries(plan)) {
    const original = agents[agentName];
    wrapped[agentName] = async (ctx) => {
      calls[agentName] = (calls[agentName] ?? 0) + 1;
      if (calls[agentName] <= failTimes) throw new Error(`chaos: injected transient failure #${calls[agentName]} in ${agentName}`);
      return original(ctx);
    };
  }
  return wrapped;
}

function seedLegacy(workspace) {
  const root = join(PROJECT_ROOT, 'fixtures', 'legacy-service');
  const walk = (dir) => {
    for (const name of readdirSync(dir)) {
      const p = join(dir, name);
      if (statSync(p).isDirectory()) walk(p); else workspace.seed(relative(root, p).split(sep).join('/'), readFileSync(p, 'utf8'));
    }
  };
  walk(root);
}

/** Simulated mid-run stakeholder revision: demonstrates upstream change -> stale downstream -> governed re-plan. */
function ambiguousHooks({ revise = true } = {}) {
  let done = false;
  return {
    afterBatch: async (orch, batch) => {
      if (!revise || done || !batch.includes('architecture') || !orch.context.has('clarify')) return;
      done = true;
      const current = orch.context.get('clarify');
      const base = orch.context.get('requirements').spec;
      const answers = { ...current.answers, 'AMB-1': '7' };
      const { spec } = resolveSpec(base, answers, current.usedDefaults);
      orch.updateOutput('clarify', { ...current, spec, answers, answeredBy: 'stakeholder (simulated revision)' }, { by: 'legal-reviewer (simulated)', reason: 'default link lifetime revised from 14 to 7 days after compliance review' });
    },
  };
}

export async function runScenario(name, { outDir = join(PROJECT_ROOT, 'runs'), approver, chaos = false, revise = true, requirement, config = {}, agentsOverride, limits } = {}) {
  if (!REQUIREMENTS[name]) throw new Error(`unknown scenario ${name}`);
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const runDir = join(outDir, `${name}-${stamp}`);
  mkdirSync(runDir, { recursive: true });
  const workspace = new Workspace(join(runDir, 'workspace'));
  const evidenceDir = join(runDir, 'evidence');
  const audit = new AuditLog({ file: join(evidenceDir, 'audit.jsonl') });
  const graph = name === 'brownfield' ? buildBrownfieldGraph() : buildGreenfieldGraph();
  if (name === 'brownfield') seedLegacy(workspace);

  let agents = agentsOverride ?? AGENTS;
  if (chaos) agents = withChaos(agents, name === 'brownfield' ? { 'changelog': 1 } : { implementation: 1, 'security-scan': 1 });

  const orchestrator = new Orchestrator({
    graph, agents, workspace, policy: new PolicyEngine(limits), audit, metrics: new Metrics(), context: new ContextStore(), evidenceDir,
    approver: approver ?? new AutoApprover({ answers: name === 'ambiguous' ? AMBIGUOUS_ANSWERS : {} }),
    config: { backoffMs: 0, ...config }, hooks: name === 'ambiguous' ? ambiguousHooks({ revise }) : {},
  });

  const result = await orchestrator.run(requirement ?? REQUIREMENTS[name]);
  const chain = AuditLog.verifyFile(join(evidenceDir, 'audit.jsonl'));
  writeFileSync(join(evidenceDir, 'audit-verification.json'), JSON.stringify(chain, null, 2));
  writeFileSync(join(evidenceDir, 'RUN_REPORT.md'), renderRunReport(name, result, chain, orchestrator));
  return { ...result, name, runDir, workspaceDir: workspace.root, evidenceDir, auditChain: chain, orchestrator };
}

export function renderRunReport(name, result, chain, orch) {
  const m = result.metrics;
  return `# Run report: ${name}\n\n- **Status:** ${result.status}${result.halted ? ` (safe-stop: ${result.halted})` : ''}\n- **Audit chain:** ${chain.ok ? `verified (${chain.count} events)` : `BROKEN at seq ${chain.brokenAtSeq}`}\n- **End-to-end latency:** ${m.endToEndLatencyMs} ms\n\n## Nodes\n${mdTable(['Node', 'Stage', 'Status', 'Runs', 'Version', 'Fallback', 'Depends on'], result.nodes.map((n) => [n.id, n.stage, n.status, n.runs, n.version, n.usedFallback ? 'yes' : '', n.deps.join(', ')]))}\n\n## Reliability metrics\n${mdTable(['Metric', 'Value'], [['Success rate (nodes)', m.successRate], ['First-attempt success rate', m.firstAttemptSuccessRate], ['Retries', m.retryCount], ['Fallbacks', m.fallbackCount], ['Rollbacks', m.rollbackCount], ['Re-plans', m.replanCount], ['Stale invalidations', m.invalidationCount], ['Policy blocks', m.policyBlocks], ['Safe-stops', m.safeStops], ['Approvals requested/granted/rejected', `${m.approvals.requested}/${m.approvals.granted}/${m.approvals.rejected}`], ['MTTR (ms)', m.mttrMs]])}\n\n## Approvals\n${orch.audit.query('approval.decided').map((e) => `- \`${e.data.node}\`: ${e.data.approved ? 'approved' : 'REJECTED'} by ${e.data.reviewer} [${e.data.mode}]`).join('\n') || '- none'}\n\n## Timeline of governance events\n${orch.audit.events.filter((e) => ['node.fallback', 'node.retry', 'rollback', 'replan.applied', 'node.invalidated', 'policy.blocked', 'run.safe_stop', 'clarification.answered', 'context.updated'].includes(e.type)).map((e) => `- #${e.seq} \`${e.type}\` ${JSON.stringify(e.data)}`).join('\n') || '- none'}\n\nFiles: audit.jsonl (hash-chained), metrics.json, lineage.json, run-state.json, workflow.mmd.\n`;
}
