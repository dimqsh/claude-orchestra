import test from "node:test";
import assert from "node:assert/strict";
import { clamp } from "./clamp.mjs";
test("clamp values and bounds", () => {
  assert.equal(clamp(5, 0, 10), 5);
  assert.equal(clamp(-1, 0, 10), 0);
  assert.equal(clamp(11, 0, 10), 10);
  assert.equal(clamp(5, 3, 3), 3);
  assert.equal(clamp(-8, -5, -2), -5);
  assert.equal(clamp(0, -5, -2), -2);
  assert.throws(() => clamp(5, 10, 0), RangeError);
});
