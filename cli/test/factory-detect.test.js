const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { detectStack, validateStackSignalCatalog } = require('../lib/factory/detect');

test('detectStack returns stable multi-stack evidence with confidence', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'factory-detect-'));
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ dependencies: { react: '^19.0.0' } }));
  fs.writeFileSync(path.join(root, 'pnpm-lock.yaml'), 'lockfileVersion: 9');
  fs.mkdirSync(path.join(root, 'services', 'api'), { recursive: true });
  fs.writeFileSync(path.join(root, 'services', 'api', 'pyproject.toml'), '[project]\nname="api"');
  const result = detectStack(root);
  assert.deepEqual(result.components.map(c => c.family), ['node', 'python']);
  assert.ok(result.components.every(c => c.confidence > 0 && c.confidence <= 1));
  assert.ok(result.components.find(c => c.family === 'node').frameworks.includes('react'));
  assert.deepEqual(result, detectStack(root));
});

test('detectStack reports an explicit unknown-stack gap', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'factory-detect-empty-'));
  const result = detectStack(root);
  assert.deepEqual(result.components, []);
  assert.equal(result.gaps[0].code, 'unknown-stack');
});

test('detectStack recognizes infrastructure and additional runtime families', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'factory-detect-wide-'));
  fs.writeFileSync(path.join(root, 'main.tf'), 'terraform {}');
  fs.writeFileSync(path.join(root, 'CMakeLists.txt'), 'project(example)');
  fs.writeFileSync(path.join(root, 'mix.exs'), 'defmodule Example.MixProject do end');
  const result = detectStack(root);
  assert.deepEqual(result.components.map(component => component.family), ['cpp', 'elixir', 'terraform']);
  assert.equal(result.capabilities.includes('infrastructure'), true);
});

test('detectStack recognizes a Unity root and excludes Unity generated state', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'factory-detect-unity-'));
  fs.mkdirSync(path.join(root, 'ProjectSettings'), { recursive: true });
  fs.mkdirSync(path.join(root, 'Assets', 'Plugins', 'Android'), { recursive: true });
  fs.mkdirSync(path.join(root, 'Library', 'PackageCache', 'generated'), { recursive: true });
  fs.mkdirSync(path.join(root, 'Builds', 'Android'), { recursive: true });
  fs.mkdirSync(path.join(root, 'fixtures', 'nested'), { recursive: true });
  fs.writeFileSync(path.join(root, 'ProjectSettings', 'ProjectVersion.txt'), 'm_EditorVersion: 6000.5.9f1\n');
  fs.writeFileSync(path.join(root, 'Assets', 'Plugins', 'Android', 'build.gradle'), 'plugins {}\n');
  fs.writeFileSync(path.join(root, 'Library', 'PackageCache', 'generated', 'package.json'), '{}');
  fs.writeFileSync(path.join(root, 'Builds', 'Android', 'settings.gradle'), '');
  fs.writeFileSync(path.join(root, 'fixtures', 'nested', 'ProjectVersion.txt'), 'not a Unity root marker\n');

  const result = detectStack(root);
  const unity = result.components.find(component => component.family === 'unity');

  assert.equal(unity.root, '.');
  assert.deepEqual(unity.evidence, [{ path: 'ProjectSettings/ProjectVersion.txt', signal: 'ProjectVersion.txt' }]);
  assert.deepEqual(unity.capabilities, ['game-engine']);
  assert.equal(result.components.filter(component => component.family === 'unity').length, 1);
  assert.equal(result.components.some(component => component.root.startsWith('Library/')), false);
  assert.equal(result.components.some(component => component.root.startsWith('Builds/')), false);
  assert.equal(result.components.some(component => component.root === 'Assets/Plugins/Android'), true);
});

test('detectStack recognizes a nested Unity component and prunes only its generated state', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'factory-detect-nested-unity-'));
  const unity = path.join(root, 'apps', 'mobile');
  fs.mkdirSync(path.join(unity, 'ProjectSettings'), { recursive: true });
  fs.mkdirSync(path.join(unity, 'Library', 'PackageCache', 'generated'), { recursive: true });
  fs.mkdirSync(path.join(unity, 'Assets', 'Plugins', 'Android'), { recursive: true });
  fs.mkdirSync(path.join(root, 'services', 'api'), { recursive: true });
  fs.writeFileSync(path.join(unity, 'ProjectSettings', 'ProjectVersion.txt'), 'm_EditorVersion: 6000.5.9f1\n');
  fs.writeFileSync(path.join(unity, 'Library', 'PackageCache', 'generated', 'package.json'), '{}');
  fs.writeFileSync(path.join(unity, 'Assets', 'Plugins', 'Android', 'build.gradle'), 'plugins {}\n');
  fs.writeFileSync(path.join(root, 'services', 'api', 'pyproject.toml'), '[project]\nname="api"\n');

  const result = detectStack(root);
  assert.equal(result.components.some(component => component.family === 'unity' && component.root === 'apps/mobile'), true);
  assert.equal(result.components.some(component => component.root.startsWith('apps/mobile/Library/')), false);
  assert.equal(result.components.some(component => component.root === 'apps/mobile/Assets/Plugins/Android'), true);
  assert.equal(result.components.some(component => component.root === 'services/api'), true);
});

