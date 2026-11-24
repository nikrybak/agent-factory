const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { validateManifest, loadManifest } = require('../lib/factory/manifest');

function validManifest() {
  return {
    $schema: './schema/project.schema.json', schemaVersion: '1.0.0',
    project: { id: 'best-app', name: 'Best App', intent: 'Build dependable software', repositoryRoot: '.' },
    profiles: ['web', 'api'],
    sources: [{ id: 'code', kind: 'local', location: '.', required: true }],
    stack: { mode: 'detect', declared: [] },
    risk: { class: 'medium', dataSensitivity: 'internal', internetExposure: true, regulated: false },
    capabilities: { required: ['browser', 'api'], optional: [] },
    authority: { destructive: false, dependencyInstall: false, schemaMigration: false, publicApiChange: false, networkWrite: false, publish: false, deploy: false, release: false },
    quality: { changedCoverage: 100, requiredGates: ['security'], additionalChecks: [] },
  };
}

test('strict validator accepts a complete manifest', () => {
  assert.deepEqual(validateManifest(validManifest()), []);
});

test('strict validator reports unknown keys, duplicates, bad roots and prototype keys deterministically', () => {
  const manifest = validManifest();
  manifest.unknown = true;
  manifest.profiles.push('web');
  manifest.project.repositoryRoot = '../outside';
  const malicious = JSON.parse(JSON.stringify(manifest).replace('"intent"', '"__proto__":{},"intent"'));
  const issues = validateManifest(malicious);
  assert.ok(issues.some(i => i.code === 'unknown-key' && i.path === '$.unknown'));
  assert.ok(issues.some(i => i.code === 'duplicate' && i.path === '$.profiles[2]'));
  assert.ok(issues.some(i => i.code === 'path-escape'));
  assert.ok(issues.some(i => i.code === 'forbidden-key'));
  assert.deepEqual(issues, [...issues].sort((a, b) => `${a.path}:${a.code}`.localeCompare(`${b.path}:${b.code}`)));
});

test('loadManifest safely loads and digests a root-bounded manifest', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'factory-manifest-'));
  fs.mkdirSync(path.join(root, 'factory'));
  fs.writeFileSync(path.join(root, 'factory', 'project.json'), JSON.stringify(validManifest()));
  const loaded = loadManifest(root);
  assert.equal(loaded.manifest.project.id, 'best-app');
  assert.match(loaded.digest, /^[a-f0-9]{64}$/);
  assert.throws(() => loadManifest(root, '../project.json'), /outside project root/);
});

test('validator fails closed on missing and wrongly typed sections', () => {
  const manifest = validManifest();
  delete manifest.authority.release;
  manifest.sources = {};
  manifest.stack.declared = {};
  manifest.capabilities.required = 'browser';
  manifest.risk.internetExposure = 'yes';
  manifest.quality.changedCoverage = 101;
  const codes = validateManifest(manifest).map(i => `${i.path}:${i.code}`);
  assert.ok(codes.includes('$.authority.release:required'));
  assert.ok(codes.includes('$.sources:type'));
  assert.ok(codes.includes('$.stack.declared:type'));
  assert.ok(codes.includes('$.capabilities.required:type'));
  assert.ok(codes.includes('$.risk.internetExposure:type'));
  assert.ok(codes.includes('$.quality.changedCoverage:range'));
});

test('loadManifest rejects malformed JSON and schema-invalid JSON', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'factory-invalid-manifest-'));
  fs.mkdirSync(path.join(root, 'factory'));
  const file = path.join(root, 'factory', 'project.json');
  fs.writeFileSync(file, '{bad');
  assert.throws(() => loadManifest(root), /invalid project manifest/);
  fs.writeFileSync(file, '{}');
  assert.throws(() => loadManifest(root), /schemaVersion/);
});

test('loadManifest rejects repository roots that escape through symlinks', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'factory-linked-manifest-'));
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'factory-linked-outside-'));
  fs.mkdirSync(path.join(root, 'factory'));
  try { fs.symlinkSync(outside, path.join(root, 'escape'), 'junction'); } catch { return; }
  const manifest = validManifest();
  manifest.project.repositoryRoot = 'escape';
  fs.writeFileSync(path.join(root, 'factory', 'project.json'), JSON.stringify(manifest));
  assert.throws(() => loadManifest(root), /repositoryRoot/);
});

test('manifest reads 1.0 and authors 1.1 stack identities without allowing them in legacy input', () => {
  const legacy = validManifest();
  assert.deepEqual(validateManifest(legacy, { projectRoot: process.cwd() }), []);
  legacy.stack.declared = [{ family: 'node', id: 'web', adapterId: 'node-npm' }];
  assert.ok(validateManifest(legacy, { projectRoot: process.cwd() }).some(issue => issue.code === 'unknown-key'));
  const current = validManifest();
  current.schemaVersion = '1.1.0';
  current.stack.declared = [{ family: 'node', root: '.', id: 'web', adapterId: 'node-npm' }];
  assert.deepEqual(validateManifest(current, { projectRoot: process.cwd() }), []);
});

test('v1.1 declarations require stable identity fields and reject duplicate ids or family-root identities', () => {
  const current = validManifest();
  current.schemaVersion = '1.1.0';
  current.stack.declared = [{ family: 'node' }];
  const missing = validateManifest(current, { projectRoot: process.cwd() });
  assert.ok(missing.some(item => item.path === '$.stack.declared[0].id' && item.code === 'required'));
  assert.ok(missing.some(item => item.path === '$.stack.declared[0].adapterId' && item.code === 'required'));
  assert.ok(missing.some(item => item.path === '$.stack.declared[0].root' && item.code === 'required'));

  current.stack.declared = [
    { id: 'web', family: 'node', adapterId: 'node-npm', root: '.' },
    { id: 'web', family: 'node', adapterId: 'node-other', root: './' },
  ];
  const duplicate = validateManifest(current, { projectRoot: process.cwd() });
  assert.ok(duplicate.some(item => item.path === '$.stack.declared[1].id' && item.code === 'duplicate'));
  assert.ok(duplicate.some(item => item.path === '$.stack.declared[1]' && item.code === 'duplicate'));

  current.stack.declared = [
    { id: 'api', family: 'node', adapterId: 'node-npm', root: 'backend' },
    { id: 'worker', family: 'node', adapterId: 'node-other', root: 'x/../backend' },
  ];
  assert.ok(validateManifest(current, { projectRoot: process.cwd() })
    .some(item => item.path === '$.stack.declared[1]' && item.code === 'duplicate'));
});
