import { mdTable, specOf, toYaml } from './common.js';

const has = (spec, c) => spec.capabilities.includes(c);

export function endpointsFor(spec) {
  const eps = [
    { id: 'create', method: 'POST', path: '/api/v1/links', auth: false, summary: 'Create a short link', rateLimited: has(spec, 'rateLimit'), responses: ['201', '400', '409', '413', '429'] },
    { id: 'redirect', method: 'GET', path: '/{code}', auth: false, summary: 'Redirect to the destination URL', responses: ['302', '404', '410'] },
    { id: 'metadata', method: 'GET', path: '/api/v1/links/{code}', auth: true, summary: 'Get link metadata', responses: ['200', '401', '403', '404'] },
    { id: 'delete', method: 'DELETE', path: '/api/v1/links/{code}', auth: true, summary: 'Delete a link', responses: ['204', '401', '403', '404'] },
    { id: 'health', method: 'GET', path: '/healthz', auth: false, summary: 'Liveness/readiness probe', responses: ['200'] },
    { id: 'metrics', method: 'GET', path: '/metrics', auth: false, summary: 'Operational counters', responses: ['200'] },
  ];
  if (has(spec, 'analytics')) eps.splice(3, 0, { id: 'analytics', method: 'GET', path: '/api/v1/links/{code}/analytics', auth: true, summary: 'Get per-link analytics', responses: ['200', '401', '403', '404'] });
  return eps;
}

export function decisionsFor(spec) {
  const d = [
    { id: 'ADR-001', title: 'Hexagonal storage port', status: 'accepted', context: 'Persistence technology is likely to change (file -> Redis/SQL).', decision: 'The app depends on an async store interface; MemoryStore and FileStore implement it.', alternatives: ['Bind directly to a database client', 'Single in-memory map only'], tradeoffs: 'Slight indirection; enables swapping storage without touching business logic and keeps tests hermetic.' },
    { id: 'ADR-002', title: 'HTTP 302 (not 301) for redirects', status: 'accepted', context: 'Analytics and expiry require every click to reach the service.', decision: 'Respond 302 with Cache-Control: private, max-age=0.', alternatives: ['301 permanent (cacheable, lower load)'], tradeoffs: 'Higher origin load; correct analytics and expiry semantics.' },
    { id: 'ADR-003', title: 'Random base62 codes instead of counters', status: 'accepted', context: 'Sequential codes allow enumeration of every stored URL.', decision: `Generate ${spec.config.codeLength}-character codes with crypto.randomInt and retry on collision (max 5).`, alternatives: ['Auto-increment id + base62', 'Hash of URL'], tradeoffs: 'Needs collision handling (62^n space makes it negligible); non-guessable; no coordination point for horizontal scale.' },
    { id: 'ADR-004', title: 'Aggregate analytics, no raw IP storage', status: 'accepted', context: 'Raw click events grow unbounded and contain personal data.', decision: 'Store counters (total, per day, per referrer host) and never persist client IPs.', alternatives: ['Append-only raw click log'], tradeoffs: 'No ad-hoc queries or unique-visitor counts; bounded storage and lower privacy risk.' },
    { id: 'ADR-005', title: 'Analytics is best-effort on the redirect path', status: 'accepted', context: 'Availability of redirects matters more than completeness of counters.', decision: 'Click recording errors are caught, counted and logged; the redirect still succeeds.', alternatives: ['Fail the redirect if analytics fails'], tradeoffs: 'Counters may under-count during incidents.' },
  ];
  if (has(spec, 'persistence')) d.push({ id: 'ADR-006', title: 'Atomic JSON file persistence for the reference store', status: 'accepted', context: 'Data must survive restarts with zero external dependencies.', decision: 'Write to a temp file and rename (atomic on POSIX).', alternatives: ['SQLite', 'Redis'], tradeoffs: 'Single-writer, O(n) rewrite per mutation: fine for a prototype, not for scale (see limitations).' });
  if (has(spec, 'rateLimit')) d.push({ id: 'ADR-007', title: 'In-process token bucket rate limiting', status: 'accepted', context: `Creation limited to ${spec.config.rateLimit.capacity} burst / ${spec.config.rateLimit.refillPerMinute} per minute per client.`, decision: 'Token bucket per client address with bounded key count (LRU eviction).', alternatives: ['Shared Redis limiter', 'API gateway limiter'], tradeoffs: 'Limits are per instance; a shared limiter is required once horizontally scaled.' });
  return d;
}

