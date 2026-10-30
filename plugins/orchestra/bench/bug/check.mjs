import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import { join } from 'node:path';
const { subtotal } = await import(pathToFileURL(join(process.argv[2], 'basket.mjs')));
assert.equal(subtotal([{ price: 100, quantity: 0 }, { price: 200 }]), 200);
assert.equal(subtotal([{ price: 100, quantity: 2 }], 0.25), 150);
assert.equal(subtotal([]), 0);
