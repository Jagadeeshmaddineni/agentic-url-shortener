import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { createHash } from 'node:crypto';
import { PolicyEngine } from '../orchestrator/policy.js';

export const PROJECT_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
export const sha256 = (s) => createHash('sha256').update(s).digest('hex');

/** Resolved spec: clarified answers (if the workflow was re-planned) take precedence over the raw interpretation. */
export function specOf(ctx) {
  return ctx.has('clarify') ? ctx.get('clarify').spec : ctx.get('requirements').spec;
}

export function applyEdits(content, edits) {
  let out = content;
  for (const { find, replace } of edits) {
    const first = out.indexOf(find);
    if (first === -1) throw new Error(`edit target not found: ${find.slice(0, 50)}`);
    if (out.indexOf(find, first + 1) !== -1) throw new Error(`edit target is ambiguous (multiple matches): ${find.slice(0, 50)}`);
    out = out.replace(find, () => replace);
  }
  return out;
}

/** Line diff via LCS (files here are small). Returns { text, added, removed, changedLines }. */
export function diffLines(before, after, name = 'file') {
  const a = before === null ? [] : before.split('\n');
  const b = after.split('\n');
  const dp = Array.from({ length: a.length + 1 }, () => new Array(b.length + 1).fill(0));
  for (let i = a.length - 1; i >= 0; i -= 1) for (let j = b.length - 1; j >= 0; j -= 1) dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
  const lines = [`--- ${before === null ? '/dev/null' : `a/${name}`}`, `+++ b/${name}`];
  let i = 0; let j = 0; let added = 0; let removed = 0;
  while (i < a.length || j < b.length) {
    if (i < a.length && j < b.length && a[i] === b[j]) { i += 1; j += 1; } else if (j < b.length && (i === a.length || dp[i][j + 1] >= dp[i + 1][j])) { lines.push(`+${b[j]}`); added += 1; j += 1; } else { lines.push(`-${a[i]}`); removed += 1; i += 1; }
  }
  return { text: lines.join('\n'), added, removed, changedLines: added + removed };
}

export function mdTable(headers, rows) {
  const esc = (v) => String(v ?? '').replace(/\|/g, '\\|').replace(/\n/g, ' ');
  return [`| ${headers.join(' | ')} |`, `| ${headers.map(() => '---').join(' | ')} |`, ...rows.map((r) => `| ${r.map(esc).join(' | ')} |`)].join('\n');
}

/** Minimal deterministic YAML emitter (enough for OpenAPI documents). */
export function toYaml(value, indent = 0) {
  const pad = '  '.repeat(indent);
  const scalar = (v) => {
    if (v === null) return 'null';
    if (typeof v === 'number' || typeof v === 'boolean') return String(v);
    const s = String(v);
    return /^[A-Za-z0-9_./{}-][A-Za-z0-9_ ./{}()-]*$/.test(s) && !/^(true|false|null|yes|no|\d+)$/i.test(s) && !s.endsWith(' ') ? s : JSON.stringify(s);
  };
  if (Array.isArray(value)) {
    if (!value.length) return `${pad}[]`;
    return value.map((v) => (typeof v === 'object' && v !== null ? `${pad}-\n${toYaml(v, indent + 1)}` : `${pad}- ${scalar(v)}`)).join('\n');
  }
  if (value && typeof value === 'object') {
    const keys = Object.keys(value);
    if (!keys.length) return `${pad}{}`;
    return keys.map((k) => {
      const v = value[k];
      const key = /^[A-Za-z0-9_./{}-]+$/.test(k) && !/^\d+$/.test(k) ? k : JSON.stringify(k);
      if (v && typeof v === 'object' && (Array.isArray(v) ? v.length : Object.keys(v).length)) return `${pad}${key}:\n${toYaml(v, indent + 1)}`;
      return `${pad}${key}: ${v && typeof v === 'object' ? (Array.isArray(v) ? '[]' : '{}') : scalar(v)}`;
    }).join('\n');
  }
  return `${pad}${scalar(value)}`;
}

/** Static security scan of workspace sources using the same policy rules that gate agent output. */
export function securityScan(ctx, roots = ['src']) {
  const policy = new PolicyEngine();
  const findings = [];
  let files = 0;
  for (const root of roots) {
    for (const path of ctx.list(root)) {
      if (!/\.(js|json)$/.test(path)) continue;
      files += 1;
      const e = policy.evaluate('artifact', { path, content: ctx.read(path) });
      findings.push(...e.violations.map((v) => ({ path, rule: v.rule, severity: v.severity, reason: v.reason })));
    }
  }
  return { files, findings };
}

export const slug = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
