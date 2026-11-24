'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const catalog = require('../../factory/catalog/adapters.json');
const signals = require('../../factory/catalog/stack-signals.json');
const {
  OPERATIONS, canonicalAdapterProjectRoot, expandAdapterArgv,
  validateAdapterCatalog, selectAdapters, planAdapterOperation,
} = require('../lib/factory/adapters');

function clone(value) { return JSON.parse(JSON.stringify(value)); }

test('catalog covers every detected stack family with explicit operation support or gaps', () => {
  const families = [...new Set(signals.signals.map(signal => signal.family))];
  assert.equal(validateAdapterCatalog(catalog, { requiredFamilies: families }), true);
  for (const adapter of catalog.adapters) {
    assert.deepEqual([...new Set([...Object.keys(adapter.operations), ...adapter.unsupported])].sort(), [...OPERATIONS].sort());
  }
});

test('adapter validation rejects shells, incomplete declarations and unauthorized mutators', () => {
  const shell = clone(catalog); shell.adapters[0].operations.test.argv = ['sh', '-c', 'npm test'];
  assert.throws(() => validateAdapterCatalog(shell), /must not invoke a shell/);
  const incomplete = clone(catalog); incomplete.adapters[0].unsupported = [];
  assert.throws(() => validateAdapterCatalog(incomplete), /explicitly support or reject deploy/);
  const unsafeInstall = clone(catalog); delete unsafeInstall.adapters[0].operations.install.authority;
  assert.throws(() => validateAdapterCatalog(unsafeInstall), /requires dependencyInstall authority/);
});

test('selects adapters deterministically and reports unknown families as explicit blocking gaps', () => {
  const selected = selectAdapters({ catalog, detection: { components: [{ family: 'python' }, { family: 'node' }] } });
  assert.equal(selected.status, 'ready');
  assert.deepEqual(selected.adapters.map(adapter => adapter.family), ['node', 'python']);
  const unknown = selectAdapters({ catalog, detection: { components: [{ family: 'quantum' }] } });
  assert.equal(unknown.status, 'blocked');
  assert.equal(unknown.gaps[0].code, 'unsupported-stack-adapter');
});

test('produces exact argv plans and denies install and deploy without explicit authority', () => {
  const deniedInstall = planAdapterOperation({ catalog, family: 'node', operation: 'install' });
  assert.equal(deniedInstall.status, 'blocked');
  assert.equal(deniedInstall.gaps[0].code, 'authority-denied');
  const install = planAdapterOperation({ catalog, family: 'node', operation: 'install', authority: { dependencyInstall: true }, context: { root: 'web' } });
  assert.deepEqual(install.plans[0].argv, ['npm', 'install']);
  assert.equal(install.plans[0].cwd, 'web');
  assert.equal(install.plans[0].mutating, true);

  const deniedDeploy = planAdapterOperation({ catalog, family: 'terraform', operation: 'deploy', context: { planfile: 'safe.tfplan' } });
  assert.equal(deniedDeploy.status, 'blocked');
  const deploy = planAdapterOperation({ catalog, family: 'terraform', operation: 'deploy', authority: { deploy: true }, context: { root: 'infra', planfile: 'safe.tfplan' } });
  assert.deepEqual(deploy.plans[0].argv, ['terraform', 'apply', 'safe.tfplan']);
});

test('unsupported operations and missing or unsafe placeholders fail closed', () => {
  const unsupported = planAdapterOperation({ catalog, family: 'ci', operation: 'deploy' });
  assert.equal(unsupported.status, 'blocked');
  assert.equal(unsupported.gaps[0].code, 'unsupported-operation');
  assert.throws(() => planAdapterOperation({ catalog, family: 'dart', operation: 'build' }), /context is missing: entrypoint/);
  assert.throws(() => planAdapterOperation({ catalog, family: 'dart', operation: 'build', context: { entrypoint: 'bin/main.dart\nrm' } }), /context is unsafe/);
  assert.throws(() => expandAdapterArgv(['${projectRoot}/../../outside'], { projectRoot: '/safe/root' }), /complete argv value/);
  assert.throws(() => expandAdapterArgv(['${project-root}'], {}), /placeholder is malformed/);
  assert.throws(() => expandAdapterArgv(['${unknown}'], {}), /context is missing: unknown/);
});

