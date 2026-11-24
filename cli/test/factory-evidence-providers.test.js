'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { EventEmitter } = require('node:events');

const {
  assertRuntimeSelection, bindEvidenceProviders, executeBuiltinProvider, validateEvidenceBinding, validateProviderCatalog,
} = require('../lib/factory/evidence-providers');
const { assessEvidence } = require('../lib/factory/evidence');
const { runStep } = require('../lib/factory/runner');
const { REDACTION_POLICY_VERSION } = require('../lib/factory/redaction');
const {
  FILESYSTEM_BOUNDARY_VERSION, FILESYSTEM_CAPABILITY_DIGEST,
} = require('../lib/factory/filesystem-boundary');

const root = path.resolve(__dirname, '../..');
const workflow = JSON.parse(fs.readFileSync(path.join(root, 'factory/catalog/workflow.json'), 'utf8'));
const providers = JSON.parse(fs.readFileSync(path.join(root, 'factory/catalog/evidence-providers.json'), 'utf8'));
const adapters = JSON.parse(fs.readFileSync(path.join(root, 'factory/catalog/adapters.json'), 'utf8'));
const catalogDigests = Object.fromEntries([
  'workflow.json', 'evidence-providers.json', 'adapters.json',
].map(name => [name, crypto.createHash('sha256')
  .update(fs.readFileSync(path.join(root, 'factory/catalog', name))).digest('hex')]));

function component(id, componentRoot = '.') {
  return { id, family: 'node', root: componentRoot, evidence: [{ path: `${componentRoot}/package.json` }] };
}

function bind(steps, components = [component('node-root')]) {
  return bindEvidenceProviders({
    workflow, providerCatalog: providers, adapterCatalog: adapters,
    catalogDigests,
    detection: { components, gaps: [] }, steps,
  });
}

function spawnByOperation(failingOperation, calls) {
  return (command, args, options) => {
    calls.push({ command, args, options });
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.kill = () => {};
    process.nextTick(() => child.emit('close', args.includes(failingOperation) ? 1 : 0, null));
    return child;
  };
}

test('provider catalogs create deterministic immutable per-step bindings', () => {
  assert.equal(validateProviderCatalog(providers), true);
  const steps = [
    { id: 'tests', needs: [], gate: null, applicable: true },
    { id: 'security', needs: [], gate: 'security', applicable: true },
  ];
  const first = bind(steps);
  const second = bind(steps);
  assert.deepEqual(first, second);
  assert.deepEqual(first.gaps, []);
  for (const step of first.steps) assert.deepEqual(validateEvidenceBinding(step.evidenceBinding), []);
  const testCommand = first.steps[0].evidenceBinding.commands[0];
  assert.equal(testCommand.launchBinding.logicalExecutable, 'npm');
  assert.match(testCommand.launchBinding.launchDigest, /^[a-f0-9]{64}$/);
  if (process.platform === 'win32') {
    assert.equal(testCommand.launchBinding.kind, 'node-cli');
    assert.equal(testCommand.launchBinding.prefix[0], process.execPath);
    assert.match(testCommand.launchBinding.prefix[1].replaceAll('\\', '/'), /node_modules\/npm\/bin\/npm-cli\.js$/);
  }
  assert.ok(first.steps.every(step => step.evidenceBinding.redactionPolicyVersion === REDACTION_POLICY_VERSION));
  assert.ok(first.steps.every(step => step.evidenceBinding.filesystemBoundaryVersion === FILESYSTEM_BOUNDARY_VERSION));
  assert.ok(first.steps.every(step => step.evidenceBinding.filesystemCapabilityDigest === FILESYSTEM_CAPABILITY_DIGEST));
  assert.notEqual(first.steps[0].evidenceBinding.bindingDigest, first.steps[1].evidenceBinding.bindingDigest);
  const stalePolicy = JSON.parse(JSON.stringify(first.steps[0].evidenceBinding));
  stalePolicy.redactionPolicyVersion = '0.9.0';
  delete stalePolicy.bindingDigest;
  stalePolicy.bindingDigest = require('../lib/factory/hash').hashValue(stalePolicy);
  assert.ok(validateEvidenceBinding(stalePolicy).includes('redaction policy version mismatch'));
  const staleFilesystem = JSON.parse(JSON.stringify(first.steps[0].evidenceBinding));
  staleFilesystem.filesystemCapabilityDigest = 'f'.repeat(64);
  delete staleFilesystem.bindingDigest;
  staleFilesystem.bindingDigest = require('../lib/factory/hash').hashValue(staleFilesystem);
  assert.ok(validateEvidenceBinding(staleFilesystem).includes('filesystem capability digest mismatch'));
  const staleBoundary = JSON.parse(JSON.stringify(first.steps[0].evidenceBinding));
  staleBoundary.filesystemBoundaryVersion = '0.9.0';
  delete staleBoundary.bindingDigest;
  staleBoundary.bindingDigest = require('../lib/factory/hash').hashValue(staleBoundary);
  assert.ok(validateEvidenceBinding(staleBoundary).includes('filesystem boundary version mismatch'));
  assert.throws(
    () => assertRuntimeSelection(first.steps[0].evidenceBinding, ['node', '-e', 'process.exit(0)']),
    /composite evidence providers|does not match/
  );
});