test('detectStack excludes local registered child checkouts from a City Fabric base', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'factory-detect-city-'));
  fs.mkdirSync(path.join(root, 'app_entry_root', '_registry'), { recursive: true });
  fs.mkdirSync(path.join(root, 'app_entry_root', 'worlio', '_project'), { recursive: true });
  fs.mkdirSync(path.join(root, 'app_entry_root', 'worlio', 'backend'), { recursive: true });
  fs.mkdirSync(path.join(root, '.agents', 'skills', 'generated'), { recursive: true });
  fs.mkdirSync(path.join(root, 'skills', 'canonical'), { recursive: true });
  fs.writeFileSync(path.join(root, 'app_entry_root', '_registry', 'registry.json'), '{"projects":[]}');
  fs.writeFileSync(path.join(root, 'package.json'), '{}');
  fs.writeFileSync(path.join(root, 'app_entry_root', 'worlio', '_project', 'requirements.txt'), 'tracked==1\n');
  fs.writeFileSync(path.join(root, 'app_entry_root', 'worlio', 'backend', 'build.gradle.kts'), '');
  fs.writeFileSync(path.join(root, '.agents', 'skills', 'generated', 'pyproject.toml'), '[project]\nname="ignored"');
  fs.writeFileSync(path.join(root, 'skills', 'canonical', 'pyproject.toml'), '[project]\nname="tracked"');
  fs.mkdirSync(path.join(root, 'app_entry_root', 'worlio', 'client', 'ProjectSettings'), { recursive: true });
  fs.writeFileSync(path.join(root, 'app_entry_root', 'worlio', 'client', 'ProjectSettings', 'ProjectVersion.txt'), 'm_EditorVersion: 6000.5.9f1\n');

  const result = detectStack(root);
  assert.equal(result.components.some(component => component.family === 'unity'), false);
  assert.equal(result.components.some(component => component.root.includes('/backend')), false);
  assert.equal(result.components.some(component => component.root.startsWith('.agents/skills')), false);
  assert.equal(result.components.some(component => component.root === 'skills/canonical'), true);
  assert.equal(result.components.some(component => component.root === 'app_entry_root/worlio/_project'), true);
  assert.equal(result.components.some(component => component.root === '.' && component.family === 'node'), true);
});

