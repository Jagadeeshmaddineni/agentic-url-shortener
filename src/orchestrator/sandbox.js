import { spawnSync } from 'node:child_process';

/**
 * Controlled command execution for agents (e.g. running the generated project's tests).
 * Only allow-listed commands, fixed cwd inside the workspace, stripped environment, hard timeout.
 */
export function runCommand(command, args, { cwd, timeoutMs = 30_000 } = {}) {
  const started = Date.now();
  const bin = command === 'node' ? process.execPath : command;
  const r = spawnSync(bin, args, {
    cwd,
    timeout: timeoutMs,
    encoding: 'utf8',
    env: { PATH: process.env.PATH ?? '', NODE_ENV: 'test' },
    maxBuffer: 5 * 1024 * 1024,
  });
  return { code: r.status ?? (r.signal ? 124 : 1), stdout: r.stdout ?? '', stderr: r.stderr ?? '', durationMs: Date.now() - started, timedOut: r.error?.code === 'ETIMEDOUT' };
}

/** Parses node:test TAP-ish summary output. */
export function parseNodeTestSummary(stdout) {
  const num = (name) => Number((stdout.match(new RegExp(`^\\W*${name}\\s+(\\d+)`, 'm')) ?? [])[1] ?? 0);
  return { tests: num('tests'), pass: num('pass'), fail: num('fail') };
}