test('credential-bearing adapter commands fail planning without returning the literal', () => {
  const canary = 'provider-secret-canary';
  const unsafeAdapters = JSON.parse(JSON.stringify(adapters));
  unsafeAdapters.adapters.find(adapter => adapter.family === 'node').operations.test.argv = [
    'tool', `--token=${canary}`,
  ];
  assert.throws(() => bindEvidenceProviders({
    workflow, providerCatalog: providers, adapterCatalog: unsafeAdapters,
    catalogDigests,
    detection: { components: [component('node-root')], gaps: [] },
    steps: [{ id: 'tests', needs: [], gate: null, applicable: true }],
  }), error => {
    assert.equal(error.code, 'EVIDENCE_PROVIDER_CREDENTIAL');
    assert.equal(error.message.includes(canary), false);
    return true;
  });
});

test('unavailable or unenrolled non-anchor evidence tools become an explicit path-free planning gap', () => {
  const untrustedAdapters = JSON.parse(JSON.stringify(adapters));
  untrustedAdapters.adapters.find(adapter => adapter.family === 'node').operations.test.argv = [
    'git', '--version',
  ];
  const planned = bindEvidenceProviders({
    workflow, providerCatalog: providers, adapterCatalog: untrustedAdapters,
    catalogDigests, projectRoot: root,
    detection: { components: [component('node-root')], gaps: [] },
    steps: [{ id: 'tests', needs: [], gate: null, applicable: true }],
  });
  assert.ok(planned.gaps.some(gap => ['EVIDENCE_TOOLCHAIN_UNAUTHORIZED', 'EVIDENCE_BINDING_CONTEXT_MISSING'].includes(gap.code)
    && ['governed executable is not authorized', 'governed launch capability is unavailable'].includes(gap.message)
    && !gap.message.includes(root)));
  const binding = planned.steps[0].evidenceBinding;
  assert.equal(binding.targets.find(target => target.id === 'node-root:test')?.kind, 'blocked');
  assert.equal(binding.targets.find(target => target.id === 'node-root:coverage')?.kind, 'command');
  assert.deepEqual(validateEvidenceBinding(binding), []);
  assert.throws(() => assertRuntimeSelection(binding), /BLOCKED_EVIDENCE_TARGET/);
});

test('composite provider runs every component operation and retains child failures', async () => {
  const project = fs.mkdtempSync(path.join(os.tmpdir(), 'factory-provider-'));
  fs.mkdirSync(path.join(project, 'api'));
  fs.writeFileSync(path.join(project, 'package.json'), '{}');
  fs.writeFileSync(path.join(project, 'api/package.json'), '{}');
  const planned = bind(
    [{ id: 'tests', needs: [], gate: null, applicable: true }],
    [component('node-api', 'api'), component('node-root')]
  );
  const step = planned.steps[0];
  const calls = [];
  let index = 0;
  const spawnImpl = (command, args, options) => {
    calls.push({ command, args, options });
    const child = new EventEmitter();
    child.stdout = new EventEmitter(); child.stderr = new EventEmitter(); child.kill = () => {};
    const code = index++ === 1 ? 1 : 0;
    process.nextTick(() => child.emit('close', code, null));
    return child;
  };
  const identity = () => ({ sourceTreeHash: 'a'.repeat(64), certificationIdentityDigest: 'b'.repeat(64), layoutInputDigest: 'c'.repeat(64) });
  const evidence = await runStep(step, { root: project, planHash: 'plan', spawnImpl, certificationIdentityFn: identity });
  assert.equal(calls.length, 4);
  if (process.platform === 'win32') {
    assert.ok(calls.every(call => call.command === process.execPath));
    assert.ok(calls.every(call => /npm-cli\.js$/.test(call.args[0])));
    assert.ok(calls.every(call => call.options.shell === false));
  }
  assert.equal(evidence.components.length, 4);
  assert.equal(evidence.components.filter(child => child.status === 'FAIL').length, 1);
  assert.equal(evidence.status, 'FAIL');
  assert.match(evidence.componentAggregateHash, /^[a-f0-9]{64}$/);
});

