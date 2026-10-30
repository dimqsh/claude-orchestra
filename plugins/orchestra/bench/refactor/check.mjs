import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import { join } from 'node:path';
const root = process.argv[2];
const { lineTotal } = await import(pathToFileURL(join(root, 'pricing.mjs')));
const { total, receipt } = await import(pathToFileURL(join(root, 'cart.mjs')));
const items = [{ name: 'A', price: 101, quantity: 3, discount: 0.5 }, { name: 'B', price: 200, quantity: 0 }];
assert.equal(lineTotal(items[0]), 152);
assert.equal(lineTotal({ price: 13, quantity: 2 }), 26);
assert.equal(total(items), 152);
assert.equal(receipt(items), 'A: 152\nB: 0');
assert.equal(total([]), 0);
assert.equal(receipt([]), '');
// Replace the shared function to verify both public callers delegate to it.
const { mkdtemp, cp, writeFile, rm } = await import('node:fs/promises');
const { tmpdir } = await import('node:os');
const temp = await mkdtemp(join(tmpdir(), 'bench-refactor-check-'));
try {
  await cp(root, temp, { recursive: true });
  await writeFile(join(temp, 'pricing.mjs'), 'export function lineTotal() { return 7; }\n');
  const changed = await import(pathToFileURL(join(temp, 'cart.mjs')));
  assert.equal(changed.total(items), 14);
  assert.equal(changed.receipt(items), 'A: 7\nB: 7');
} finally { await rm(temp, { recursive: true, force: true }); }