/** Architecture/design agent. */
export async function architectureAgent(ctx) {
  const spec = specOf(ctx);
  const endpoints = endpointsFor(spec);
  const decisions = decisionsFor(spec);
  const components = [
    { name: 'HTTP API (app.js)', responsibility: 'Routing, auth, error mapping, request limits' },
    { name: 'Validator (validator.js)', responsibility: 'URL/alias/TTL validation, SSRF-style host blocking' },
    { name: 'Code generator (shortcode.js)', responsibility: 'Unguessable base62 codes' },
    { name: 'Store port (store.js)', responsibility: 'Persistence + analytics aggregation behind an async interface' },
    ...(has(spec, 'rateLimit') ? [{ name: 'Rate limiter (ratelimiter.js)', responsibility: 'Per-client token bucket' }] : []),
  ];
  const md = [
    `# Architecture: ${spec.title}`, '', '## Components', mdTable(['Component', 'Responsibility'], components.map((c) => [c.name, c.responsibility])), '',
    '## Endpoints', mdTable(['Method', 'Path', 'Auth', 'Purpose'], endpoints.map((e) => [e.method, e.path, e.auth ? 'API key' : 'public', e.summary])), '',
    '## Request flow', '```mermaid', 'sequenceDiagram', '  participant C as Client', '  participant A as API', '  participant V as Validator', '  participant S as Store', '  C->>A: POST /api/v1/links', '  A->>V: validate url/alias/ttl', '  A->>S: create(code) [retry on collision]', '  A-->>C: 201 {code, shortUrl}', '  C->>A: GET /{code}', '  A->>S: get(code)', '  A->>S: recordClick (best effort)', '  A-->>C: 302 Location', '```', '',
    '## Key decisions', ...decisions.map((x) => `- **${x.id}** ${x.title}: ${x.decision}`),
  ].join('\n');
  const adrs = decisions.map((x) => ({ path: `docs/adr/${x.id}.md`, content: `# ${x.id}: ${x.title}\n\nStatus: ${x.status}\n\n## Context\n${x.context}\n\n## Decision\n${x.decision}\n\n## Alternatives considered\n${x.alternatives.map((a) => `- ${a}`).join('\n')}\n\n## Trade-offs\n${x.tradeoffs}\n` }));
  return {
    output: { spec, components, endpoints, decisions: decisions.map(({ id, title, decision, tradeoffs }) => ({ id, title, decision, tradeoffs })) },
    summary: `${components.length} components, ${endpoints.length} endpoints, ${decisions.length} ADRs`,
    decisions: [{ decision: `Design uses ${endpoints.length} endpoints and a storage port`, rationale: 'See ADR-001..' }],
    artifacts: [{ path: 'docs/ARCHITECTURE.md', content: `${md}\n` }, ...adrs],
  };
}

/** Risk assessment agent (runs in parallel with architecture). */
export async function riskAgent(ctx) {
  const spec = specOf(ctx);
  const risks = [
    { id: 'R-1', risk: 'Open redirect / XSS via non-http(s) schemes (javascript:, data:)', likelihood: 'high', impact: 'high', mitigation: 'Allow only http/https, reject credentials in URLs', validatedBy: 'test/service/validator.test.js' },
    { id: 'R-2', risk: 'SSRF-style abuse and internal link exposure via private/loopback hosts', likelihood: 'medium', impact: 'high', mitigation: 'Reject private, loopback, link-local and .internal hosts; reject self-referencing URLs', validatedBy: 'test/service/validator.test.js' },
    { id: 'R-3', risk: 'Enumeration of all stored URLs', likelihood: 'medium', impact: 'medium', mitigation: 'Cryptographically random codes (no counters)', validatedBy: 'test/service/units.test.js' },
    { id: 'R-4', risk: 'Analytics failure takes redirects down', likelihood: 'medium', impact: 'high', mitigation: 'Best-effort click recording with error isolation', validatedBy: 'test/service/api.test.js' },
  ];
  if (has(spec, 'rateLimit')) risks.push({ id: 'R-5', risk: 'Link-creation abuse / storage exhaustion', likelihood: 'high', impact: 'medium', mitigation: `Token bucket (${spec.config.rateLimit.capacity} burst), body size cap, bounded limiter memory`, validatedBy: 'test/service/units.test.js' });
  if (has(spec, 'persistence')) risks.push({ id: 'R-6', risk: 'Data corruption on crash during write', likelihood: 'low', impact: 'high', mitigation: 'Write temp file then atomic rename', validatedBy: 'test/service/units.test.js' });
  if (has(spec, 'auth')) risks.push({ id: 'R-7', risk: 'Unauthorized management (delete/analytics) access', likelihood: 'medium', impact: 'high', mitigation: 'API key with timing-safe compare; management disabled without a key; refuse to boot in production without one', validatedBy: 'test/service/api.test.js' });
  if (has(spec, 'expiry')) risks.push({ id: 'R-8', risk: 'Unbounded or invalid link lifetimes', likelihood: 'low', impact: 'low', mitigation: `ttlSeconds must be a positive integer <= ${spec.config.maxTtlSeconds}`, validatedBy: 'test/service/validator.test.js' });
  const residual = [
    'Single-instance rate limiting and file persistence do not scale horizontally.',
    'No per-user ownership model: any API-key holder can manage any link.',
    'No malware / phishing reputation check on destination URLs.',
  ];
  const md = `# Risk register\n\n${mdTable(['ID', 'Risk', 'Likelihood', 'Impact', 'Mitigation', 'Validated by'], risks.map((r) => [r.id, r.risk, r.likelihood, r.impact, r.mitigation, r.validatedBy]))}\n\n## Residual risks (accepted for the prototype)\n${residual.map((r) => `- ${r}`).join('\n')}\n`;
  return {
    output: { risks, residual },
    summary: `${risks.length} risks with mitigations and validating tests`,
    artifacts: [{ path: 'docs/RISKS.md', content: md }],
  };
}