test('conditional N/A never spawns and cross-step evidence replay is stale', async () => {
  const planned = bind([
    { id: 'browser-e2e', needs: [], gate: 'browser-e2e', applicable: false, naReason: 'policy does not require browser-e2e' },
    { id: 'tests', needs: [], gate: null, applicable: true },
    { id: 'security', needs: [], gate: 'security', applicable: true },
  ]);
  let spawned = false;
  const identity = () => ({ sourceTreeHash: 'a'.repeat(64), certificationIdentityDigest: 'b'.repeat(64), layoutInputDigest: 'c'.repeat(64) });
  const na = await runStep(planned.steps[0], {
    root, planHash: 'plan', certificationIdentityFn: identity,
    spawnImpl: () => { spawned = true; throw new Error('must not spawn'); },
  });
  assert.equal(na.status, 'NA');
  assert.equal(spawned, false);

  const calls = [];
  const tests = await runStep(planned.steps[1], {
    root, planHash: 'plan', certificationIdentityFn: identity, spawnImpl: spawnByOperation('never', calls),
  });
  const securityBinding = planned.steps[2].evidenceBinding;
  const replay = assessEvidence(tests, {
    sourceTreeHash: tests.sourceTreeHash, certificationIdentityDigest: tests.certificationIdentityDigest,
    planHash: 'plan', requireBinding: true, providerId: securityBinding.providerId,
    bindingDigest: securityBinding.bindingDigest, now: new Date(tests.finishedAt),
  });
  assert.equal(replay.fresh, false);
  assert.ok(replay.reasons.includes('provider identity mismatch'));
  assert.ok(replay.reasons.includes('evidence binding digest mismatch'));
});

function v11TargetFixture(operations) {
  const npm = JSON.parse(JSON.stringify(adapters.adapters.find(adapter => adapter.family === 'node')));
  npm.id = 'node-npm';
  npm.operations.test = { commands: [
    { id: 'unit', argv: ['node', '--version'], timeoutMs: 1200000 },
    { id: 'integration', argv: ['node', '--version'], timeoutMs: 2400000 },
  ] };
  const limited = JSON.parse(JSON.stringify(npm));
  limited.id = 'node-limited';
  delete limited.operations.e2e;
  limited.unsupported = [...new Set([...limited.unsupported, 'e2e'])];
  return bindEvidenceProviders({
    workflow: { steps: [{ id: 'tests', evidenceProvider: 'adapter-tests' }] },
    providerCatalog: {
      schemaVersion: '1.1.0', providers: [{ id: 'adapter-tests', kind: 'composite', operations }],
    },
    adapterCatalog: { schemaVersion: '1.1.0', adapters: [npm, limited] },
    catalogDigests,
    detection: { components: [
      { ...component('web'), adapterId: 'node-npm' },
      { ...component('worker', 'worker'), adapterId: 'node-limited' },
    ], gaps: [] },
    steps: [{ id: 'tests', needs: [], gate: null, applicable: true }],
  });
}

