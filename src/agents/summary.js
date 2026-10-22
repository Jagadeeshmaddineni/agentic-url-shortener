import { mdTable, specOf } from './common.js';

/**
 * Final engineering summary: plan/rationale, artifacts, risks/trade-offs/validation, assumptions,
 * limitations, decision lineage. Generated from run evidence, not free text, so it cannot drift from reality.
 */
export async function summaryAgent(ctx) {
  const info = ctx.runInfo();
  const decisions = ctx.decisions();
  const isBrownfield = ctx.has('codebase-analysis');
  const spec = isBrownfield ? ctx.get('requirements').spec : specOf(ctx);
  const done = info.nodes.filter((n) => n.status === 'SUCCEEDED');

  const plan = mdTable(['Stage', 'Node', 'Depends on', 'Impact', 'Runs', 'Notes'], info.nodes.filter((n) => n.id !== 'summary').map((n) => [n.stage, n.id, n.deps.join(', ') || '-', n.impact, n.runs, [n.usedFallback ? 'fallback strategy used' : '', n.version > 1 ? `re-generated (v${n.version})` : ''].filter(Boolean).join('; ')]));
  const artifacts = info.files.filter((f) => !f.endsWith('ENGINEERING_SUMMARY.md')).map((f) => `- \`${f}\``).join('\n');

  const risks = ctx.has('risk') ? ctx.get('risk') : null;
  const validation = [];
  for (const n of done) {
    const out = ctx.has(n.id) ? ctx.get(n.id) : null;
    if (out?.validation) validation.push([n.id, JSON.stringify(out.validation)]);
  }
  const assumptions = (spec.assumptions ?? []).map((a) => `- ${a.id}: ${a.text}`);
  const m = info.metrics;

  const md = `# Engineering summary

## 1. Request and plan
> ${String(ctx.requirement).slice(0, 600)}

Workflow executed as a dependency graph (parallel branches synchronize at join nodes; high-impact nodes require human approval):

${plan}

## 2. Rationale (decision lineage)
${decisions.map((d) => `- **${d.id}** (${d.by}, node \`${d.nodeId}\`): ${d.decision}${d.rationale ? ` - ${d.rationale}` : ''}`).join('\n')}

## 3. Artifacts
${artifacts}

## 4. Validation
${validation.length ? mdTable(['Node', 'Evidence'], validation) : '_No gate evidence recorded._'}

## 5. Risks, trade-offs and guardrails
${risks ? mdTable(['Risk', 'Mitigation', 'Validated by'], risks.risks.map((r) => [r.risk, r.mitigation, r.validatedBy])) : 'See docs/IMPACT_ANALYSIS.md and docs/CHANGE_PLAN.md.'}
${risks ? `\nResidual (accepted):\n${risks.residual.map((r) => `- ${r}`).join('\n')}` : ''}

Orchestration guardrails applied: policy rules SEC-001..004, CMP-001, CHG-001..003; bounded retries, fallback, rollback, safe-stop budgets; hash-chained audit log.

## 6. Assumptions
${assumptions.length ? assumptions.join('\n') : '- None beyond the stated request.'}

## 7. Reliability metrics (at time of summary)
${mdTable(['Metric', 'Value'], [['Nodes succeeded', `${m.nodesSucceeded}/${m.nodesTotal}`], ['First-attempt success rate', m.firstAttemptSuccessRate], ['Retries', m.retryCount], ['Fallbacks', m.fallbackCount], ['Rollbacks', m.rollbackCount], ['Re-plans / invalidations', `${m.replanCount} / ${m.invalidationCount}`], ['Approvals granted/requested', `${m.approvals.granted}/${m.approvals.requested}`], ['MTTR (ms)', m.mttrMs]])}

## 8. Limitations
- Agents are deterministic and template/rule based; the LLM seam exists but no model is called in this prototype.
- Reference service is single-instance: in-process rate limiting and a JSON file store.
- Latency/throughput targets are recorded as requirements but not load-tested.
- Approvals in demo mode may be automatic (see audit \`approval.decided.mode\`); production use requires named human reviewers.
`;
  return { output: { sections: 8, artifactsListed: info.files.length }, summary: 'Final engineering summary generated from run evidence', artifacts: [{ path: 'docs/ENGINEERING_SUMMARY.md', content: md }] };
}
