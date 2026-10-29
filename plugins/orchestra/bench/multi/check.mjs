import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import { join } from 'node:path';
const root = process.argv[2];
const { parseIds } = await import(pathToFileURL(join(root, 'parse.mjs')));
const { report } = await import(pathToFileURL(join(root, 'report.mjs')));
const text = ' 2,1,2,, 03, 0,-1,1.5,7.5,8e1,12abc,x,1e2,0x10,9007199254740992 ';
assert.deepEqual(parseIds(text), [2, 1, 3]);
assert.deepEqual(report(text), { count: 3, ids: [2, 1, 3] });
assert.deepEqual(report(''), { count: 0, ids: [] });
assert.deepEqual(parseIds('5, 0005, 9007199254740991'), [5, 9007199254740991]);

// Replacing parseIds proves report delegates rather than duplicating the parsing logic.
const { mkdtemp, cp, writeFile, rm } = await import('node:fs/promises');
const { tmpdir } = await import('node:os');
const temp = await mkdtemp(join(tmpdir(), 'bench-multi-check-'));
try {
  await cp(root, temp, { recursive: true });
  await writeFile(join(temp, 'parse.mjs'), 'export function parseIds() { return [42, 17]; }\n');
  const changed = await import(pathToFileURL(join(temp, 'report.mjs')));
  assert.deepEqual(changed.report(''), { count: 2, ids: [42, 17] });
} finally { await rm(temp, { recursive: true, force: true }); }