test('v1.1 marker ownership attaches modules to the nearest owner and preserves same-root families', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'factory-detect-owners-'));
  fs.mkdirSync(path.join(root, 'ProjectSettings'), { recursive: true });
  for (const module of ['Privacy.androidlib', 'Speech.androidlib', 'Trust.androidlib']) {
    fs.mkdirSync(path.join(root, 'Assets', 'Plugins', 'Android', module), { recursive: true });
  }
  for (const module of ['app', 'buildSrc']) {
    fs.mkdirSync(path.join(root, 'services', 'backend', module), { recursive: true });
  }
  fs.writeFileSync(path.join(root, 'ProjectSettings', 'ProjectVersion.txt'), 'm_EditorVersion: 6000.5.9f1\n');
  for (const module of ['Privacy.androidlib', 'Speech.androidlib', 'Trust.androidlib']) {
    fs.writeFileSync(path.join(root, 'Assets', 'Plugins', 'Android', module, 'build.gradle'), 'plugins {}\n');
  }
  fs.writeFileSync(path.join(root, 'services', 'backend', 'settings.gradle'), 'rootProject.name="backend"\n');
  for (const module of ['app', 'buildSrc']) {
    fs.writeFileSync(path.join(root, 'services', 'backend', module, 'build.gradle'), 'plugins {}\n');
  }
  fs.writeFileSync(path.join(root, 'package.json'), '{}');
  const catalog = {
    schemaVersion: '1.1.0',
    signals: [
      { family: 'unity', files: ['ProjectVersion.txt'], confidence: 0.9, markerRole: 'build-root', ownsModuleFamilies: ['java'] },
      { family: 'java', files: ['settings.gradle'], confidence: 0.8, markerRole: 'build-root' },
      { family: 'java', files: ['build.gradle'], confidence: 0.6, markerRole: 'module' },
      { family: 'node', files: ['package.json'], confidence: 0.7 },
    ],
  };
  const result = detectStack(root, {
    catalog,
    declarations: [{ family: 'unity', root: '.', id: 'mobile-client', adapterId: 'unity-editor' }],
  });
  assert.equal(result.schemaVersion, '1.1.0');
  assert.deepEqual(result.components.map(component => `${component.family}:${component.root}`), [
    'java:services/backend', 'node:.', 'unity:.'
  ]);
  const unity = result.components.find(component => component.family === 'unity');
  assert.equal(unity.id, 'mobile-client');
  assert.equal(unity.adapterId, 'unity-editor');
  assert.deepEqual(unity.evidence.map(item => item.path), ['ProjectSettings/ProjectVersion.txt']);
  assert.deepEqual(unity.modules.map(module => module.root), [
    'Assets/Plugins/Android/Privacy.androidlib',
    'Assets/Plugins/Android/Speech.androidlib',
    'Assets/Plugins/Android/Trust.androidlib',
  ]);
  assert.ok(unity.modules.every(module => module.family === 'java' && module.evidence.length === 1));
  const java = result.components.find(component => component.family === 'java');
  assert.deepEqual(java.evidence.map(item => item.path), ['services/backend/settings.gradle']);
  assert.deepEqual(java.modules.map(module => module.root), ['app', 'buildSrc']);
  assert.ok(java.modules.every(module => module.family === 'java' && module.evidence.length === 1));
});

test('stack-signal validation reads legacy catalogs but reserves ownership fields for 1.1', () => {
  assert.equal(validateStackSignalCatalog({
    schemaVersion: '1.0.0', signals: [{ family: 'node', files: ['package.json'], confidence: 0.5 }],
  }), true);
  assert.throws(() => validateStackSignalCatalog({
    schemaVersion: '1.0.0',
    signals: [{ family: 'java', files: ['build.gradle'], confidence: 0.5, markerRole: 'module' }],
  }), /cannot declare marker ownership/);
  assert.throws(() => validateStackSignalCatalog({
    schemaVersion: '1.1.0',
    signals: [{ family: 'java', files: ['build.gradle'], confidence: 0.5, markerRole: 'module', ownsModuleFamilies: ['java'] }],
  }), /cannot own module families/);
});

test('v1.1 module markers never become top-level components when ownership is orphaned or ambiguous', () => {
  const orphanRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'factory-detect-orphan-'));
  fs.writeFileSync(path.join(orphanRoot, 'build.gradle'), 'plugins {}\n');
  const moduleSignal = { family: 'java', files: ['build.gradle'], confidence: 0.6, markerRole: 'module' };
  const orphan = detectStack(orphanRoot, { catalog: { schemaVersion: '1.1.0', signals: [moduleSignal] } });
  assert.equal(orphan.components.some(component => component.family === 'java'), false);
  assert.ok(orphan.gaps.some(gap => gap.code === 'orphan-module-marker'));

  const ambiguousRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'factory-detect-ambiguous-'));
  fs.mkdirSync(path.join(ambiguousRoot, 'module'), { recursive: true });
  fs.writeFileSync(path.join(ambiguousRoot, 'owner-a.marker'), 'a');
  fs.writeFileSync(path.join(ambiguousRoot, 'owner-b.marker'), 'b');
  fs.writeFileSync(path.join(ambiguousRoot, 'module', 'build.gradle'), 'plugins {}\n');
  const ambiguous = detectStack(ambiguousRoot, { catalog: {
    schemaVersion: '1.1.0',
    signals: [
      { family: 'node', files: ['owner-a.marker'], confidence: 0.7, markerRole: 'build-root', ownsModuleFamilies: ['java'] },
      { family: 'python', files: ['owner-b.marker'], confidence: 0.7, markerRole: 'build-root', ownsModuleFamilies: ['java'] },
      moduleSignal,
    ],
  } });
  assert.equal(ambiguous.components.some(component => component.family === 'java'), false);
  assert.ok(ambiguous.gaps.some(gap => gap.code === 'ambiguous-module-owner'));
});

