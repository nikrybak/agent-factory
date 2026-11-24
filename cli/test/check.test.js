// cli/test/check.test.js
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { syncTargets } = require('../lib/sync');
const { checkDrift } = require('../lib/check');

const canon = { agentsMd: '# Contract', config: { targets: ['claude'], mcpServers: {} } };

test('checkDrift reports nothing right after a sync', () => {
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'out-'));
  syncTargets(canon, [], out);
  const r = checkDrift(canon, [], out);
  assert.deepStrictEqual(r.drifted, []);
  assert.deepStrictEqual(r.missing, []);
});

test('checkDrift detects a hand-edited file and a missing file', () => {
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'out-'));
  syncTargets(canon, [], out);
  fs.writeFileSync(path.join(out, 'CLAUDE.md'), 'hand edited');
  assert.deepStrictEqual(checkDrift(canon, [], out).drifted, ['CLAUDE.md']);
  fs.rmSync(path.join(out, 'CLAUDE.md'));
  assert.deepStrictEqual(checkDrift(canon, [], out).missing, ['CLAUDE.md']);
});
