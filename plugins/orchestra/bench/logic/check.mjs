import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import { join } from 'node:path';
const { available } = await import(pathToFileURL(join(process.argv[2], 'slots.mjs')));
const slots = Object.freeze([
  { id: 'c', start: 4, end: 8 }, { id: 'b', start: 1, end: 5 },
  { id: 'a', start: 1, end: 9 }, { id: 'aa', start: 3, end: 6 }, { id: 'left', start: -2, end: 2 }, { id: 'right', start: 7, end: 10 }
].map(Object.freeze));
assert.deepEqual(available(slots, 2, 7).map(s => s.id), ['a', 'b', 'aa', 'c']);
assert.deepEqual(available(slots, 3, 3), []);
assert.deepEqual(available(slots, 7, 2), []);
assert.deepEqual(available([], 0, 1), []);
