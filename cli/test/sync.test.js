// cli/test/sync.test.js
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { planTargets, syncTargets } = require('../lib/sync');

const canon = { agentsMd: '# Contract', config: {
  targets: ['claude', 'gemini', 'codex', 'bundle'], mcpServers: {} } };

test('planTargets maps every enabled target to a file', () => {
  const plan = planTargets(canon, []);
  const paths = plan.map(p => p.relPath).sort();
  assert.deepStrictEqual(paths, ['.codex/config.toml', 'CLAUDE.md', 'GEMINI.md', 'context-bundle.md'].sort());
});

test('syncTargets writes files to disk', () => {
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'out-'));
  const written = syncTargets(canon, [], out);
  assert.ok(written.includes('CLAUDE.md'));
  assert.match(fs.readFileSync(path.join(out, 'CLAUDE.md'), 'utf8'), /@AGENTS\.md/);
  assert.ok(fs.existsSync(path.join(out, '.codex/config.toml')));
});

// GEN-5: planTargets silently skips unknown targets
test('planTargets skips unknown target without throwing', () => {
  const mixedCanon = { agentsMd: '# Contract', config: { targets: ['claude', 'nope'], mcpServers: {} } };
  const plan = planTargets(mixedCanon, []);
  assert.strictEqual(plan.length, 1);
  assert.strictEqual(plan[0].relPath, 'CLAUDE.md');
});
