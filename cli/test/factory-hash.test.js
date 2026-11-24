'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const crypto = require('node:crypto');
const { hashTree, hashTreePair } = require('../lib/factory/hash');

// every digest this file remembers goes to a cache folder of its own, never the shared one
const CACHE = fs.mkdtempSync(path.join(os.tmpdir(), 'factory-hash-cache-'));
process.env.INFRA_CACHE_DIR = CACHE;
test.after(() => fs.rmSync(CACHE, { recursive: true, force: true }));

function project(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'factory-hash-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const write = (relative, content) => {
    fs.mkdirSync(path.join(root, path.dirname(relative)), { recursive: true });
    fs.writeFileSync(path.join(root, relative), content);
  };
  write('cli/lib/a.js', 'a');
  write('docs/operations/MEMORY.md', 'journal');
  write('tasks/DONE.md', 'done');
  write('README.md', 'readme');
  return { root, write };
}

test('one walk gives exactly the digests of two separate walks (the certification identity is unchanged)', t => {
  const { root } = project(t);
  const journals = ['docs/operations', 'tasks'];
  const pair = hashTreePair(root, journals);
  assert.equal(pair.tree, hashTree(root));
  assert.equal(pair.without, hashTree(root, { excludePaths: journals }));
  assert.notEqual(pair.tree, pair.without);
});

test('a journal edit moves only the whole-tree digest, a code edit moves both', t => {
  const { root, write } = project(t);
  const journals = ['docs/operations', 'tasks'];
  const before = hashTreePair(root, journals);
  write('tasks/DONE.md', 'done, and more');
  const journal = hashTreePair(root, journals);
  assert.notEqual(journal.tree, before.tree);
  assert.equal(journal.without, before.without);
  write('cli/lib/a.js', 'b');
  const code = hashTreePair(root, journals);
  assert.notEqual(code.tree, journal.tree);
  assert.notEqual(code.without, journal.without);
});

test('the per-file digest option (memo keys only) gives another digest that still follows every content change', t => {
  const { root, write } = project(t);
  const fileHash = absolute => crypto.createHash('sha256').update(fs.readFileSync(absolute)).digest('hex');
  const keyed = hashTree(root, { fileHash });
  assert.notEqual(keyed, hashTree(root), 'never mistaken for the certification identity');
  write('README.md', 'readme 2');
  assert.notEqual(hashTree(root, { fileHash }), keyed);
});

test('the remembered byte digest equals a fresh byte walk and follows every edit', t => {
  const { root, write } = project(t);
  const fresh = () => {
    process.env.INFRA_TREE_HASH_CACHE = '0';
    try { return hashTree(root); } finally { delete process.env.INFRA_TREE_HASH_CACHE; }
  };
  const first = hashTree(root);
  assert.equal(first, fresh());
  assert.equal(hashTree(root), first, 'a hit returns the stored byte digest');
  assert.ok(fs.readdirSync(path.join(CACHE, 'treehash')).some(name => name.startsWith('digests-')));
  write('cli/lib/a.js', 'a changed with another size');
  assert.equal(hashTree(root), fresh());
  assert.notEqual(hashTree(root), first);
});

test('tool state is no source: agent worktrees and harness state never move the digest', t => {
  const { root, write } = project(t);
  const before = hashTree(root);
  write('.claude/worktrees/agent-1/cli/lib/a.js', 'another checkout');
  write('.claude/state/quality_gate_report.json', '{}');
  write('.factory/runs/run-1/plan.json', '{}');
  assert.equal(hashTree(root), before);
  write('.claude/settings.json', '{}');
  assert.notEqual(hashTree(root), before, 'the rest of .claude is project configuration');
});

test('Unity roots are found in the same walk under the finder rules: generated folders out, too deep or ignored roots not', t => {
  const { root, write } = project(t);
  const base = hashTree(root);
  write('game/ProjectSettings/ProjectVersion.txt', 'm_EditorVersion: 6000.0');
  const withGame = hashTree(root);
  assert.notEqual(withGame, base);
  write('game/Library/cache.bin', 'generated');
  write('game/Temp', 'generated file');
  assert.equal(hashTree(root), withGame, 'generated entries of a Unity root never count');
  write('game/Assets/Library/kept.cs', 'source');
  assert.notEqual(hashTree(root), withGame, 'only the first level below the root is generated');
  write('a/b/c/d/e/f/g/ProjectSettings/ProjectVersion.txt', 'deep');
  const deep = hashTree(root);
  write('a/b/c/d/e/f/g/Library/x', 'below a root deeper than the finder looks');
  assert.notEqual(hashTree(root), deep);
  write('venv/u/ProjectSettings/ProjectVersion.txt', 'ignored by the finder');
  const ignored = hashTree(root);
  write('venv/u/Library/x', 'counts');
  assert.notEqual(hashTree(root), ignored);
});
