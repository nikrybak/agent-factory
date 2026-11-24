'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { findInLine, scanMachinePaths } = require('../lib/machine-paths');

const DRIVE = ['C', ':\\Users\\owner\\work'].join('');
const HOME = ['/Users', '/owner/work'].join('');

test('finds Windows and personal POSIX paths but not portable forms', () => {
  assert.equal(findInLine(`read ${DRIVE}`).length, 1);
  assert.equal(findInLine(`read ${HOME}`).length, 1);
  assert.deepEqual(findInLine('read ~/.claude/skills and /home/runner/work'), []);
  assert.deepEqual(findInLine('read https://example.test/path and app_entry_root/orders/client'), []);
});

test('scans the registry but excludes local/runtime trees and test fixtures', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'city-fabric-machine-paths-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const write = (relative, content) => {
    fs.mkdirSync(path.join(root, path.dirname(relative)), { recursive: true });
    fs.writeFileSync(path.join(root, relative), content, 'utf8');
  };
  write('app_entry_root/_registry/REGISTRY.md', `bad ${DRIVE}\n`);
  write('app_entry_root/orders/client/README.md', `ignored ${DRIVE}\n`);
  write('skills/example/SKILL.md', `ignored ${DRIVE}\n`);
  write('skills/REGISTRY.json', '{"schemaVersion":"1.0.0"}\n');
  write('.claude/state/quality_gate_report.json', `ignored ${DRIVE}\n`);
  // an agent's git worktree inside the base is a whole copy of the repository, not this checkout's metadata
  write('.claude/worktrees/agent-1/app_entry_root/_registry/REGISTRY.md', `ignored ${DRIVE}\n`);
  write('cli/test/foreign-machine-fixture.js', `ignored ${DRIVE}\n`);
  const found = scanMachinePaths(root);
  assert.equal(found.length, 1);
  assert.equal(found[0].file, 'app_entry_root/_registry/REGISTRY.md');
});