/** OpenAPI contract agent. */
export async function apiSpecAgent(ctx) {
  const { spec, endpoints } = ctx.get('architecture');
  const err = { description: 'Error', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } };
  const desc = { 200: 'OK', 201: 'Created', 204: 'No content', 302: 'Redirect to destination', 400: 'Invalid input', 401: 'Missing or invalid API key', 403: 'Management disabled', 404: 'Not found', 409: 'Conflict', 410: 'Link expired', 413: 'Payload too large', 429: 'Rate limited' };
  const paths = {};
  for (const e of endpoints) {
    const op = { operationId: e.id, summary: e.summary, responses: {} };
    if (e.path.includes('{code}')) op.parameters = [{ name: 'code', in: 'path', required: true, schema: { type: 'string', pattern: '^[A-Za-z0-9_-]{3,32}$' } }];
    if (e.auth) op.security = [{ ApiKeyAuth: [] }];
    if (e.id === 'create') op.requestBody = { required: true, content: { 'application/json': { schema: { $ref: '#/components/schemas/CreateLinkRequest' } } } };
    for (const r of e.responses) {
      op.responses[r] = r === '201' ? { description: desc[r], content: { 'application/json': { schema: { $ref: '#/components/schemas/Link' } } } }
        : r === '200' && e.id === 'analytics' ? { description: desc[r], content: { 'application/json': { schema: { $ref: '#/components/schemas/Analytics' } } } }
        : r === '200' && e.id === 'metadata' ? { description: desc[r], content: { 'application/json': { schema: { $ref: '#/components/schemas/LinkMetadata' } } } }
        : r === '302' ? { description: desc[r], headers: { Location: { schema: { type: 'string', format: 'uri' } } } }
        : /^[45]/.test(r) ? { ...err, description: desc[r] } : { description: desc[r] };
    }
    (paths[e.path] ??= {})[e.method.toLowerCase()] = op;
  }
  const doc = {
    openapi: '3.0.3',
    info: { title: spec.title, version: '1.0.0', description: 'Generated by the agentic SDLC orchestrator from the approved design.' },
    paths,
    components: {
      securitySchemes: { ApiKeyAuth: { type: 'apiKey', in: 'header', name: 'X-API-Key' } },
      schemas: {
        CreateLinkRequest: { type: 'object', required: ['url'], properties: { url: { type: 'string', format: 'uri', maxLength: 2048 }, customAlias: { type: 'string', pattern: '^[A-Za-z0-9_-]{3,32}$' }, ttlSeconds: { type: 'integer', minimum: 1, maximum: spec.config.maxTtlSeconds } } },
        Link: { type: 'object', properties: { code: { type: 'string' }, shortUrl: { type: 'string', format: 'uri' }, originalUrl: { type: 'string', format: 'uri' }, createdAt: { type: 'string', format: 'date-time' }, expiresAt: { type: 'string', format: 'date-time', nullable: true } } },
        LinkMetadata: { type: 'object', properties: { code: { type: 'string' }, originalUrl: { type: 'string' }, createdAt: { type: 'string', format: 'date-time' }, expiresAt: { type: 'string', format: 'date-time', nullable: true } } },
        Analytics: { type: 'object', properties: { code: { type: 'string' }, totalClicks: { type: 'integer' }, lastClickAt: { type: 'string', format: 'date-time', nullable: true }, clicksByDay: { type: 'object', additionalProperties: { type: 'integer' } }, topReferrers: { type: 'array', items: { type: 'object', properties: { host: { type: 'string' }, clicks: { type: 'integer' } } } } } },
        Error: { type: 'object', properties: { error: { type: 'object', properties: { code: { type: 'string' }, message: { type: 'string' } } } } },
      },
    },
  };
  return {
    output: { endpointCount: endpoints.length, paths: Object.keys(paths).sort(), operations: endpoints.map((e) => `${e.method} ${e.path}`) },
    summary: `OpenAPI 3.0.3 contract with ${endpoints.length} operations`,
    artifacts: [{ path: 'openapi.yaml', content: `${toYaml(doc)}\n` }],
  };
}

/** Exit gate for api-spec: every designed operation is in the contract and the document is well-formed. */
export async function apiSpecGate(result, view) {
  const yaml = view.read('openapi.yaml');
  const missing = result.output.operations.filter((op) => {
    const [method, path] = op.split(' ');
    return !new RegExp(`^  ${path.replace(/[{}]/g, (c) => `\\${c}`)}:\\n(?:(?!^  \\S)[\\s\\S])*?^    ${method.toLowerCase()}:`, 'm').test(yaml);
  });
  if (missing.length) return { ok: false, reason: `operations missing from openapi.yaml: ${missing.join(', ')}` };
  if (!/^openapi: 3\.0\.3$/m.test(yaml) || /\t/.test(yaml)) return { ok: false, reason: 'openapi.yaml header/indentation invalid' };
  return { ok: true, evidence: { operations: result.output.operations.length } };
}
