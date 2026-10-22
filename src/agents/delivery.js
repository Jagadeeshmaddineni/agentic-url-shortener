import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { PROJECT_ROOT, mdTable, securityScan, sha256, specOf } from './common.js';
import { parseNodeTestSummary } from '../orchestrator/sandbox.js';

const has = (spec, c) => spec.capabilities.includes(c);

function readTree(rootRel) {
  const root = join(PROJECT_ROOT, rootRel);
  const out = [];
  const walk = (dir) => {
    for (const name of readdirSync(dir)) {
      const p = join(dir, name);
      if (statSync(p).isDirectory()) walk(p); else out.push({ path: relative(PROJECT_ROOT, p).split(sep).join('/'), content: readFileSync(p, 'utf8') });
    }
  };
  walk(root);
  return out;
}

/**
 * Implementation agent. Materializes the reference service (src/service) into the run workspace and
 * generates the spec-derived configuration. Replace the template copy with an LLM code-generation
 * call and every artifact still passes through the same policy and gate checks.
 */
export async function implementationAgent(ctx) {
  const { spec, endpoints } = ctx.get('architecture');
  const sources = readTree('src/service').filter((f) => f.path !== 'src/service/spec-config.json');
  const specConfig = { codeLength: spec.config.codeLength, defaultTtlSeconds: spec.config.defaultTtlSeconds, maxTtlSeconds: spec.config.maxTtlSeconds, rateLimit: spec.config.rateLimit };
  const pkg = { name: 'url-shortener', version: '1.0.0', private: true, type: 'module', engines: { node: '>=20' }, scripts: { start: 'node src/service/server.js', test: 'node --test test/service/' } };
  return {
    output: { files: sources.map((f) => f.path).concat(['src/service/spec-config.json', 'package.json']).sort(), specConfig, endpointCount: endpoints.length },
    summary: `${sources.length} source modules + spec-derived config (${JSON.stringify(specConfig.rateLimit)})`,
    decisions: [{ decision: 'Spec-derived limits are injected via spec-config.json, not hard-coded', rationale: 'Requirement changes then re-generate configuration instead of editing code.' }],
    artifacts: [...sources, { path: 'src/service/spec-config.json', content: `${JSON.stringify(specConfig, null, 2)}\n` }, { path: 'package.json', content: `${JSON.stringify(pkg, null, 2)}\n` }],
  };
}

export async function implementationGate(result, view) {
  const missing = ['src/service/app.js', 'src/service/server.js', 'src/service/store.js', 'src/service/validator.js', 'package.json'].filter((f) => !view.exists(f));
  if (missing.length) return { ok: false, reason: `missing files: ${missing.join(', ')}` };
  const check = view.exec('node', ['--check', 'src/service/app.js']);
  return check.code === 0 ? { ok: true } : { ok: false, reason: `syntax check failed: ${check.stderr.slice(0, 200)}` };
}