test('v1.1 composite bindings scope exact pairs and record neutral auditable N/A children', async () => {
  const planned = v11TargetFixture([
    { name: 'test', selector: { componentIds: ['web'] } },
    {
      name: 'e2e', selector: { componentIds: ['worker'] },
      notApplicable: [{ componentId: 'worker', reasonCode: 'NO_BROWSER_SURFACE', reason: 'Worker has no browser surface' }],
    },
  ]);
  assert.deepEqual(planned.gaps, []);
  const binding = planned.steps[0].evidenceBinding;
  assert.equal(binding.schemaVersion, '1.1.0');
  assert.deepEqual(binding.targets.map(target => [target.id, target.kind]), [
    ['web:test', 'command'], ['worker:e2e', 'na'],
  ]);
  assert.deepEqual(binding.commands.map(command => command.id), [
    'web:test:unit', 'web:test:integration',
  ]);
  assert.deepEqual(binding.commands.map(command => command.timeoutMs), [1200000, 2400000]);
  assert.match(binding.targetAggregateHash, /^[a-f0-9]{64}$/);
  assert.deepEqual(validateEvidenceBinding(binding), []);

  const calls = [];
  const identity = () => ({ sourceTreeHash: 'a'.repeat(64), certificationIdentityDigest: 'b'.repeat(64), layoutInputDigest: 'c'.repeat(64) });
  const evidence = await runStep(planned.steps[0], {
    root, planHash: 'plan', spawnImpl: spawnByOperation('never', calls), certificationIdentityFn: identity,
  });
  assert.equal(evidence.schemaVersion, 2);
  assert.equal(calls.length, 2);
  assert.deepEqual(evidence.components.map(child => child.status), ['PASS', 'PASS', 'NA']);
  assert.equal(evidence.components[2].reasonCode, 'NO_BROWSER_SURFACE');
  assert.equal(evidence.status, 'PASS');
  assert.deepEqual(evidence.command.commands, binding.commands);
  const assessment = assessEvidence(evidence, {
    sourceTreeHash: evidence.sourceTreeHash, certificationIdentityDigest: evidence.certificationIdentityDigest,
    planHash: 'plan', requireBinding: true, providerId: binding.providerId,
    bindingDigest: binding.bindingDigest, commandHash: binding.targetAggregateHash,
    evidenceBinding: binding, now: new Date(evidence.finishedAt),
  });
  assert.deepEqual(assessment.reasons, []);
});

test('v1.1 selected unsupported pairs require exact N/A and supported pairs reject N/A claims', () => {
  const unsupported = v11TargetFixture([
    { name: 'e2e', selector: { componentIds: ['worker'] } },
  ]);
  assert.ok(unsupported.gaps.some(gap => gap.code === 'EVIDENCE_OPERATION_UNSUPPORTED'));
  const conflict = v11TargetFixture([{
    name: 'e2e', selector: { componentIds: ['web'] },
    notApplicable: [{ componentId: 'web', reasonCode: 'CLAIMED_NA', reason: 'Claimed not applicable' }],
  }]);
  assert.ok(conflict.gaps.some(gap => gap.code === 'EVIDENCE_NA_CONFLICT'));
  const oversizedReason = {
    schemaVersion: '1.1.0',
    providers: [{
      id: 'oversized-na', kind: 'composite', operations: [{
        name: 'test', selector: { componentIds: ['web'] },
        notApplicable: [{ componentId: 'web', reasonCode: 'TOO_LONG', reason: 'x'.repeat(501) }],
      }],
    }],
  };
  assert.throws(() => validateProviderCatalog(oversizedReason), /notApplicable target is invalid/);
  const empty = v11TargetFixture([
    { name: 'test', selector: { componentIds: ['missing'] } },
  ]);
  assert.ok(empty.gaps.some(gap => gap.code === 'EVIDENCE_COMPONENT_MISSING'));
  assert.ok(empty.gaps.some(gap => gap.code === 'EVIDENCE_PROVIDER_EMPTY_SELECTION'));
});

test('current binding validation rejects resealed 1.0 bindings as stale', () => {
  const planned = v11TargetFixture([{ name: 'test', selector: { componentIds: ['web'] } }]);
  const stale = JSON.parse(JSON.stringify(planned.steps[0].evidenceBinding));
  stale.schemaVersion = '1.0.0';
  delete stale.bindingDigest;
  stale.bindingDigest = require('../lib/factory/hash').hashValue(stale);
  assert.ok(validateEvidenceBinding(stale).includes('unsupported evidence binding version'));
});

