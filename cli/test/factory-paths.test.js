const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { normalizeRelativeRoot, resolveInside, walkFiles } = require('../lib/factory/paths');

test('normalizeRelativeRoot canonicalizes declaration identities portably', () => {
  assert.equal(normalizeRelativeRoot('x/..'), '.');
  assert.equal(normalizeRelativeRoot('./'), '.');
  assert.equal(normalizeRelativeRoot('backend//api/'), 'backend/api');
  assert.equal(normalizeRelativeRoot('backend\\api'), 'backend/api');
});

test('resolveInside accepts bounded relative paths and rejects escapes', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'factory-paths-'));
  assert.equal(resolveInside(root, 'factory/project.json'), path.join(root, 'factory', 'project.json'));
  assert.throws(() => resolveInside(root, '../outside'), /outside project root/);
  assert.throws(() => resolveInside(root, path.resolve(root, '..', 'outside')), /relative/);
});

test('walkFiles is stable and ignores dependency directories and symlinks', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'factory-walk-'));
  fs.mkdirSync(path.join(root, 'apps', 'z'), { recursive: true });
  fs.mkdirSync(path.join(root, 'node_modules', 'bad'), { recursive: true });
  fs.writeFileSync(path.join(root, 'apps', 'z', 'go.mod'), 'module x');
  fs.writeFileSync(path.join(root, 'package.json'), '{}');
  fs.writeFileSync(path.join(root, 'node_modules', 'bad', 'Cargo.toml'), '');
  try { fs.symlinkSync(path.join(root, 'apps'), path.join(root, 'linked'), 'junction'); } catch {}
  assert.deepEqual(walkFiles(root), ['apps/z/go.mod', 'package.json']);
});

test('walkFiles can prune an entire caller-defined subtree before traversal', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'factory-paths-prune-'));
  fs.mkdirSync(path.join(root, 'volatile', 'deep'), { recursive: true });
  fs.writeFileSync(path.join(root, 'volatile', 'deep', 'ignored.txt'), 'ignored');
  fs.writeFileSync(path.join(root, 'tracked.txt'), 'tracked');
  assert.deepEqual(walkFiles(root, { exclude: relative => relative === 'volatile' }), ['tracked.txt']);
});

test('resolveInside rejects an existing symlink that resolves outside the root', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'factory-path-root-'));
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'factory-path-outside-'));
  fs.writeFileSync(path.join(outside, 'project.json'), '{}');
  try { fs.symlinkSync(outside, path.join(root, 'escape'), 'junction'); } catch { return; }
  assert.throws(() => resolveInside(root, 'escape/project.json'), /outside project root/);
});