/** Builds acceptance tests from the functional requirements (traceable: test titles carry FR ids). */
export function generateAcceptanceTests(spec) {
  const fr = (cap) => spec.functional.find((f) => f.capability === cap)?.id;
  const maxTtl = spec.config.maxTtlSeconds;
  const rl = spec.config.rateLimit;
  const blocks = [];
  blocks.push(`test('${fr('create')} create returns 201 with code and shortUrl, invalid URLs get 400', async () => {
  const { base, close } = await boot();
  const ok = await post(base, { url: 'https://example.com/a' });
  assert.equal(ok.status, 201);
  const body = await ok.json();
  assert.ok(body.code && body.shortUrl.endsWith('/' + body.code));
  for (const url of ['javascript:alert(1)', 'http://127.0.0.1/x', 'ftp://example.com']) assert.equal((await post(base, { url })).status, 400, url);
  await close();
});`);
  blocks.push(`test('${fr('redirect')} redirect answers 302 and unknown code answers 404', async () => {
  const { base, close } = await boot();
  const { code } = await (await post(base, { url: 'https://example.com/target' })).json();
  const r = await fetch(base + '/' + code, { redirect: 'manual' });
  assert.equal(r.status, 302);
  assert.equal(r.headers.get('location'), 'https://example.com/target');
  assert.equal((await fetch(base + '/missing1', { redirect: 'manual' })).status, 404);
  await close();
});`);
  if (has(spec, 'alias')) blocks.push(`test('${fr('alias')} custom alias is honoured, duplicates conflict, reserved names rejected', async () => {
  const { base, close } = await boot();
  assert.equal((await post(base, { url: 'https://example.com/1', customAlias: 'my-alias' })).status, 201);
  assert.equal((await post(base, { url: 'https://example.com/2', customAlias: 'my-alias' })).status, 409);
  assert.equal((await post(base, { url: 'https://example.com/3', customAlias: 'api' })).status, 400);
  await close();
});`);
  if (has(spec, 'expiry')) blocks.push(`test('${fr('expiry')} expiry yields 410 and ttl above the maximum (${maxTtl}s) is rejected', async () => {
  const clock = { t: 1_700_000_000_000 };
  const { base, close } = await boot({ now: () => clock.t });
  const { code } = await (await post(base, { url: 'https://example.com/ttl', ttlSeconds: 60 })).json();
  assert.equal((await fetch(base + '/' + code, { redirect: 'manual' })).status, 302);
  clock.t += 61_000;
  assert.equal((await fetch(base + '/' + code, { redirect: 'manual' })).status, 410);
  assert.equal((await post(base, { url: 'https://example.com/x', ttlSeconds: ${maxTtl} + 1 })).status, 400);
  await close();
});`);
  if (has(spec, 'analytics')) blocks.push(`test('${fr('analytics')} analytics count clicks and a failing store never breaks the redirect', async () => {
  const { base, close, store } = await boot();
  const { code } = await (await post(base, { url: 'https://example.com/an' })).json();
  for (const ref of ['https://a.test/x', 'https://a.test/y', undefined]) await fetch(base + '/' + code, { redirect: 'manual', headers: ref ? { referer: ref } : {} });
  const res = await fetch(base + '/api/v1/links/' + code + '/analytics', { headers: { 'x-api-key': KEY } });
  const a = await res.json();
  assert.equal(a.totalClicks, 3);
  assert.deepEqual(a.topReferrers[0], { host: 'a.test', clicks: 2 });
  store.recordClick = async () => { throw new Error('store down'); };
  assert.equal((await fetch(base + '/' + code, { redirect: 'manual' })).status, 302);
  await close();
});`);
  if (has(spec, 'rateLimit')) blocks.push(`test('${fr('rateLimit')} creation is limited to ${rl.capacity} per window and answers 429 with Retry-After', async () => {
  const { base, close } = await boot({ limiter: new RateLimiter({ capacity: ${rl.capacity}, refillPerSecond: ${rl.refillPerMinute} / 60 }) });
  for (let i = 0; i < ${rl.capacity}; i += 1) assert.equal((await post(base, { url: 'https://example.com/' + i })).status, 201);
  const limited = await post(base, { url: 'https://example.com/over' });
  assert.equal(limited.status, 429);
  assert.ok(Number(limited.headers.get('retry-after')) > 0);
  await close();
});`);
  if (has(spec, 'persistence')) blocks.push(`test('${fr('persistence')} data survives a restart (file store reload)', async () => {
  const file = join(mkdtempSync(join(tmpdir(), 'acc-')), 'data.json');
  const first = await boot({ store: new FileStore(file) });
  const { code } = await (await post(first.base, { url: 'https://example.com/persist' })).json();
  await first.close();
  const second = await boot({ store: new FileStore(file) });
  assert.equal((await fetch(second.base + '/' + code, { redirect: 'manual' })).status, 302);
  await second.close();
});`);
  if (has(spec, 'auth')) blocks.push(`test('${fr('auth')} management requires X-API-Key and is disabled without a key', async () => {
  const { base, close } = await boot();
  const { code } = await (await post(base, { url: 'https://example.com/auth' })).json();
  assert.equal((await fetch(base + '/api/v1/links/' + code, { method: 'DELETE' })).status, 401);
  assert.equal((await fetch(base + '/api/v1/links/' + code, { method: 'DELETE', headers: { 'x-api-key': KEY } })).status, 204);
  await close();
  const open = await boot({ apiKey: null });
  assert.equal((await fetch(open.base + '/api/v1/links/abc', { headers: { 'x-api-key': 'x' } })).status, 403);
  await open.close();
});`);
  const header = `// GENERATED by the agentic orchestrator from the approved requirements. Do not edit by hand.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../../src/service/app.js';
import { MemoryStore, FileStore } from '../../src/service/store.js';
import { RateLimiter } from '../../src/service/ratelimiter.js';
import { loadSpecConfig } from '../../src/service/defaults.js';

const KEY = 'acceptance-key';
async function boot({ store = new MemoryStore(), limiter, now, apiKey = KEY } = {}) {
  const config = loadSpecConfig();
  const server = createServer(createApp({ store, baseUrl: 'http://short.test', apiKey: apiKey ?? undefined, rateLimiter: limiter, now, config }));
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return { base: 'http://127.0.0.1:' + server.address().port, store, close: () => new Promise((r) => server.close(r)) };
}
const post = (base, body) => fetch(base + '/api/v1/links', { method: 'POST', body: JSON.stringify(body) });
`;
  return `${header}\n${blocks.join('\n\n')}\n`;
}