test('provider catalog validation rejects malformed legacy and exact-target declarations', () => {
  for (const malformed of [null, {}, { schemaVersion: '2.0.0', providers: [] }, { schemaVersion: '1.1.0', providers: [] }]) {
    assert.throws(() => validateProviderCatalog(malformed), /supported schemaVersion and providers/);
  }
  assert.throws(() => validateProviderCatalog({ schemaVersion: '1.0.0', providers: [null] }), /invalid or duplicate/);
  assert.throws(() => validateProviderCatalog({ schemaVersion: '1.0.0', providers: [
    { id: 'same', kind: 'builtin', operation: 'one' }, { id: 'same', kind: 'builtin', operation: 'two' },
  ] }), /invalid or duplicate/);
  assert.throws(() => validateProviderCatalog({ schemaVersion: '1.0.0', providers: [{ id: 'bad', kind: 'other' }] }), /invalid kind/);
  assert.throws(() => validateProviderCatalog({ schemaVersion: '1.0.0', providers: [{ id: 'bad', kind: 'builtin', operation: 'run', operations: [] }] }), /requires one operation/);
  assert.throws(() => validateProviderCatalog({ schemaVersion: '1.0.0', providers: [{ id: 'bad', kind: 'composite', operations: [] }] }), /requires operations/);
  assert.throws(() => validateProviderCatalog({ schemaVersion: '1.0.0', providers: [{ id: 'bad', kind: 'composite', operations: ['test', 'test'] }] }), /unique operations/);

  const exact = operation => ({ schemaVersion: '1.1.0', providers: [{ id: 'exact', kind: 'composite', operations: [operation] }] });
  assert.throws(() => validateProviderCatalog(exact({ name: 'test', selector: { componentIds: [] } })), /selector is invalid/);
  assert.throws(() => validateProviderCatalog(exact({ name: 'test', selector: { componentIds: ['web'] }, notApplicable: {} })), /must be an array/);
  assert.throws(() => validateProviderCatalog(exact({ name: 'test', selector: { componentIds: ['web'] }, notApplicable: [{ componentId: 'other', reasonCode: 'NA', reason: 'No target' }] })), /target is invalid/);
  assert.throws(() => validateProviderCatalog({ schemaVersion: '1.1.0', providers: [{
    id: 'exact', kind: 'composite', operations: [
      { name: 'test', selector: { componentIds: ['web'] } },
      { name: 'test', selector: { componentIds: ['web'] } },
    ],
  }] }), /duplicate target/);
});

test('binding reports unbound, ambiguous, mismatched, mutating and missing-context targets', () => {
  const npm = JSON.parse(JSON.stringify(adapters.adapters.find(adapter => adapter.family === 'node')));
  npm.id = 'node-npm';
  const bun = JSON.parse(JSON.stringify(npm)); bun.id = 'node-bun';
  const mutating = JSON.parse(JSON.stringify(npm));
  mutating.id = 'node-mutating';
  mutating.operations.test.authority = 'dependencyInstall';
  const missingContext = JSON.parse(JSON.stringify(npm));
  missingContext.id = 'node-context';
  missingContext.operations.test.argv = ['node', '${rockspec}'];
  const providerCatalog = { schemaVersion: '1.1.0', providers: [{
    id: 'adapter-tests', kind: 'composite', operations: [{
      name: 'test', selector: { componentIds: ['ambiguous', 'mismatch', 'mutating', 'context', 'missing'] },
    }],
  }] };
  const planned = bindEvidenceProviders({
    workflow: { steps: [
      { id: 'tests', evidenceProvider: 'adapter-tests' },
      { id: 'unbound', evidenceProvider: 'not-present' },
      { id: 'skipped', evidenceProvider: 'adapter-tests' },
      { id: 'builtin', evidenceProvider: 'builtin-trace' },
    ] },
    providerCatalog: { ...providerCatalog, providers: [
      ...providerCatalog.providers, { id: 'builtin-trace', kind: 'builtin', operation: 'traceability' },
    ] },
    adapterCatalog: { schemaVersion: '1.1.0', adapters: [npm, bun, mutating, missingContext] },
    catalogDigests,
    detection: { components: [
      component('ambiguous'),
      { ...component('mismatch'), family: 'python', adapterId: 'node-npm' },
      { ...component('mutating'), adapterId: 'node-mutating' },
      { ...component('context'), adapterId: 'node-context' },
    ] },
    steps: [
      { id: 'tests', applicable: true },
      { id: 'unbound', applicable: true },
      { id: 'skipped', applicable: false, naReason: 'not applicable' },
      { id: 'builtin', applicable: true },
    ],
  });
  const codes = planned.gaps.map(gap => gap.code);
  for (const code of ['UNBOUND_WORKFLOW_STEP', 'EVIDENCE_ADAPTER_AMBIGUOUS', 'EVIDENCE_ADAPTER_MISSING', 'EVIDENCE_PROVIDER_MUTATING', 'EVIDENCE_BINDING_CONTEXT_MISSING', 'EVIDENCE_COMPONENT_MISSING']) {
    assert.ok(codes.includes(code), code);
  }
  assert.equal(planned.steps.find(step => step.id === 'skipped').evidenceBinding.kind, 'na');
  assert.equal(planned.steps.find(step => step.id === 'builtin').evidenceBinding.kind, 'builtin');
});