test('canonical projectRoot context is absolute, existing and confined to the repository', t => {
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  const repository = fs.mkdtempSync(path.join(os.tmpdir(), 'factory-adapter-root-'));
  t.after(() => fs.rmSync(repository, { recursive: true, force: true }));
  fs.mkdirSync(path.join(repository, 'preview-client'));
  const canonical = canonicalAdapterProjectRoot(repository, 'preview-client');
  assert.equal(path.isAbsolute(canonical), true);
  assert.equal(canonical, fs.realpathSync.native(path.join(repository, 'preview-client')));
  assert.throws(() => canonicalAdapterProjectRoot(repository, 'missing'), /canonical in-repository directory/);
  assert.throws(() => canonicalAdapterProjectRoot(repository, '..'), /canonical in-repository directory/);
  assert.throws(() => canonicalAdapterProjectRoot(`${repository}\nunsafe`, '.'), /missing or unsafe/);
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'factory-adapter-outside-'));
  t.after(() => fs.rmSync(outside, { recursive: true, force: true }));
  const link = path.join(repository, 'linked-project');
  try {
    fs.symlinkSync(outside, link, process.platform === 'win32' ? 'junction' : 'dir');
  } catch (error) {
    t.diagnostic(`symlink escape assertion unavailable on this host: ${error.code}`);
    return;
  }
  assert.throws(() => canonicalAdapterProjectRoot(repository, 'linked-project'), /canonical in-repository directory/);
});

test('Unity adapter runs only portable verification operations and blocks generic release mutation', () => {
  const tests = planAdapterOperation({ catalog, family: 'unity', operation: 'test', context: { root: 'mobile' } });
  assert.equal(tests.status, 'ready');
  assert.deepEqual(tests.plans[0].argv.slice(0, 4), [
    'unity-editor', '-batchmode', '-nographics', '-projectPath',
  ]);
  assert.equal(tests.plans[0].argv.includes('-quit'), false);
  const coverage = planAdapterOperation({ catalog, family: 'unity', operation: 'coverage', context: { root: 'mobile' } });
  assert.equal(coverage.status, 'ready');
  assert.equal(coverage.plans[0].argv.includes('-quit'), false);
  assert.equal(coverage.plans[0].argv.includes('-enableCodeCoverage'), true);
  assert.equal(tests.plans[0].cwd, 'mobile');
  const build = planAdapterOperation({ catalog, family: 'unity', operation: 'build' });
  assert.equal(build.status, 'blocked');
  assert.equal(build.gaps[0].code, 'unsupported-operation');
});

test('v1.1 duplicate-family adapters require explicit component selection and multi-command plans stay ordered', () => {
  const first = clone(catalog.adapters.find(adapter => adapter.family === 'node'));
  first.id = 'node-npm';
  first.operations.test = { commands: [
    { id: 'unit', argv: ['npm', 'run', 'test:unit'], timeoutMs: 1200000 },
    { id: 'integration', argv: ['npm', 'run', 'test:integration'], timeoutMs: 2400000 },
  ] };
  const second = clone(first); second.id = 'node-bun';
  const versioned = { schemaVersion: '1.1.0', adapters: [first, second] };
  assert.equal(validateAdapterCatalog(versioned), true);
  const selected = selectAdapters({
    catalog: versioned,
    detection: { components: [{ id: 'web', family: 'node', adapterId: 'node-bun' }] },
  });
  assert.equal(selected.status, 'ready');
  assert.deepEqual(selected.selections, [{ componentId: 'web', adapterId: 'node-bun' }]);
  assert.equal(selectAdapters({
    catalog: versioned, detection: { components: [{ id: 'legacy', family: 'node' }] },
  }).gaps[0].code, 'ambiguous-stack-adapter');
  const planned = planAdapterOperation({
    catalog: versioned, family: 'node', adapterId: 'node-npm', operation: 'test', context: { root: 'web' },
  });
  assert.deepEqual(planned.plans.map(plan => [plan.id, plan.sequence, plan.argv, plan.timeoutMs]), [
    ['node-npm:test:unit', 0, ['npm', 'run', 'test:unit'], 1200000],
    ['node-npm:test:integration', 1, ['npm', 'run', 'test:integration'], 2400000],
  ]);
});

test('v1.1 command timeouts are bounded, unambiguous and unavailable to legacy catalogs', () => {
  const withTest = definition => {
    const value = clone(catalog);
    value.schemaVersion = '1.1.0';
    value.adapters[0].operations.test = definition;
    return value;
  };
  for (const timeoutMs of [999, 21600001, 1000.5, '1200000']) {
    assert.throws(() => validateAdapterCatalog(withTest({ argv: ['npm', 'test'], timeoutMs })), /timeoutMs must be an integer/);
  }
  assert.throws(() => validateAdapterCatalog(withTest({
    commands: [{ id: 'unit', argv: ['npm', 'test'] }], timeoutMs: 1200000,
  })), /timeoutMs must be declared on each command/);
  const legacy = clone(catalog);
  legacy.adapters[0].operations.test.timeoutMs = 1200000;
  assert.throws(() => validateAdapterCatalog(legacy), /unknown fields/);

  const current = withTest({ argv: ['npm', 'test'], timeoutMs: 1200000 });
  assert.equal(validateAdapterCatalog(current), true);
  assert.equal(planAdapterOperation({
    catalog: current, family: 'node', operation: 'test', context: { root: '.' },
  }).plans[0].timeoutMs, 1200000);
});