/** Test agent: copies the hand-written suites and generates requirement-traced acceptance tests. */
export async function testAgent(ctx) {
  const { spec } = ctx.get('architecture');
  const suites = readTree('test/service').filter((f) => f.path.endsWith('.test.js'));
  const acceptance = generateAcceptanceTests(spec);
  const coverage = Object.fromEntries(spec.functional.map((f) => [f.id, acceptance.includes(`test('${f.id} `) ? [`acceptance.generated.test.js: ${f.id}`] : []]));
  return {
    output: { suites: suites.map((s) => s.path).sort(), coverage },
    summary: `${suites.length} hand-written suites + ${Object.values(coverage).filter((c) => c.length).length}/${spec.functional.length} requirements covered by generated acceptance tests`,
    artifacts: [...suites, { path: 'test/service/acceptance.generated.test.js', content: acceptance }],
  };
}

/** Exit gate = validation: actually run the generated suite inside the workspace. */
export async function testGate(result, view) {
  const files = view.list('test/service').filter((f) => f.endsWith('.test.js'));
  const r = view.exec('node', ['--test', ...files], { timeoutMs: 120_000 });
  const s = parseNodeTestSummary(r.stdout);
  const uncovered = Object.entries(result.output.coverage).filter(([, c]) => !c.length).map(([id]) => id);
  if (uncovered.length) return { ok: false, reason: `requirements without acceptance tests: ${uncovered.join(', ')}` };
  if (r.code !== 0 || s.fail > 0 || s.tests === 0) return { ok: false, reason: `test suite failed: ${s.fail} failing of ${s.tests}`, evidence: s };
  return { ok: true, evidence: { tests: s.tests, pass: s.pass, fail: s.fail } };
}

export async function docsAgent(ctx) {
  const { spec, endpoints } = ctx.get('architecture');
  const cfg = spec.config;
  const readme = `# ${spec.title}

Zero-dependency Node.js (>=20) URL shortener. Generated, tested and released through the agentic SDLC orchestrator.

## Run
\`\`\`bash
npm start                                  # PORT=3000, in-memory store, dev API key (insecure)
DATA_FILE=./data.json API_KEY=change-me PORT=8080 npm start
NODE_ENV=production API_KEY=... npm start  # refuses to boot without API_KEY
npm test
\`\`\`

## API (see openapi.yaml)
${mdTable(['Method', 'Path', 'Auth', 'Purpose'], endpoints.map((e) => [e.method, `\`${e.path}\``, e.auth ? 'X-API-Key' : 'public', e.summary]))}

\`\`\`bash
curl -s -X POST localhost:3000/api/v1/links -d '{"url":"https://example.com/docs"${has(spec, 'alias') ? ',"customAlias":"docs"' : ''}${has(spec, 'expiry') ? ',"ttlSeconds":3600' : ''}}'
curl -si localhost:3000/<code>
${has(spec, 'analytics') ? "curl -s localhost:3000/api/v1/links/<code>/analytics -H 'X-API-Key: dev-key'" : ''}
\`\`\`

## Configuration
| Setting | Value | Source |
| --- | --- | --- |
| Code length | ${cfg.codeLength} | requirements |
| Default TTL | ${cfg.defaultTtlSeconds ? `${cfg.defaultTtlSeconds / 86400} days` : 'none (links do not expire unless ttlSeconds is given)'} | requirements |
| Max TTL | ${cfg.maxTtlSeconds / 86400} days | requirements |
| Creation rate limit | ${cfg.rateLimit.capacity} burst, ${cfg.rateLimit.refillPerMinute}/min per client | requirements |
${cfg.latencyP99Ms ? `| Redirect p99 target | ${cfg.latencyP99Ms} ms | requirements (not load-tested) |\n` : ''}Environment: \`PORT\`, \`BASE_URL\`, \`DATA_FILE\`, \`API_KEY\`, \`NODE_ENV\`.

## Operations
- \`GET /healthz\` for probes, \`GET /metrics\` for counters (requests, redirects, 404/410, rate-limited, analytics failures).
- Logs are JSON lines; client IPs are never stored.
- Shut down with SIGTERM for a graceful drain.

## Known limitations
See docs/RISKS.md (residual risks) and docs/ENGINEERING_SUMMARY.md.
`;
  return { output: { sections: ['Run', 'API', 'Configuration', 'Operations'], endpoints: endpoints.map((e) => e.path) }, summary: 'README with run instructions, API table, configuration and operations', artifacts: [{ path: 'README.md', content: readme }] };
}