test('declaration overlay uses the same canonical root identity as manifest validation', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'factory-detect-normalized-declaration-'));
  fs.writeFileSync(path.join(root, 'package.json'), '{}');
  const catalog = {
    schemaVersion: '1.1.0',
    signals: [{ family: 'node', files: ['package.json'], confidence: 0.7 }],
  };
  for (const declaredRoot of ['x/..', './', '.\\']) {
    const result = detectStack(root, {
      catalog,
      declarations: [{ id: 'web-root', family: 'node', adapterId: 'node-npm', root: declaredRoot }],
    });
    assert.equal(result.components[0].id, 'web-root');
    assert.equal(result.components[0].adapterId, 'node-npm');
  }
});

test('stack-signal validation rejects malformed catalogs, selectors, metadata and confidence', () => {
  for (const malformed of [null, {}, { schemaVersion: '2.0.0', signals: [] }, { schemaVersion: '1.1.0', signals: [] }]) {
    assert.throws(() => validateStackSignalCatalog(malformed), /supported schemaVersion and signals/);
  }
  const catalogFor = signal => ({ schemaVersion: '1.1.0', signals: [signal] });
  assert.throws(() => validateStackSignalCatalog(catalogFor(null)), /family is invalid/);
  assert.throws(() => validateStackSignalCatalog(catalogFor({ family: 'Bad', files: ['a'], confidence: 0.5 })), /family is invalid/);
  assert.throws(() => validateStackSignalCatalog(catalogFor({ family: 'node', confidence: 0.5 })), /requires files or extensions/);
  assert.throws(() => validateStackSignalCatalog(catalogFor({ family: 'node', files: ['bad/path'], confidence: 0.5 })), /requires files or extensions/);
  assert.throws(() => validateStackSignalCatalog(catalogFor({ family: 'node', extensions: ['js'], confidence: 0.5 })), /extensions are invalid/);
  assert.throws(() => validateStackSignalCatalog(catalogFor({ family: 'node', files: ['a'], confidence: 0 })), /confidence is invalid/);
  assert.throws(() => validateStackSignalCatalog(catalogFor({ family: 'node', files: ['a'], confidence: 0.5, capabilities: ['Bad'] })), /capabilities is invalid/);
  assert.throws(() => validateStackSignalCatalog(catalogFor({ family: 'node', files: ['a'], confidence: 0.5, ownsModuleFamilies: ['java', 'java'] })), /ownsModuleFamilies is invalid/);
  assert.throws(() => validateStackSignalCatalog(catalogFor({ family: 'node', files: ['a'], confidence: 0.5, markerRole: 'leaf' })), /markerRole is invalid/);
});

test('declarations apply optional runtime metadata once and duplicate authored ids become gaps', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'factory-detect-declarations-'));
  fs.writeFileSync(path.join(root, 'package.json'), '{ malformed');
  fs.writeFileSync(path.join(root, 'pyproject.toml'), '[project]\nname="api"');
  const catalog = { schemaVersion: '1.1.0', signals: [
    { family: 'node', files: ['package.json'], confidence: 0.6 },
    { family: 'python', files: ['pyproject.toml'], confidence: 0.6 },
  ] };
  const result = detectStack(root, { catalog, declarations: [
    null,
    { family: 42, root: '.' },
    { family: 'node', root: './', id: 'shared', adapterId: 'node-npm', runtime: 'node-24', packageManager: 'npm' },
    { family: 'node', root: '.', id: 'ignored-duplicate', adapterId: 'ignored' },
    { family: 'python', root: '.', id: 'shared', adapterId: 'python-pip' },
  ] });
  const node = result.components.find(item => item.family === 'node');
  assert.equal(node.id, 'shared');
  assert.equal(node.runtime, 'node-24');
  assert.equal(node.packageManager, 'npm');
  assert.deepEqual(node.frameworks, []);
  assert.ok(result.gaps.some(gap => gap.code === 'duplicate-component-id'));
});

test('detectStack never reads tool state: Factory runs and agent worktrees are no components', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'factory-detect-workspace-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const write = (relative, text) => {
    fs.mkdirSync(path.dirname(path.join(root, relative)), { recursive: true });
    fs.writeFileSync(path.join(root, relative), text);
  };
  write('package.json', '{}');
  write('.claude/worktrees/agent-1/package.json', '{}');
  write('.claude/worktrees/agent-1/svc/pyproject.toml', '[project]\nname="x"');
  write('.factory/runs/run-1/pyproject.toml', '[project]\nname="y"');
  write('.claude/state/go.mod', 'module x');
  assert.deepEqual(detectStack(root).components.map(component => component.root), ['.']);
});