test('v1.1 operation validation rejects mixed legacy/multi shapes and nested shell commands', () => {
  const versioned = clone(catalog); versioned.schemaVersion = '1.1.0';
  versioned.adapters[0].operations.test = {
    argv: ['npm', 'test'], commands: [{ id: 'unit', argv: ['npm', 'test'] }],
  };
  assert.throws(() => validateAdapterCatalog(versioned), /exactly one of argv or commands/);
  delete versioned.adapters[0].operations.test.argv;
  versioned.adapters[0].operations.test.commands[0].argv = ['pwsh', '-Command', 'npm test'];
  assert.throws(() => validateAdapterCatalog(versioned), /must not invoke a shell/);
  versioned.adapters[0].operations.test.commands[0].argv = ['C:\\governed\\tool.exe', '--version'];
  assert.throws(() => validateAdapterCatalog(versioned), /must not use an absolute executable path/);
  versioned.adapters[0].operations.test.commands[0].argv = ['/usr/bin/tool', '--version'];
  assert.throws(() => validateAdapterCatalog(versioned), /must not use an absolute executable path/);
  versioned.adapters[0].operations.test.commands[0].argv = ['\\windows-rooted-tool.exe', '--version'];
  assert.throws(() => validateAdapterCatalog(versioned), /must not use an absolute executable path/);
});

test('adapter catalog validation rejects every malformed versioned operation shape', () => {
  for (const malformed of [null, {}, { schemaVersion: '2.0.0', adapters: [] }, { schemaVersion: '1.1.0', adapters: [] }]) {
    assert.throws(() => validateAdapterCatalog(malformed), /supported schemaVersion and adapters/);
  }

  const withTest = definition => {
    const value = clone(catalog);
    value.schemaVersion = '1.1.0';
    value.adapters[0].operations.test = definition;
    return value;
  };
  assert.throws(() => validateAdapterCatalog(withTest({ argv: [] })), /non-empty safe argv/);
  assert.throws(() => validateAdapterCatalog(withTest({ commands: [] })), /non-empty commands/);
  assert.throws(() => validateAdapterCatalog(withTest({ commands: [null] })), /command id is invalid/);
  assert.throws(() => validateAdapterCatalog(withTest({ commands: [{ id: 'unit', argv: ['npm', 'test'], extra: true }] })), /command id is invalid/);
  assert.throws(() => validateAdapterCatalog(withTest({ commands: [
    { id: 'unit', argv: ['npm', 'test'] }, { id: 'unit', argv: ['npm', 'test'] },
  ] })), /duplicate/);
  assert.throws(() => validateAdapterCatalog(withTest({ argv: ['npm', 'test'], extra: true })), /unknown fields/);

  const legacyCommands = withTest({ commands: [{ id: 'unit', argv: ['npm', 'test'] }] });
  legacyCommands.schemaVersion = '1.0.0';
  assert.throws(() => validateAdapterCatalog(legacyCommands), /requires legacy argv/);

  const duplicateUnsupported = clone(catalog);
  duplicateUnsupported.adapters[0].unsupported.push(duplicateUnsupported.adapters[0].unsupported[0]);
  assert.throws(() => validateAdapterCatalog(duplicateUnsupported), /valid unsupported operations/);
  const conflict = clone(catalog);
  conflict.adapters[0].unsupported.push('test');
  assert.throws(() => validateAdapterCatalog(conflict), /cannot support and reject test/);
});

test('component and direct-operation adapter selection fail closed on invalid or ambiguous identities', () => {
  const first = clone(catalog.adapters.find(adapter => adapter.family === 'node'));
  first.id = 'node-npm';
  const second = clone(first); second.id = 'node-bun';
  const versioned = { schemaVersion: '1.1.0', adapters: [first, second] };

  const invalid = selectAdapters({
    catalog: versioned,
    detection: { gaps: [{ code: 'detected-gap' }], components: [{ id: 'web', family: 'node', adapterId: 'missing' }] },
  });
  assert.equal(invalid.status, 'blocked');
  assert.deepEqual(invalid.gaps.map(gap => gap.code), ['detected-gap', 'invalid-component-adapter']);
  assert.equal(planAdapterOperation({ catalog: versioned, family: 'node', adapterId: 'missing', operation: 'test' }).gaps[0].code, 'invalid-component-adapter');
  assert.equal(planAdapterOperation({ catalog: versioned, family: 'node', operation: 'test' }).gaps[0].code, 'ambiguous-stack-adapter');
  assert.throws(() => planAdapterOperation({ catalog, family: 'node', operation: 'unknown' }), /unknown adapter operation/);
});
