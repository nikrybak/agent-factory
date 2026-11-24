const { test } = require('node:test');
const assert = require('node:assert/strict');
const { stableStringify, stableDigest } = require('../lib/factory/stable-json');

test('stable JSON and digest ignore object insertion order but preserve arrays', () => {
  const a = { z: 1, a: { y: 2, x: [2, 1] } };
  const b = { a: { x: [2, 1], y: 2 }, z: 1 };
  assert.equal(stableStringify(a), stableStringify(b));
  assert.equal(stableDigest(a), stableDigest(b));
  assert.notEqual(stableDigest(a), stableDigest({ a: { x: [1, 2], y: 2 }, z: 1 }));
});

test('stable JSON rejects unsupported or cyclic values', () => {
  assert.throws(() => stableStringify({ value: undefined }), /JSON-compatible/);
  const cyclic = {}; cyclic.self = cyclic;
  assert.throws(() => stableStringify(cyclic), /cyclic/);
});
