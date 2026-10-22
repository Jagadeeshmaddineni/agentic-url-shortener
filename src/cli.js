#!/usr/bin/env node
import { resolve } from 'node:path';
import { AutoApprover, CliApprover } from './orchestrator/approvers.js';
import { AMBIGUOUS_ANSWERS, REQUIREMENTS, runScenario } from './scenarios/index.js';

const args = process.argv.slice(2);
const scenario = args.find((a) => !a.startsWith('--')) ?? 'help';
const flag = (n) => args.includes(`--${n}`);
const opt = (n) => { const i = args.indexOf(`--${n}`); return i >= 0 ? args[i + 1] : undefined; };

if (scenario === 'help' || flag('help')) {
  console.log(`Agentic SDLC orchestrator

Usage: node src/cli.js <greenfield|brownfield|ambiguous|all> [options]
  --auto-approve    approve every checkpoint automatically (DEMO ONLY; recorded in the audit log as mode=auto-demo)
  --chaos           inject transient agent failures to demonstrate retry / MTTR
  --no-revision     (ambiguous) skip the simulated mid-run stakeholder change
  --out <dir>       output directory (default ./runs)
  --requirement "<text>"   override the scenario requirement

Without --auto-approve an interactive reviewer is prompted at each human checkpoint.`);
  process.exit(0);
}

const names = scenario === 'all' ? ['greenfield', 'brownfield', 'ambiguous'] : [scenario];
let exit = 0;
for (const name of names) {
  if (!REQUIREMENTS[name]) { console.error(`Unknown scenario "${name}"`); process.exit(2); }
  const interactive = !flag('auto-approve');
  if (interactive && !process.stdin.isTTY) { console.error('No TTY available for approvals: pass --auto-approve for a demo run.'); process.exit(2); }
  const approver = interactive ? new CliApprover() : new AutoApprover({ answers: name === 'ambiguous' ? AMBIGUOUS_ANSWERS : {} });
  console.log(`\n=== Scenario: ${name} ===\n> ${opt('requirement') ?? REQUIREMENTS[name]}\n`);
  const r = await runScenario(name, { approver, chaos: flag('chaos'), revise: !flag('no-revision'), outDir: opt('out') ? resolve(process.cwd(), opt('out')) : undefined, requirement: opt('requirement') });
  approver.close?.();
  for (const n of r.nodes) console.log(`${n.status.padEnd(12)} ${n.id.padEnd(18)} runs=${n.runs} v${n.version}${n.usedFallback ? '  [fallback strategy]' : ''}${n.error ? `  ! ${n.error}` : ''}`);
  const m = r.metrics;
  console.log(`\nRESULT: ${r.status}${r.halted ? ` (safe-stop: ${r.halted})` : ''} | success ${m.successRate} | first-try ${m.firstAttemptSuccessRate} | retries ${m.retryCount} | fallbacks ${m.fallbackCount} | rollbacks ${m.rollbackCount} | replans ${m.replanCount} | invalidations ${m.invalidationCount} | MTTR ${m.mttrMs}ms | e2e ${m.endToEndLatencyMs}ms`);
  console.log(`Audit chain: ${r.auditChain.ok ? `verified (${r.auditChain.count} events)` : 'BROKEN'}`);
  console.log(`Workspace: ${r.workspaceDir}\nEvidence:  ${r.evidenceDir}`);
  if (r.status !== 'COMPLETED') exit = 1;
}
process.exit(exit);
