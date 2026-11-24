// cli/test/generator-cursor.test.js
const { test } = require('node:test');
const assert = require('node:assert');
const { genCursor } = require('../lib/generators/cursor');
const { MARKER } = require('../lib/header');

test('genCursor contains the DO NOT EDIT marker', () => {
  const out = genCursor({});
  assert.ok(out.includes(MARKER), `expected MARKER in output, got:\n${out}`);
});

test('genCursor contains @AGENTS.md', () => {
  const out = genCursor({});
  assert.match(out, /@AGENTS\.md/);
});
