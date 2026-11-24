const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  computeCertificationIdentity,
  evaluateProjectLayout,
} = require('../lib/factory/identity');

function write(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, value);
}

function makeFactoryRoot(parent, name, projects) {
  const root = path.join(parent, name);
  write(path.join(root, 'AGENTS.md'), '# Factory City\n');
  write(path.join(root, 'cli', 'bin', 'infra.js'), '');
  write(path.join(root, 'factory.txt'), 'same authored bytes\n');
  write(path.join(root, 'app_entry_root', '_registry', 'registry.json'), JSON.stringify({
    schemaVersion: '1.0.0',
    projects,
  }));
  for (const project of projects) {
    fs.mkdirSync(path.join(root, 'app_entry_root', project.key, '_project'), { recursive: true });
    for (const version of project.app?.versions ?? []) {
      fs.mkdirSync(path.join(root, 'app_entry_root', project.key, `${project.key}-${version.id}`), { recursive: true });
    }
  }
  return root;
}

test('certification identity is neutral to equivalent absolute root locations', t => {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'factory-identity-roots-'));
  t.after(() => fs.rmSync(parent, { recursive: true, force: true }));
  const projects = [{ key: 'worlio', presentLocally: true, app: { active: 'v1', versions: [{ id: 'v1' }] } }];
  const first = makeFactoryRoot(parent, 'first-location', projects);
  const second = makeFactoryRoot(parent, 'second-location', projects);

  const firstIdentity = computeCertificationIdentity(first);
  const secondIdentity = computeCertificationIdentity(second);

  assert.deepEqual(firstIdentity, secondIdentity);
  assert.equal(firstIdentity.scope, 'base');
  assert.equal(firstIdentity.key, null);
  assert.match(firstIdentity.sourceTreeHash, /^[a-f0-9]{64}$/);
  assert.match(firstIdentity.layoutInputDigest, /^[a-f0-9]{64}$/);
  assert.match(firstIdentity.certificationIdentityDigest, /^[a-f0-9]{64}$/);
});

test('standalone identity is explicit and location-neutral', t => {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'factory-identity-standalone-'));
  t.after(() => fs.rmSync(parent, { recursive: true, force: true }));
  const first = path.join(parent, 'first');
  const second = path.join(parent, 'second');
  write(path.join(first, 'source.txt'), 'same\n');
  write(path.join(second, 'source.txt'), 'same\n');

  const firstIdentity = computeCertificationIdentity(first);
  const secondIdentity = computeCertificationIdentity(second);

  assert.deepEqual(firstIdentity, secondIdentity);
  assert.equal(firstIdentity.scope, 'standalone');
  assert.equal(evaluateProjectLayout(first).status, 'PASS');
});

test('registered child identity isolates siblings and invalidates its own registry and layout slice', t => {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'factory-identity-child-'));
  t.after(() => fs.rmSync(parent, { recursive: true, force: true }));
  const projects = [
    { key: 'worlio', title: 'Worlio', presentLocally: true, app: { active: 'v1', versions: [{ id: 'v1' }] } },
    { key: 'sibling', title: 'Sibling', presentLocally: true, app: { active: 'v1', versions: [{ id: 'v1' }] } },
  ];
  const root = makeFactoryRoot(parent, 'base', projects);
  const child = path.join(root, 'app_entry_root', 'worlio');
  write(path.join(child, '_project', 'source.txt'), 'child source\n');

  const initial = computeCertificationIdentity(child);
  assert.equal(initial.scope, 'child');
  assert.equal(initial.key, 'worlio');
  assert.equal(evaluateProjectLayout(child).status, 'PASS');

  write(path.join(child, '_output', 'worlio-v1', 'receipt.json'), '{}');
  assert.deepEqual(computeCertificationIdentity(child), initial);

  const siblingChanged = structuredClone(projects);
  siblingChanged[1].title = 'Changed sibling';
  write(path.join(root, 'app_entry_root', '_registry', 'registry.json'), JSON.stringify({
    schemaVersion: '1.0.0', projects: siblingChanged,
  }));
  fs.mkdirSync(path.join(root, '_output', 'sibling'), { recursive: true });
  assert.deepEqual(computeCertificationIdentity(child), initial);

  const sameKeyChanged = structuredClone(siblingChanged);
  sameKeyChanged[0].title = 'Changed Worlio';
  write(path.join(root, 'app_entry_root', '_registry', 'registry.json'), JSON.stringify({
    schemaVersion: '1.0.0', projects: sameKeyChanged,
  }));
  const registryChanged = computeCertificationIdentity(child);
  assert.equal(registryChanged.sourceTreeHash, initial.sourceTreeHash);
  assert.notEqual(registryChanged.layoutInputDigest, initial.layoutInputDigest);
  assert.notEqual(registryChanged.certificationIdentityDigest, initial.certificationIdentityDigest);

  fs.mkdirSync(path.join(root, '_output', 'worlio'), { recursive: true });
  const layoutChanged = computeCertificationIdentity(child);
  assert.equal(evaluateProjectLayout(child).status, 'FAIL');
  assert.equal(layoutChanged.sourceTreeHash, initial.sourceTreeHash);
  assert.notEqual(layoutChanged.layoutInputDigest, registryChanged.layoutInputDigest);
  assert.notEqual(layoutChanged.certificationIdentityDigest, registryChanged.certificationIdentityDigest);
});
