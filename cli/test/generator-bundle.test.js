// cli/test/generator-bundle.test.js
const { test } = require('node:test');
const assert = require('node:assert');
const { genBundle } = require('../lib/generators/bundle');

test('genBundle concatenates AGENTS.md and a skills index', () => {
  const canon = { agentsMd: '# Contract\nbody' };
  const skills = [{ name: 'api-design', description: 'API design' }];
  const out = genBundle(canon, skills);
  assert.match(out, /# Contract/);
  assert.match(out, /## Skills/);
  assert.match(out, /- api-design — API design/);
});