test('binding rejects malformed catalog digests and expands a present rockspec placeholder', () => {
  assert.throws(() => bindEvidenceProviders({
    workflow, providerCatalog: providers, adapterCatalog: adapters,
    catalogDigests: { adapters: 'not-a-digest' },
    detection: { components: [component('node-root')], gaps: [] },
    steps: [{ id: 'tests', applicable: true }],
  }), /governed catalog content digests are required/);

  const rockspecAdapters = JSON.parse(JSON.stringify(adapters));
  rockspecAdapters.adapters.find(adapter => adapter.family === 'node').operations.test.argv = [
    'node', '${rockspec}',
  ];
  const planned = bindEvidenceProviders({
    workflow, providerCatalog: providers, adapterCatalog: rockspecAdapters,
    catalogDigests,
    detection: { components: [{
      ...component('node-root'), evidence: [{ path: 'packages/example.rockspec' }],
    }], gaps: [] },
    steps: [{ id: 'tests', applicable: true }],
  });
  const command = planned.steps[0].evidenceBinding.commands
    .find(item => item.targetId === 'node-root:test');
  assert.deepEqual(command.argv, ['node', 'packages/example.rockspec']);
});

test('projectRoot context binds and spawns the canonical absolute component root without authored machine paths', async t => {
  const project = fs.mkdtempSync(path.join(os.tmpdir(), 'factory-project-root-'));
  t.after(() => fs.rmSync(project, { recursive: true, force: true }));
  const componentRoot = path.join(project, 'preview-client');
  fs.mkdirSync(componentRoot);
  fs.writeFileSync(path.join(componentRoot, 'package.json'), '{}');

  const adapter = JSON.parse(JSON.stringify(adapters.adapters.find(item => item.family === 'node')));
  adapter.id = 'unity-project-root-fixture';
  adapter.family = 'unity';
  adapter.operations.test = {
    argv: ['node', '-batchmode', '-projectPath', '${projectRoot}', '-runTests'],
  };
  const adapterCatalog = { schemaVersion: '1.1.0', adapters: [adapter] };
  const providerCatalog = {
    schemaVersion: '1.1.0',
    providers: [{
      id: 'adapter-tests', kind: 'composite',
      operations: [{ name: 'test', selector: { componentIds: ['unity-preview'] } }],
    }],
  };
  const bindProject = projectRoot => bindEvidenceProviders({
    workflow: { steps: [{ id: 'tests', evidenceProvider: 'adapter-tests' }] },
    providerCatalog, adapterCatalog, catalogDigests, projectRoot,
    detection: { components: [{ id: 'unity-preview', family: 'unity', root: 'preview-client' }], gaps: [] },
    steps: [{ id: 'tests', needs: [], gate: null, applicable: true }],
  });
  const planned = bindProject(project);
  assert.deepEqual(planned.gaps, []);
  const step = planned.steps[0];
  const command = step.evidenceBinding.commands[0];
  const canonical = fs.realpathSync.native(componentRoot);
  assert.equal(command.argv[command.argv.indexOf('-projectPath') + 1], canonical);
  assert.equal(path.isAbsolute(command.argv[command.argv.indexOf('-projectPath') + 1]), true);
  assert.equal(JSON.stringify(adapter).includes(canonical), false);
  assert.equal(JSON.stringify(adapter).includes('${projectRoot}'), true);
  assert.deepEqual(validateEvidenceBinding(step.evidenceBinding), []);

  const relocated = fs.mkdtempSync(path.join(os.tmpdir(), 'factory-project-root-relocated-'));
  t.after(() => fs.rmSync(relocated, { recursive: true, force: true }));
  fs.mkdirSync(path.join(relocated, 'preview-client'));
  const relocatedBinding = bindProject(relocated).steps[0].evidenceBinding;
  assert.notEqual(relocatedBinding.commands[0].commandHash, command.commandHash);
  assert.notEqual(relocatedBinding.bindingDigest, step.evidenceBinding.bindingDigest);

  const calls = [];
  const identity = () => ({
    sourceTreeHash: 'a'.repeat(64), certificationIdentityDigest: 'b'.repeat(64),
    layoutInputDigest: 'c'.repeat(64),
  });
  const evidence = await runStep(step, {
    root: project, planHash: 'plan', certificationIdentityFn: identity,
    spawnImpl: spawnByOperation('never', calls),
  });
  assert.equal(evidence.status, 'PASS');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].args[calls[0].args.indexOf('-projectPath') + 1], canonical);
  assert.equal(calls[0].options.cwd, canonical);
  assert.equal(calls[0].options.shell, false);

  const tampered = JSON.parse(JSON.stringify(step.evidenceBinding));
  tampered.commands[0].argv[tampered.commands[0].argv.indexOf('-projectPath') + 1] = path.dirname(canonical);
  assert.ok(validateEvidenceBinding(tampered).some(issue =>
    issue.includes('launch binding') || issue.includes('command hash mismatch') || issue.includes('binding digest mismatch')));
});

