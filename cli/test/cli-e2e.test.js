// cli/test/cli-e2e.test.js
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const BIN = path.join(__dirname, '..', 'bin', 'infra.js');

function baseFixture() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'base-'));
  fs.writeFileSync(path.join(d, 'AGENTS.md'), '# Contract');
  fs.writeFileSync(path.join(d, 'agents.json'), JSON.stringify({
    version: '1.0', canon: { agents: 'AGENTS.md', skills: 'skills' },
    targets: ['claude', 'gemini'], mcpServers: {}
  }));
  return d;
}

test('infra sync then --check passes; drift makes --check exit 2', () => {
  const from = baseFixture();
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'out-'));
  execFileSync('node', [BIN, 'sync', '--from', from, '--out', out]);
  assert.match(fs.readFileSync(path.join(out, 'CLAUDE.md'), 'utf8'), /@AGENTS\.md/);
  // clean check passes (exit 0)
  execFileSync('node', [BIN, 'sync', '--check', '--from', from, '--out', out]);
  // drift -> exit 2
  fs.writeFileSync(path.join(out, 'CLAUDE.md'), 'edited');
  assert.throws(
    () => execFileSync('node', [BIN, 'sync', '--check', '--from', from, '--out', out]),
    (e) => e.status === 2
  );
});
