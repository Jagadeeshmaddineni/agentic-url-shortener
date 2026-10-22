import { applyEdits, diffLines, mdTable, securityScan } from './common.js';
import { parseNodeTestSummary } from '../orchestrator/sandbox.js';

const STOP = new Set(['the', 'and', 'that', 'with', 'this', 'from', 'every', 'must', 'keep', 'exactly', 'before', 'become', 'working', 'valid', 'any', 'are', 'not', 'can', 'all', 'but', 'bug', 'security', 'including', 'accepts', 'which', 'only']);

/** Change-request interpretation for brownfield work. */
export async function brownfieldRequirementsAgent(ctx) {
  const text = ctx.requirement;
  const badSchemes = [...new Set((text.toLowerCase().match(/\b(javascript|data|file|ftp|vbscript)\b/g) ?? []))];
  const spec = {
    title: 'Reject non-http(s) destination URLs', kind: /bug|fix|security/i.test(text) ? 'bugfix' : 'enhancement', intent: text.trim(),
    capabilities: ['validation'], config: {}, ambiguities: [],
    functional: [
      { id: 'FR-1', capability: 'validation', text: 'POST /shorten must reject any destination that is not an http or https URL with HTTP 400.', acceptance: [`rejected schemes include: ${(badSchemes.length ? badSchemes : ['javascript']).join(', ')}:`, 'look-alike schemes such as "httpevil:" are also rejected', 'the error body explains that only http and https are allowed'] },
      { id: 'FR-2', capability: 'no-regression', text: 'Valid http and https URLs keep working exactly as before (201 on create, 302 on redirect).', acceptance: ['existing test suite stays green', 'stored URL string is unchanged'] },
    ],
    nonFunctional: [{ id: 'NFR-1', text: 'Smallest possible blast radius: touch only modules on the request-validation path.' }, { id: 'NFR-2', text: 'No new dependencies.' }],
    assumptions: [{ id: 'ASM-1', text: 'Clients that relied on non-http(s) links will now receive 400; this is an intentional, security-driven breaking behaviour.' }, { id: 'ASM-2', text: 'No data migration: previously stored non-http(s) links are out of scope and flagged for follow-up.' }],
  };
  return { output: { spec }, summary: `${spec.kind}: ${spec.functional.length} requirements, ${spec.assumptions.length} assumptions`, decisions: [{ decision: `Classified request as ${spec.kind}`, rationale: 'Keywords: security/bug/reject' }], artifacts: [{ path: 'docs/CHANGE_REQUEST.md', content: `# Change request\n\n> ${spec.intent}\n\n${spec.functional.map((f) => `## ${f.id}\n${f.text}\n${f.acceptance.map((a) => `- ${a}`).join('\n')}`).join('\n\n')}\n\n## Assumptions\n${spec.assumptions.map((a) => `- ${a.id}: ${a.text}`).join('\n')}\n` }] };
}

/** Codebase reasoning: real import graph, route map and keyword-driven impact analysis of the workspace. */
export async function codebaseAnalysisAgent(ctx) {
  const files = ctx.list('src').filter((f) => f.endsWith('.js'));
  const tests = ctx.list('test').filter((f) => f.endsWith('.test.js'));
  const modules = files.map((file) => {
    const src = ctx.read(file);
    const imports = [...src.matchAll(/from\s+['"](\.[^'"]+)['"]/g)].map((m) => `src/${m[1].replace(/^\.\//, '')}`);
    const exports = [...src.matchAll(/export\s+(?:async\s+)?(?:function|class|const)\s+(\w+)/g)].map((m) => m[1]);
    const routes = [...src.matchAll(/req\.method === '(\w+)'\s*&&\s*req\.url === '([^']+)'/g)].map((m) => ({ method: m[1], path: m[2], file }));
    return { file, imports, exports, routes, lines: src.split('\n').length };
  });
  const edges = modules.flatMap((m) => m.imports.map((to) => ({ from: m.file, to })));
  const routes = modules.flatMap((m) => m.routes);

  const mentionedPaths = [...ctx.requirement.matchAll(/(\/[a-z]+)\b/g)].map((m) => m[1]);
  const tokens = [...new Set((ctx.requirement.toLowerCase().match(/[a-z]{3,}/g) ?? []).filter((t) => !STOP.has(t)))];
  const scored = modules.map((m) => {
    const lines = ctx.read(m.file).split('\n');
    const evidence = [];
    let score = 0;
    lines.forEach((line, i) => {
      const hits = tokens.filter((t) => new RegExp(`\\b${t}\\b`).test(line.toLowerCase()));
      if (hits.length) { score += hits.length; if (evidence.length < 4) evidence.push({ line: i + 1, text: line.trim(), matched: hits }); }
    });
    const routeHit = m.routes.some((r) => mentionedPaths.includes(r.path));
    return { file: m.file, score: score + (routeHit ? 10 : 0), routeHit, evidence };
  });
  const max = Math.max(...scored.map((s) => s.score), 1);
  const impacted = scored.filter((s) => s.routeHit || s.score >= 0.5 * max).sort((a, b) => b.score - a.score);
  const impactedFiles = impacted.map((i) => i.file);
  const dependents = [...new Set(edges.filter((e) => impactedFiles.includes(e.to)).map((e) => e.from))].filter((f) => !impactedFiles.includes(f));
  const unaffected = modules.map((m) => m.file).filter((f) => !impactedFiles.includes(f) && !dependents.includes(f));

  const md = `# Impact analysis\n\n## Module graph\n${mdTable(['Module', 'Imports', 'Exports', 'Routes'], modules.map((m) => [m.file, m.imports.join(', ') || '-', m.exports.join(', ') || '-', m.routes.map((r) => `${r.method} ${r.path}`).join(', ') || '-']))}\n\n## Impacted modules\n${impacted.map((i) => `### ${i.file} (score ${i.score}${i.routeHit ? ', owns a route named in the request' : ''})\n${i.evidence.map((e) => `- L${e.line}: \`${e.text}\` (${e.matched.join(', ')})`).join('\n')}`).join('\n\n')}\n\n## Blast radius\n- Direct change: ${impactedFiles.join(', ')}\n- Dependents to regression-check: ${dependents.join(', ') || 'none'}\n- Unaffected: ${unaffected.join(', ') || 'none'}\n- Existing tests: ${tests.join(', ')}\n`;
  return {
    output: { modules: modules.map(({ file, imports, exports }) => ({ file, imports, exports })), edges, routes, impacted: impacted.map(({ file, score, routeHit }) => ({ file, score, routeHit })), blastRadius: { direct: impactedFiles, dependents, unaffected, tests } },
    summary: `${modules.length} modules, ${routes.length} routes; impacted: ${impactedFiles.join(', ')}; dependents: ${dependents.join(', ') || 'none'}`,
    decisions: [{ decision: `Change is confined to ${impactedFiles.join(', ')}`, rationale: 'Route ownership + keyword evidence from the import graph' }],
    artifacts: [{ path: 'docs/IMPACT_ANALYSIS.md', content: md }],
  };
}

export async function analysisGate(result) {
  return result.output.impacted.length ? { ok: true, evidence: { impacted: result.output.impacted.length } } : { ok: false, reason: 'analysis found no impacted module; the request cannot be mapped to code' };
}

const REGRESSION_TEST = `import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../../src/app.js';

// Regression for FR-1 / FR-2 (change request: reject non-http(s) destination URLs).
const BAD = ['javascript:alert(1)', 'data:text/html,<script>alert(1)</script>', 'file:///etc/passwd', 'ftp://example.com/file', 'httpevil:foo'];
const GOOD = ['http://example.com/a', 'https://example.com/b?x=1'];

async function boot() {
  const server = createApp();
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return { base: 'http://127.0.0.1:' + server.address().port, close: () => new Promise((r) => { server.close(r); server.closeAllConnections(); }) };
}
const shorten = (base, url) => fetch(base + '/shorten', { method: 'POST', body: JSON.stringify({ url }) });

for (const bad of BAD) {
  test('FR-1 rejects ' + bad, async () => {
    const { base, close } = await boot();
    try {
      const res = await shorten(base, bad);
      assert.equal(res.status, 400);
      assert.match((await res.json()).error, /http/i);
    } finally {
      await close();
    }
  });
}

for (const good of GOOD) {
  test('FR-2 still accepts ' + good, async () => {
    const { base, close } = await boot();
    try {
      const res = await shorten(base, good);
      assert.equal(res.status, 201);
      const { code } = await res.json();
      const r = await fetch(base + '/' + code, { redirect: 'manual' });
      assert.equal(r.headers.get('location'), good);
    } finally {
      await close();
    }
  });
}
`;

/** Reproduce first: write the regression test and prove it FAILS on the unmodified code. */
export async function reproduceAgent() {
  return { output: { testFile: 'test/regression/url-scheme.test.js', cases: { bad: 5, good: 2 } }, summary: 'Regression test written (5 attack inputs, 2 valid inputs)', artifacts: [{ path: 'test/regression/url-scheme.test.js', content: REGRESSION_TEST }] };
}

export async function reproduceGate(result, view) {
  const r = view.exec('node', ['--test', result.output.testFile]);
  const s = parseNodeTestSummary(r.stdout);
  if (r.timedOut) return { ok: false, reason: 'regression test run timed out (hung server?)' };
  if (s.fail >= 1 && s.pass >= 1) return { ok: true, evidence: { reproduced: true, failing: s.fail, passing: s.pass } };
  return { ok: false, reason: s.fail === 0 ? 'bug NOT reproduced: regression test passes on unmodified code' : 'regression test is unsound: no valid-input case passes' };
}

export async function changePlanAgent(ctx) {
  const analysis = ctx.get('codebase-analysis');
  const repro = ctx.get('reproduce');
  const plan = {
    files: analysis.blastRadius.direct.map((f) => ({ path: f, action: 'modify', reason: 'owns the /shorten validation path' })).concat([{ path: 'src/validate.js', action: 'create (only if the inline strategy is insufficient)', reason: 'dedicated protocol allow-list' }]),
    strategies: [{ name: 'primary', description: 'Minimal inline guard in the handler: reject URLs that do not start with "http"' }, { name: 'fallback', description: 'Dedicated validator using the WHATWG URL parser and an explicit http/https allow-list' }],
    breakingChange: true,
    rollback: 'Revert the patch commit; no data migration involved.',
    validation: ['regression suite goes red -> green', 'existing suite stays green', 'blast radius check against impact analysis'],
    evidenceOfBug: repro.validation,
  };
  const md = `# Change plan\n\n## Files\n${mdTable(['Path', 'Action', 'Reason'], plan.files.map((f) => [f.path, f.action, f.reason]))}\n\n## Strategies\n${plan.strategies.map((s) => `- **${s.name}**: ${s.description}`).join('\n')}\n\n## Risk\n- Breaking behaviour: previously accepted non-http(s) inputs now return 400.\n- Rollback: ${plan.rollback}\n\n## Validation\n${plan.validation.map((v) => `- ${v}`).join('\n')}\n\nBug evidence: ${JSON.stringify(plan.evidenceOfBug)}\n`;
  return { output: { plan }, summary: `Breaking behaviour change touching ${analysis.blastRadius.direct.join(', ')}. Reproduced: ${JSON.stringify(repro.validation)}. Strategies: inline prefix check, then validator module as fallback.`, decisions: [{ decision: 'Plan: guard in handler first, validator module as fallback', rationale: 'Prefer the smallest change; escalate design only if validation proves it insufficient' }], artifacts: [{ path: 'docs/CHANGE_PLAN.md', content: md }] };
}

const GUARD_ANCHOR = "        if (!url) return json(res, 400, { error: 'url is required' });";

function patchResult(ctx, strategy, edits, extraFiles = []) {
  const path = 'src/app.js';
  const before = ctx.read(path);
  const after = applyEdits(before, edits);
  const files = [{ path, before, after }, ...extraFiles.map((f) => ({ path: f.path, before: null, after: f.content }))];
  const diffs = files.map((f) => diffLines(f.before, f.after, f.path));
  const changedLines = diffs.reduce((n, d) => n + d.changedLines, 0);
  return {
    output: { strategy, filesChanged: files.map((f) => f.path), changedLines, diff: diffs.map((d) => d.text).join('\n') },
    summary: `${strategy}: ${files.length} files, ${changedLines} lines changed`,
    change: { changedLines, files: files.map((f) => f.path) },
    artifacts: files.map((f) => ({ path: f.path, content: f.after })),
  };
}

/** Primary strategy: smallest possible inline guard. Intentionally naive: the regression suite is the judge. */
export async function patchInlineAgent(ctx) {
  return patchResult(ctx, 'inline-prefix-check', [{ find: GUARD_ANCHOR, replace: `${GUARD_ANCHOR}\n        if (!String(url).startsWith('http')) return json(res, 400, { error: 'only http and https URLs are allowed' });` }]);
}

const VALIDATOR = `const ALLOWED_PROTOCOLS = new Set(['http:', 'https:']);

/** Accepts only absolute http/https URLs. Returns the original (trimmed) string so stored data is unchanged. */
export function validateDestination(raw) {
  if (typeof raw !== 'string') return { ok: false, error: 'url must be a string' };
  const value = raw.trim();
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    return { ok: false, error: 'url is not a valid absolute URL; only http and https URLs are allowed' };
  }
  if (!ALLOWED_PROTOCOLS.has(parsed.protocol)) return { ok: false, error: 'only http and https URLs are allowed' };
  return { ok: true, url: value };
}
`;

const VALIDATOR_TEST = `import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateDestination } from '../src/validate.js';

test('accepts http and https only', () => {
  assert.equal(validateDestination('https://example.com/x').ok, true);
  assert.equal(validateDestination('http://example.com').url, 'http://example.com');
  for (const bad of ['javascript:alert(1)', 'data:text/plain,hi', 'file:///etc/passwd', 'httpevil:foo', 'example.com', '', 42]) {
    assert.equal(validateDestination(bad).ok, false, String(bad));
  }
});
`;

/** Fallback strategy: dedicated validator with a protocol allow-list. */
export async function patchValidatorAgent(ctx) {
  const edits = [
    { find: "import { MemoryStore } from './store.js';", replace: "import { MemoryStore } from './store.js';\nimport { validateDestination } from './validate.js';" },
    { find: GUARD_ANCHOR, replace: `${GUARD_ANCHOR}\n        const check = validateDestination(url);\n        if (!check.ok) return json(res, 400, { error: check.error });` },
  ];
  return patchResult(ctx, 'validator-module-allowlist', edits, [{ path: 'src/validate.js', content: VALIDATOR }, { path: 'test/validate.test.js', content: VALIDATOR_TEST }]);
}

function allTestFiles(view) {
  return view.list('test').filter((f) => f.endsWith('.test.js'));
}

/** Exit gate for the patch: the whole suite (existing + regression) must be green. */
export async function patchGate(result, view) {
  const r = view.exec('node', ['--test', ...allTestFiles(view)]);
  const s = parseNodeTestSummary(r.stdout);
  if (r.code !== 0 || s.fail > 0) {
    const firstFail = (r.stdout.match(/^not ok \d+ - (.+)$/m) ?? [])[1] ?? 'see audit';
    return { ok: false, reason: `${s.fail} failing tests after ${result.output.strategy} (first: ${firstFail})`, evidence: s };
  }
  return { ok: true, evidence: { tests: s.tests, pass: s.pass, fail: s.fail } };
}

/** Independent verification (parallel branch): full suite + blast radius vs. impact analysis. */
export async function verifyAgent(ctx) {
  const analysis = ctx.get('codebase-analysis');
  const patch = ctx.get('patch');
  const allowed = new Set([...analysis.blastRadius.direct]);
  const known = new Set(analysis.modules.map((m) => m.file));
  const outside = patch.filesChanged.filter((f) => !allowed.has(f) && !f.startsWith('test/') && known.has(f));
  const r = ctx.exec('node', ['--test', ...ctx.list('test').filter((f) => f.endsWith('.test.js'))]);
  const s = parseNodeTestSummary(r.stdout);
  const ok = r.code === 0 && s.fail === 0 && outside.length === 0;
  return { output: { ok, tests: s.tests, pass: s.pass, fail: s.fail, outsideBlastRadius: outside, strategy: patch.strategy }, summary: `${s.pass}/${s.tests} tests pass; ${outside.length} files outside blast radius`, artifacts: [] };
}

export async function verifyGate(result) {
  return result.output.ok ? { ok: true, evidence: { tests: result.output.tests, pass: result.output.pass } } : { ok: false, reason: `verification failed: fail=${result.output.fail}, outside blast radius=${result.output.outsideBlastRadius.join(',') || 'none'}` };
}

export async function changelogAgent(ctx) {
  const patch = ctx.get('patch');
  const md = `# Changelog\n\n## Unreleased - security fix\n- **FR-1** \`POST /shorten\` now rejects any destination that is not http or https (400). Strategy: ${patch.strategy}.\n- **FR-2** Valid http/https URLs behave exactly as before.\n\n### Behaviour change\nClients that stored \`javascript:\`, \`data:\`, \`file:\` or other schemes will now receive 400.\n\n### Rollback\nRevert the files: ${patch.filesChanged.join(', ')}. No data migration is involved.\n\n### Follow-up\nAudit previously stored links for non-http(s) destinations.\n`;
  return { output: { mentions: ['FR-1', 'FR-2'], hasRollback: true }, summary: 'Changelog with behaviour-change and rollback notes', artifacts: [{ path: 'CHANGELOG.md', content: md }] };
}

export async function changelogGate(result, view) {
  const md = view.read('CHANGELOG.md');
  return /FR-1/.test(md) && /Rollback/.test(md) ? { ok: true } : { ok: false, reason: 'changelog must reference FR-1 and include rollback notes' };
}

export async function securityRescanAgent(ctx) {
  const { files, findings } = securityScan(ctx, ['src']);
  const src = ctx.list('src').filter((f) => f.endsWith('.js')).map((f) => ctx.read(f)).join('\n');
  const checks = [
    { name: 'Policy rules clean', ok: findings.length === 0 },
    { name: 'Weak prefix check ("startsWith(\'http\')") not present', ok: !/startsWith\(['"]http['"]\)/.test(src) },
    { name: 'Explicit http/https protocol allow-list present', ok: /ALLOWED_PROTOCOLS|'http:'/.test(src) },
  ];
  return { output: { files, findings, checks }, summary: `${checks.filter((c) => c.ok).length}/${checks.length} checks pass`, artifacts: [{ path: 'docs/SECURITY_RESCAN.md', content: `# Security re-scan\n\n${mdTable(['Check', 'Result'], checks.map((c) => [c.name, c.ok ? 'PASS' : 'FAIL']))}\n` }] };
}

export async function brownfieldReleaseAgent(ctx) {
  const repro = ctx.get('reproduce');
  const verify = ctx.get('verify');
  const sec = ctx.get('security-rescan');
  const analysis = ctx.get('codebase-analysis');
  const planApproved = ctx.decisions().some((d) => d.nodeId === 'change-plan' && d.decision === 'approved');
  const checks = [
    { name: 'Bug reproduced on unmodified code (red)', ok: repro.validation?.reproduced === true, detail: JSON.stringify(repro.validation) },
    { name: 'Full suite green after patch (existing + regression)', ok: verify.ok, detail: `${verify.pass}/${verify.tests}` },
    { name: 'Change confined to analysed blast radius', ok: verify.outsideBlastRadius.length === 0, detail: `direct: ${analysis.blastRadius.direct.join(', ')}` },
    { name: 'Breaking-change plan was approved by a human before coding', ok: planApproved },
    { name: 'Security re-scan clean', ok: sec.checks.every((c) => c.ok) },
    { name: 'Changelog with rollback notes', ok: ctx.exists('CHANGELOG.md') },
  ];
  const verdict = checks.every((c) => c.ok) ? 'GO' : 'NO-GO';
  return { output: { verdict, checks }, summary: `${verdict}: ${checks.filter((c) => c.ok).length}/${checks.length} checks. Strategy used: ${verify.strategy}.`, artifacts: [{ path: 'docs/RELEASE_READINESS.md', content: `# Release readiness\n\n**Verdict: ${verdict}**\n\n${mdTable(['Check', 'Result', 'Detail'], checks.map((c) => [c.name, c.ok ? 'PASS' : 'FAIL', c.detail ?? '']))}\n` }] };
}