test('projectRoot context fails closed when missing, unsafe, or outside the repository boundary', () => {
  const adapter = JSON.parse(JSON.stringify(adapters.adapters.find(item => item.family === 'node')));
  adapter.id = 'node-project-root';
  adapter.operations.test = { argv: ['node', '${projectRoot}'] };
  const request = (projectRoot, componentRoot = '.') => bindEvidenceProviders({
    workflow: { steps: [{ id: 'tests', evidenceProvider: 'adapter-tests' }] },
    providerCatalog: {
      schemaVersion: '1.1.0', providers: [{
        id: 'adapter-tests', kind: 'composite',
        operations: [{ name: 'test', selector: { componentIds: ['subject'] } }],
      }],
    },
    adapterCatalog: { schemaVersion: '1.1.0', adapters: [adapter] },
    catalogDigests, ...(projectRoot === undefined ? {} : { projectRoot }),
    detection: { components: [{ id: 'subject', family: 'node', root: componentRoot }], gaps: [] },
    steps: [{ id: 'tests', applicable: true }],
  });
  for (const planned of [request(undefined), request(`${root}\nunsafe`), request(root, '..')]) {
    assert.equal(planned.steps[0].evidenceBinding.targets[0].kind, 'blocked');
    assert.ok(planned.gaps.some(gap => gap.code === 'EVIDENCE_BINDING_CONTEXT_MISSING'));
    assert.equal(planned.gaps.some(gap => gap.message.includes(`${root}\nunsafe`)), false);
  }
});

test('binding validation detects target, command, aggregate and runtime mutations', () => {
  const original = v11TargetFixture([{ name: 'test', selector: { componentIds: ['web'] } }]).steps[0].evidenceBinding;
  const hashValue = require('../lib/factory/hash').hashValue;
  const reseal = mutate => {
    const value = JSON.parse(JSON.stringify(original));
    mutate(value);
    value.targetAggregateHash = hashValue(value.targets || []);
    value.commandAggregateHash = hashValue((value.commands || []).map(command => command.commandHash));
    delete value.bindingDigest;
    value.bindingDigest = hashValue(value);
    return value;
  };
  assert.ok(validateEvidenceBinding(reseal(value => { value.targets[0].reason = 'unexpected'; })).some(issue => issue.includes('command target fields are invalid')));
  assert.ok(validateEvidenceBinding(reseal(value => { value.targets[0].commandIds = []; })).some(issue => issue.includes('has no commands')));
  assert.ok(validateEvidenceBinding(reseal(value => {
    value.targets[0] = {
      id: 'web:test', componentId: 'web', adapterId: 'node-npm', operation: 'test',
      kind: 'na', reasonCode: 'bad-code', reason: '', extra: true,
    };
  })).some(issue => issue.includes('N/A target reason is invalid')));
  assert.ok(validateEvidenceBinding(reseal(value => { value.commands[0].targetId = 'missing:test'; })).some(issue => issue.includes('target is missing')));
  assert.ok(validateEvidenceBinding(reseal(value => { value.commands[0].requiredAuthority = 'deploy'; })).some(issue => issue.includes('authority is invalid')));
  assert.ok(validateEvidenceBinding(reseal(value => { value.commands[0].timeoutMs = 999; })).some(issue => issue.includes('timeout is invalid')));
  assert.ok(validateEvidenceBinding(reseal(value => { value.commands[0].timeoutMs = 1800000; })).some(issue => issue.includes('command hash mismatch')));
  assert.ok(validateEvidenceBinding(reseal(value => { value.commands.reverse(); })).includes('binding flattened command order mismatch'));

  const blocked = bindEvidenceProviders({
    workflow: { steps: [{ id: 'tests', evidenceProvider: 'adapter-tests' }] },
    providerCatalog: { schemaVersion: '1.1.0', providers: [{ id: 'adapter-tests', kind: 'composite', operations: [{ name: 'test', selector: { componentIds: ['web'] } }] }] },
    adapterCatalog: { schemaVersion: '1.1.0', adapters: [{ ...JSON.parse(JSON.stringify(adapters.adapters.find(adapter => adapter.family === 'node'))), id: 'node-context', operations: { ...JSON.parse(JSON.stringify(adapters.adapters.find(adapter => adapter.family === 'node').operations)), test: { argv: ['node', '${rockspec}'] } } }] },
    catalogDigests, detection: { components: [{ ...component('web'), adapterId: 'node-context' }] },
    steps: [{ id: 'tests', applicable: true }],
  }).steps[0].evidenceBinding;
  assert.throws(() => assertRuntimeSelection(blocked), /BLOCKED_EVIDENCE_TARGET/);
});

