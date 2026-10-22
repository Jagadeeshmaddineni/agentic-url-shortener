/**
 * Policy guardrails (security, compliance, change control).
 * A rule returns null (ok) or { severity, reason } where severity is:
 *   warn      - recorded only
 *   escalate  - forces human approval for the node
 *   block     - rejects the attempt (retry / fallback / rollback path)
 *   critical  - rejects and SAFE-STOPS the whole run
 */
const SECRET_PATTERNS = [
  /AKIA[0-9A-Z]{16}/,
  /-----BEGIN (RSA |EC |OPENSSH )?PRIVATE KEY-----/,
  /\b(password|passwd|secret|token)\s*[:=]\s*['"][^'"\s]{8,}['"]/i,
  /\bapi[_-]?key\s*[:=]\s*['"][A-Za-z0-9_\-]{16,}['"]/i,
];
const DANGEROUS_APIS = [/\beval\s*\(/, /new\s+Function\s*\(/, /child_process/, /\bvm\.run/, /require\(['"]fs['"]\)\.rm/];
const ALLOWED_EXT = new Set(['.js', '.json', '.md', '.yaml', '.yml', '.mmd', '.txt']);

export const DEFAULT_LIMITS = Object.freeze({
  maxArtifactBytes: 200_000,
  maxChangedLines: 40, // brownfield change-control budget before approval is forced
  allowedDependencies: [], // zero-dependency policy for generated packages
  allowedCommands: ['node'],
});

export class PolicyEngine {
  constructor(limits = {}) {
    this.limits = { ...DEFAULT_LIMITS, ...limits };
    this.rules = [
      { id: 'SEC-003', description: 'artifact paths must be relative, inside the workspace, with an allowed extension', applies: 'artifact', check: (a) => this.checkPath(a) },
      { id: 'SEC-001', description: 'no secrets or credentials in generated artifacts', applies: 'artifact', check: (a) => this.checkSecrets(a) },
      { id: 'SEC-002', description: 'no dynamic code execution or process spawning in generated source', applies: 'artifact', check: (a) => this.checkDangerous(a) },
      { id: 'CMP-001', description: 'only allow-listed dependencies in generated package.json', applies: 'artifact', check: (a) => this.checkDeps(a) },
      { id: 'CHG-001', description: 'artifact size cap', applies: 'artifact', check: (a) => this.checkSize(a) },
      { id: 'SEC-004', description: 'only allow-listed commands may be executed by agents', applies: 'command', check: (c) => this.checkCommand(c) },
      { id: 'CHG-003', description: 'large diffs require human approval (change budget)', applies: 'change', check: (c) => this.checkChangeBudget(c) },
    ];
  }

  checkPath({ path }) {
    if (typeof path !== 'string' || !path || path.startsWith('/') || /^[A-Za-z]:/.test(path) || path.split(/[\\/]/).includes('..')) {
      return { severity: 'critical', reason: `path traversal or absolute path attempt: ${path}` };
    }
    const ext = path.includes('.') ? path.slice(path.lastIndexOf('.')) : '';
    if (!ALLOWED_EXT.has(ext)) return { severity: 'block', reason: `file extension not allowed: ${path}` };
    return null;
  }

  checkSecrets({ content }) {
    const hit = SECRET_PATTERNS.find((p) => p.test(content));
    return hit ? { severity: 'critical', reason: `possible secret detected (${hit.source.slice(0, 30)}...)` } : null;
  }

  checkDangerous({ path, content }) {
    if (!/\.js$/.test(path)) return null;
    const hit = DANGEROUS_APIS.find((p) => p.test(content));
    return hit ? { severity: 'block', reason: `dangerous API in generated source (${hit.source})` } : null;
  }

  checkDeps({ path, content }) {
    if (!/(^|\/)package\.json$/.test(path)) return null;
    try {
      const pkg = JSON.parse(content);
      const deps = Object.keys({ ...(pkg.dependencies ?? {}), ...(pkg.devDependencies ?? {}) });
      const bad = deps.filter((d) => !this.limits.allowedDependencies.includes(d));
      return bad.length ? { severity: 'block', reason: `dependencies not on allow-list: ${bad.join(', ')}` } : null;
    } catch {
      return { severity: 'block', reason: 'package.json is not valid JSON' };
    }
  }

  checkSize({ content }) {
    return Buffer.byteLength(content) > this.limits.maxArtifactBytes ? { severity: 'block', reason: `artifact exceeds ${this.limits.maxArtifactBytes} bytes` } : null;
  }

  checkCommand({ command }) {
    return this.limits.allowedCommands.includes(command) ? null : { severity: 'critical', reason: `command not allow-listed: ${command}` };
  }

  checkChangeBudget({ changedLines }) {
    return changedLines > this.limits.maxChangedLines ? { severity: 'escalate', reason: `change touches ${changedLines} lines (budget ${this.limits.maxChangedLines})` } : null;
  }

  /** Evaluate every rule of a kind. Returns { allowed, escalate, critical, violations[] }. */
  evaluate(kind, subject) {
    const violations = [];
    for (const rule of this.rules.filter((r) => r.applies === kind)) {
      const v = rule.check(subject);
      if (v) violations.push({ rule: rule.id, description: rule.description, ...v });
    }
    return {
      allowed: !violations.some((v) => v.severity === 'block' || v.severity === 'critical'),
      escalate: violations.some((v) => v.severity === 'escalate'),
      critical: violations.some((v) => v.severity === 'critical'),
      violations,
    };
  }
}