export async function docsGate(result, view) {
  const readme = view.read('README.md');
  const missing = result.output.endpoints.filter((p) => !readme.includes(p));
  return missing.length ? { ok: false, reason: `README does not document: ${missing.join(', ')}` } : { ok: true };
}

export async function securityScanAgent(ctx) {
  const { files, findings } = securityScan(ctx, ['src']);
  const src = ctx.list('src/service').filter((f) => f.endsWith('app.js')).map((f) => ctx.read(f)).join('\n');
  const guarded = (src.match(/requireApiKey\(req\)/g) ?? []).length;
  const checks = [
    { name: 'Policy rules clean (secrets, dangerous APIs, deps)', ok: findings.length === 0 },
    { name: 'Management routes guarded by API key', ok: guarded >= 1 },
    { name: 'Timing-safe API key comparison', ok: /timingSafeEqual/.test(src) },
    { name: 'Request body size limit enforced', ok: /payload_too_large/.test(src) },
    { name: 'Errors never leak stack traces', ok: !/err\.stack/.test(src) },
  ];
  const md = `# Security scan\n\nScanned ${files} files.\n\n${mdTable(['Check', 'Result'], checks.map((c) => [c.name, c.ok ? 'PASS' : 'FAIL']))}\n${findings.length ? `\n## Findings\n${findings.map((f) => `- ${f.rule} ${f.path}: ${f.reason}`).join('\n')}\n` : ''}`;
  return { output: { files, findings, checks }, summary: `${checks.filter((c) => c.ok).length}/${checks.length} checks pass`, artifacts: [{ path: 'docs/SECURITY_SCAN.md', content: md }] };
}

export async function securityGate(result) {
  const failed = result.output.checks.filter((c) => !c.ok);
  return failed.length ? { ok: false, reason: `security checks failed: ${failed.map((c) => c.name).join('; ')}` } : { ok: true };
}

export async function releaseReadinessAgent(ctx) {
  const spec = specOf(ctx);
  const tests = ctx.get('unit-tests');
  const sec = ctx.get('security-scan');
  const risks = ctx.get('risk').risks;
  const apiSpec = ctx.get('api-spec');
  const checks = [
    { name: 'Every functional requirement has an acceptance test', ok: Object.values(tests.coverage).every((c) => c.length) },
    { name: 'Full test suite green', ok: tests.validation?.fail === 0 && tests.validation?.tests > 0, detail: tests.validation ? `${tests.validation.pass}/${tests.validation.tests} passed` : 'no evidence' },
    { name: 'Security scan clean', ok: sec.checks.every((c) => c.ok) },
    { name: 'Every risk has a mitigation validated by an existing test file', ok: risks.every((r) => r.mitigation && tests.suites.includes(r.validatedBy)) },
    { name: 'OpenAPI contract covers every designed operation', ok: apiSpec.endpointCount === apiSpec.operations.length },
    { name: 'No unresolved blocking ambiguity', ok: spec.ambiguities.filter((a) => a.blocking).length === 0 },
    { name: 'Documentation present (README, architecture, risks)', ok: ['README.md', 'docs/ARCHITECTURE.md', 'docs/RISKS.md'].every((f) => ctx.exists(f)) },
  ];
  const verdict = checks.every((c) => c.ok) ? 'GO' : 'NO-GO';
  const md = `# Release readiness\n\n**Verdict: ${verdict}**\n\n${mdTable(['Check', 'Result', 'Detail'], checks.map((c) => [c.name, c.ok ? 'PASS' : 'FAIL', c.detail ?? '']))}\n\nA human reviewer must approve this release (high-impact checkpoint).\n`;
  return { output: { verdict, checks }, summary: `${verdict}: ${checks.filter((c) => c.ok).length}/${checks.length} release checks pass`, artifacts: [{ path: 'docs/RELEASE_READINESS.md', content: md }] };
}

export async function releaseGate(result) {
  return result.output.verdict === 'GO' ? { ok: true } : { ok: false, reason: `release verdict ${result.output.verdict}: ${result.output.checks.filter((c) => !c.ok).map((c) => c.name).join('; ')}` };
}

export { sha256 };
