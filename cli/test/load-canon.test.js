// cli/test/load-canon.test.js
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { loadCanon } = require('../lib/load-canon');

function fixture() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'canon-'));
  fs.writeFileSync(path.join(d, 'AGENTS.md'), '# Project Agent Contract\nhello');
  fs.writeFileSync(path.join(d, 'agents.json'), JSON.stringify({
    version: '1.0', canon: { agents: 'AGENTS.md', skills: 'skills' },
    targets: ['claude'], mcpServers: {}
  }));
  return d;
}

test('loadCanon reads AGENTS.md and parses agents.json', () => {
  const c = loadCanon(fixture());
  assert.match(c.agentsMd, /Project Agent Contract/);
  assert.deepStrictEqual(c.config.targets, ['claude']);
  assert.ok(path.isAbsolute(c.root));
});

test('loadCanon throws on missing AGENTS.md', () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'canon-'));
  fs.writeFileSync(path.join(d, 'agents.json'), '{}');
  assert.throws(() => loadCanon(d), /\[infra\].*AGENTS\.md/);
});

test('loadCanon throws on missing agents.json', () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'canon-'));
  fs.writeFileSync(path.join(d, 'AGENTS.md'), '# hello');
  assert.throws(() => loadCanon(d), /\[infra\].*agents\.json/);
});

test('loadCanon throws on invalid agents.json', () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'canon-'));
  fs.writeFileSync(path.join(d, 'AGENTS.md'), '# hello');
  fs.writeFileSync(path.join(d, 'agents.json'), 'not json {{{');
  assert.throws(() => loadCanon(d), /\[infra\].*not valid JSON/);
});
