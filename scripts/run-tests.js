// Cross-platform test runner: `node scripts/run-tests.js [service|orchestrator|all]`
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

const target = process.argv[2] ?? 'all';
const dirs = target === 'all' ? ['test/service', 'test/orchestrator'] : [`test/${target}`];
const files = dirs.flatMap((d) => readdirSync(d).filter((f) => f.endsWith('.test.js')).map((f) => join(d, f)));
const r = spawnSync(process.execPath, ['--test', ...files], { stdio: 'inherit' });
process.exit(r.status ?? 1);