test('builtin evidence routes cover lineage, catalogs, supply chain, docs and explicit fallback', { skip: 'needs the full private monorepo (child registry, skill canon)' }, () => {
  assert.deepEqual(executeBuiltinProvider('custom', { providerExecutors: { custom: () => ({ status: 'PASS' }) } }), { status: 'PASS' });
  assert.ok(['PASS', 'FAIL'].includes(executeBuiltinProvider('manifest-intent', { root }).status));
  const integrityBinding = v11TargetFixture([{ name: 'test', selector: { componentIds: ['web'] } }]).steps[0].evidenceBinding;
  assert.deepEqual(executeBuiltinProvider('plan-binding-integrity', {
    root, plan: { steps: [{ id: 'tests', needs: [], evidenceBinding: integrityBinding }] },
  }), { status: 'PASS' });
  const staleBinding = JSON.parse(JSON.stringify(integrityBinding));
  staleBinding.bindingDigest = '0'.repeat(64);
  assert.equal(executeBuiltinProvider('plan-binding-integrity', {
    root, plan: { steps: [{ id: 'tests', needs: [], evidenceBinding: staleBinding }] },
  }).status, 'FAIL');
  for (const operation of [
    'architecture-lineage', 'implementation-lineage', 'test-contract-lineage', 'api-contract-lineage',
    'traceability', 'workforce', 'adapter-selection', 'trust', 'supply-chain', 'docs-parity',
  ]) {
    assert.ok(['PASS', 'FAIL'].includes(executeBuiltinProvider(operation, { root, plan: { steps: [], detection: { components: [], gaps: [] } } }).status), operation);
  }
  assert.deepEqual(executeBuiltinProvider('supply-chain', { root }), { status: 'PASS' });
  assert.deepEqual(executeBuiltinProvider('not-implemented', { root }), {
    status: 'FAIL', reason: 'provider executor is required: not-implemented',
  });
});

test('docs parity resolves one required manifest-owned child knowledge root and fails closed', () => {
  const project = fs.mkdtempSync(path.join(os.tmpdir(), 'factory-provider-docs-'));
  fs.mkdirSync(path.join(project, 'factory'), { recursive: true });
  const manifest = JSON.parse(fs.readFileSync(path.join(root, 'factory/project.json'), 'utf8'));
  manifest.project.id = 'docs-child';
  manifest.sources = [{ id: 'knowledge', kind: 'docs', location: '_project', required: true }];
  fs.writeFileSync(path.join(project, 'factory/project.json'), JSON.stringify(manifest));
  for (const file of [
    'docs/app-architecture/ARCHITECTURE.md', 'docs/operations/MEMORY.md', 'tasks/CURRENT_SPRINT.md',
  ]) {
    fs.mkdirSync(path.dirname(path.join(project, '_project', file)), { recursive: true });
    fs.writeFileSync(path.join(project, '_project', file), 'present\n');
  }
  assert.deepEqual(executeBuiltinProvider('docs-parity', { root: project }), { status: 'PASS' });
  fs.rmSync(path.join(project, '_project/tasks/CURRENT_SPRINT.md'));
  assert.match(executeBuiltinProvider('docs-parity', { root: project }).reason, /CURRENT_SPRINT/);
  manifest.sources.push({ id: 'second-docs', kind: 'docs', location: 'other', required: true });
  fs.writeFileSync(path.join(project, 'factory/project.json'), JSON.stringify(manifest));
  assert.match(executeBuiltinProvider('docs-parity', { root: project }).reason, /ambiguous/);
});
