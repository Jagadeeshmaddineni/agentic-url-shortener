/**
 * Requirement-understanding agents.
 * The default implementation is deterministic and rule-based (offline, reproducible, auditable).
 * It is a drop-in seam: replace `interpret()` with an LLM call and keep the same output contract and gates.
 */
const DAY = 86400;

const CAPABILITIES = [
  { id: 'create', test: /short|shorten|create (a )?(short )?link/, fr: 'Clients can create a short link for a destination URL through a REST API.', acceptance: ['POST /api/v1/links with a valid http(s) url returns 201 with code and shortUrl', 'invalid, non-http(s), private-host or self-referencing URLs are rejected with 400'] },
  { id: 'redirect', test: /short|redirect|resolve/, fr: 'Visiting a short link redirects to the destination URL with HTTP 302.', acceptance: ['GET /{code} returns 302 with Location set to the destination', 'unknown codes return 404'] },
  { id: 'alias', test: /alias|vanity|custom (short )?(code|name)/, fr: 'Creators may choose a custom alias for a link.', acceptance: ['a valid customAlias becomes the code', 'a duplicate customAlias returns 409', 'reserved or malformed aliases return 400'] },
  { id: 'expiry', test: /expir|ttl|time[- ]limited|not live forever|temporary|short[- ]lived/, fr: 'Links can expire; expired links stop redirecting.', acceptance: ['ttlSeconds sets an expiry time', 'expired links return 410', 'ttlSeconds above the configured maximum is rejected with 400'] },
  { id: 'analytics', test: /analytic|click|statistic|stats|referrer|how (?:their |the |my )?(?:they|links?|it)(?:'re| are| is) doing|insight/, fr: 'Link owners can see per-link analytics.', acceptance: ['analytics report total clicks, clicks per day and top referrers', 'an analytics failure never breaks the redirect'] },
  { id: 'rateLimit', test: /rate[- ]?limit|throttl|per (minute|second|hour)|abuse/, fr: 'Link creation is rate limited per client.', acceptance: ['requests above the limit return 429 with a Retry-After header'] },
  { id: 'persistence', test: /persist|durab|surviv|restart|storage|database|file/, fr: 'Links and analytics survive a service restart.', acceptance: ['data written before a restart is available after it', 'writes are atomic (no partially written data file)'] },
  { id: 'auth', test: /api[- ]key|authenticat|protected|authori[sz]/, fr: 'Management endpoints (analytics, metadata, delete) require an API key.', acceptance: ['management endpoints return 401 without a valid X-API-Key', 'management is disabled (403) when no key is configured'] },
];

const VAGUE = [
  { id: 'AMB-1', key: 'expiry', term: 'not live forever', test: (t) => /(not live forever|temporary|short[- ]lived|time[- ]limited)/.test(t) && !/\d+\s*(second|minute|hour|day)/.test(t), question: 'What default lifetime (in days) should links have?', proposedDefault: '30', blocking: true },
  { id: 'AMB-2', key: 'analytics', term: 'see how links are doing', test: (t) => /(how (?:their |the |my )?(?:they|links?|it)(?:'re| are| is) doing|see (the )?performance|insights|know if (it|they) work)/.test(t) && !/click|referrer/.test(t), question: 'Which analytics are required (e.g. total clicks, clicks per day, top referrers)?', proposedDefault: 'total clicks, clicks per day, top referrers', blocking: true },
  { id: 'AMB-3', key: 'latency', term: 'fast', test: (t) => /\b(fast|quick|low latency|snappy)\b/.test(t) && !/\d+\s*ms/.test(t), question: 'What is the redirect latency target (p99, in ms)?', proposedDefault: '50', blocking: false },
  { id: 'AMB-4', key: 'security', term: 'safe', test: (t) => /\b(safe|secure|safely|trustworthy)\b/.test(t) && !/api[- ]key|rate[- ]?limit/.test(t), question: 'Which abuse/security controls are in scope (url validation, rate limiting, api key for management)?', proposedDefault: 'url validation, rate limiting, api key', blocking: true },
  { id: 'AMB-5', key: 'scale', term: 'scalable', test: (t) => /\b(scalable|scale|lots of|millions)\b/.test(t) && !/\d+\s*(rps|req|requests)/.test(t), question: 'What peak redirect traffic (requests/second) must be supported?', proposedDefault: '500', blocking: false },
];

const UNIT = { second: 1, sec: 1, minute: 60, min: 60, hour: 3600, day: DAY };
const unitSeconds = (u) => UNIT[u.replace(/s$/, '')] ?? 1;

export function interpret(text) {
  const t = text.toLowerCase();
  const config = { codeLength: 7, defaultTtlSeconds: null, maxTtlSeconds: 365 * DAY, rateLimit: { capacity: 10, refillPerMinute: 10 }, latencyP99Ms: null, targetRps: null };
  const assumptions = [];

  const rate = t.match(/(\d+)\s*(?:creates?|requests?|links?|creations?)?(?: creation)?\s*(?:per|\/|a)\s*(minute|min|second|sec|hour)/);
  if (rate) {
    const n = Number(rate[1]);
    config.rateLimit = { capacity: n, refillPerMinute: +(n * (60 / unitSeconds(rate[2]))).toFixed(3) };
  }
  const maxTtl = t.match(/(?:up to|max(?:imum)?(?: of)?|at most)\s*(\d+)\s*(seconds?|minutes?|hours?|days?)/);
  if (maxTtl) config.maxTtlSeconds = Number(maxTtl[1]) * unitSeconds(maxTtl[2]);
  const defTtl = t.match(/default(?: expiry| ttl| lifetime)?(?: of)?\s*(\d+)\s*(days?|hours?)/);
  if (defTtl) config.defaultTtlSeconds = Number(defTtl[1]) * unitSeconds(defTtl[2]);
  const len = t.match(/(\d+)[- ]char/);
  if (len) config.codeLength = Number(len[1]);
  const lat = t.match(/(\d+)\s*ms/);
  if (lat) config.latencyP99Ms = Number(lat[1]);

  let capabilities = CAPABILITIES.filter((c) => c.test.test(t)).map((c) => c.id);
  const ambiguities = VAGUE.filter((v) => v.test(t)).map(({ test, ...rest }) => rest);
  if (!capabilities.includes('auth') && !ambiguities.some((a) => a.key === 'security')) {
    capabilities.push('auth');
    assumptions.push({ id: 'ASM-1', text: 'Management endpoints are protected by an API key (not stated; chosen as the secure default).' });
  }
  if (!capabilities.includes('rateLimit') && !ambiguities.some((a) => a.key === 'security')) { capabilities.push('rateLimit'); assumptions.push({ id: 'ASM-2', text: 'Link creation is rate limited at 10/min per client (not stated; abuse-prevention default).' }); }
  capabilities = CAPABILITIES.map((c) => c.id).filter((id) => capabilities.includes(id));

  return { title: 'URL shortener service', kind: 'greenfield', intent: text.trim(), capabilities, config, ambiguities, assumptions };
}

export function buildFunctional(capabilities) {
  return CAPABILITIES.filter((c) => capabilities.includes(c.id)).map((c, i) => ({ id: `FR-${i + 1}`, capability: c.id, text: c.fr, acceptance: c.acceptance }));
}

export function buildNonFunctional(config) {
  const nfr = [
    { id: 'NFR-1', text: 'Only http/https destinations on public hosts are accepted (open-redirect and SSRF-style abuse prevention).' },
    { id: 'NFR-2', text: 'No third-party runtime dependencies; no secrets in source or logs.' },
    { id: 'NFR-3', text: 'Redirects stay available when analytics or persistence of a click fails.' },
  ];
  if (config.latencyP99Ms) nfr.push({ id: `NFR-${nfr.length + 1}`, text: `Redirect p99 latency <= ${config.latencyP99Ms} ms.` });
  if (config.targetRps) nfr.push({ id: `NFR-${nfr.length + 1}`, text: `Sustain ${config.targetRps} redirects/second per instance.` });
  return nfr;
}

/** Greenfield / ambiguous requirements agent. */
export async function requirementsAgent(ctx) {
  const spec = interpret(ctx.requirement);
  spec.functional = buildFunctional(spec.capabilities);
  spec.nonFunctional = buildNonFunctional(spec.config);
  const blocking = spec.ambiguities.filter((a) => a.blocking);
  const out = {
    output: { spec },
    summary: `${spec.functional.length} functional requirements, ${spec.ambiguities.length} ambiguities (${blocking.length} blocking), ${spec.assumptions.length} assumptions`,
    decisions: [{ decision: `Normalized request into ${spec.functional.length} functional requirements`, rationale: `Capabilities detected: ${spec.capabilities.join(', ')}` }],
    artifacts: [{ path: 'docs/REQUIREMENTS.md', content: renderRequirements(spec) }],
  };
  if (blocking.length) {
    out.replan = {
      reason: `Blocking ambiguities (${blocking.map((a) => a.id).join(', ')}) change the API contract; human clarification is required before design.`,
      insert: [{ id: 'clarify', stage: 'requirements', agent: 'clarify', deps: ['requirements'], impact: 'medium', exitGate: clarifyGate }],
      before: ['architecture', 'risk'],
    };
  }
  return out;
}

function clarifyGate(result) {
  const left = (result.output.spec.ambiguities ?? []).filter((a) => a.blocking);
  return left.length ? { ok: false, reason: `unresolved blocking ambiguities: ${left.map((a) => a.id).join(', ')}` } : { ok: true };
}

/** Applies stakeholder answers to the interpreted spec. Pure: used by the clarify agent and by mid-run revisions. */
export function resolveSpec(base, answers, usedDefaults = []) {
  const spec = structuredClone(base);
  const caps = new Set(spec.capabilities);
  const decisions = [];
  for (const a of base.ambiguities) {
    const v = String(answers[a.id] ?? a.proposedDefault).trim();
    if (a.key === 'expiry') {
      const days = Math.max(1, parseInt(v, 10) || 30);
      spec.config.defaultTtlSeconds = days * DAY;
      caps.add('expiry');
      decisions.push({ decision: `${a.id}: default link lifetime = ${days} days`, rationale: a.question });
    } else if (a.key === 'analytics') {
      caps.add('analytics');
      decisions.push({ decision: `${a.id}: analytics scope = ${v}`, rationale: a.question });
    } else if (a.key === 'latency') {
      spec.config.latencyP99Ms = parseInt(v, 10) || 50;
      decisions.push({ decision: `${a.id}: redirect p99 target = ${spec.config.latencyP99Ms} ms`, rationale: a.question });
    } else if (a.key === 'security') {
      caps.add('auth');
      if (/rate/.test(v) || /default|all/.test(v)) caps.add('rateLimit');
      decisions.push({ decision: `${a.id}: security scope = ${v}`, rationale: a.question });
    } else if (a.key === 'scale') {
      spec.config.targetRps = parseInt(v, 10) || 500;
      decisions.push({ decision: `${a.id}: target ${spec.config.targetRps} rps`, rationale: a.question });
    }
    if (usedDefaults.includes(a.id)) spec.assumptions.push({ id: `ASM-${a.id}`, text: `${a.id} was not answered by a stakeholder; default "${a.proposedDefault}" applied and needs confirmation.` });
  }
  spec.capabilities = CAPABILITIES.map((c) => c.id).filter((id) => caps.has(id));
  spec.functional = buildFunctional(spec.capabilities);
  spec.nonFunctional = buildNonFunctional(spec.config);
  spec.ambiguities = [];
  spec.resolvedFrom = base.ambiguities.map((a) => ({ id: a.id, answer: String(answers[a.id] ?? a.proposedDefault) }));
  return { spec, decisions };
}

export async function clarifyAgent(ctx) {
  const base = ctx.get('requirements').spec;
  const { answers, usedDefaults = [], reviewer, mode } = await ctx.ask(base.ambiguities.map(({ id, question, proposedDefault }) => ({ id, question, proposedDefault })));
  const { spec, decisions } = resolveSpec(base, answers, usedDefaults);
  return {
    output: { spec, answers, usedDefaults, answeredBy: `${reviewer} [${mode}]` },
    summary: `Resolved ${base.ambiguities.length} ambiguities (${usedDefaults.length} via defaults)`,
    decisions,
    artifacts: [{ path: 'docs/REQUIREMENTS.md', content: renderRequirements(spec) }],
  };
}

export function renderRequirements(spec) {
  const lines = [`# Requirements: ${spec.title}`, '', `> Normalized from: "${spec.intent}"`, '', '## Functional requirements'];
  for (const f of spec.functional) lines.push('', `### ${f.id} (${f.capability})`, f.text, '', ...f.acceptance.map((a) => `- [ ] ${a}`));
  lines.push('', '## Non-functional requirements', ...spec.nonFunctional.map((n) => `- **${n.id}** ${n.text}`));
  lines.push('', '## Configuration derived from the request', '```json', JSON.stringify(spec.config, null, 2), '```');
  if (spec.ambiguities.length) lines.push('', '## Open ambiguities', ...spec.ambiguities.map((a) => `- **${a.id}** "${a.term}": ${a.question} (default: ${a.proposedDefault}; ${a.blocking ? 'blocking' : 'non-blocking'})`));
  if (spec.assumptions.length) lines.push('', '## Assumptions', ...spec.assumptions.map((a) => `- ${a.id}: ${a.text}`));
  if (spec.resolvedFrom) lines.push('', '## Clarifications applied', ...spec.resolvedFrom.map((r) => `- ${r.id} => ${r.answer}`));
  return `${lines.join('\n')}\n`;
}
