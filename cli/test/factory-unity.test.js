const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  findUnityProjectRoots,
  isUnityGeneratedPath,
  relativeWithinUnityProject,
  unityRootForMarker,
} = require('../lib/factory/unity');

test('nested Unity roots own only their generated and package paths', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'factory-unity-roots-'));
  fs.mkdirSync(path.join(root, 'apps', 'game', 'ProjectSettings'), { recursive: true });
  fs.mkdirSync(path.join(root, 'apps', 'game', 'Library', 'PackageCache'), { recursive: true });
  fs.mkdirSync(path.join(root, 'Library', 'authored-sibling'), { recursive: true });
  fs.writeFileSync(path.join(root, 'apps', 'game', 'ProjectSettings', 'ProjectVersion.txt'), 'm_EditorVersion: 6000.5.9f1\n');

  const roots = findUnityProjectRoots(root);
  assert.deepEqual(roots, ['apps/game']);
  assert.equal(isUnityGeneratedPath('apps/game/Library/PackageCache/package.json', roots), true);
  assert.equal(isUnityGeneratedPath('Library/authored-sibling/package.json', roots), false);
  assert.deepEqual(relativeWithinUnityProject('apps/game/Packages/manifest.json', roots), {
    root: 'apps/game',
    path: 'Packages/manifest.json',
  });
  assert.equal(unityRootForMarker('apps/game/ProjectSettings/ProjectVersion.txt', roots), 'apps/game');
  assert.equal(unityRootForMarker('fixtures/ProjectVersion.txt', roots), null);
});

test('a skip predicate prunes directories the caller never reads', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'factory-unity-skip-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  for (const project of ['apps/game', 'children/local/game']) {
    fs.mkdirSync(path.join(root, ...project.split('/'), 'ProjectSettings'), { recursive: true });
    fs.writeFileSync(path.join(root, ...project.split('/'), 'ProjectSettings', 'ProjectVersion.txt'), 'm_EditorVersion: 6000.5.9f1\n');
  }
  const seen = [];
  const roots = findUnityProjectRoots(root, undefined, { skip: relative => { seen.push(relative); return relative === 'children/local'; } });
  assert.deepEqual(roots, ['apps/game']);
  assert.ok(seen.includes('children/local'));
  assert.ok(!seen.some(relative => relative.startsWith('children/local/')));
  assert.deepEqual(findUnityProjectRoots(root), ['apps/game', 'children/local/game']);
});
