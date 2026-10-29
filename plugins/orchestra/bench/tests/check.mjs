import assert from 'node:assert/strict';
import { mkdtemp, cp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
const root = process.argv[2];
const original = 'export function clamp(value, min, max) {\n  if (min > max) throw new RangeError("min exceeds max");\n  return Math.min(max, Math.max(min, value));\n}\n';
assert.equal(await readFile(join(root, 'clamp.mjs'), 'utf8'), original);
const temp = await mkdtemp(join(tmpdir(), 'bench-tests-check-'));
try {
  await cp(root, temp, { recursive: true });
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  const run = () => spawnSync(process.execPath, ['--test', 'clamp.test.mjs'], { cwd: temp, env, encoding: 'utf8', timeout: 3000 });
  const good = run();
  assert.equal(good.status, 0, good.stdout + good.stderr);
  for (const body of ['return min;', 'return max;', 'return value;', 'return Math.min(max, Math.max(min, value));']) {
    await writeFile(join(temp, 'clamp.mjs'), `export function clamp(value, min, max) { ${body} }\n`);
    assert.notEqual(run().status, 0, `tests missed mutant: ${body}`);
  }
} finally { await rm(temp, { recursive: true, force: true }); }
