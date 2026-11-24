const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  hashTree, hashValue, isCityFabricBase, isGeneratedSkillMirrorPath, isLocalChildPath,
} = require('../lib/factory/hash');
const {
  createEvidence, assessEvidence, validateEvidence, validateEvidenceReceipt,
} = require('../lib/factory/evidence');
const {
  FILESYSTEM_BOUNDARY_VERSION, FILESYSTEM_CAPABILITY_DIGEST,
} = require('../lib/factory/filesystem-boundary');
const { REDACTION_POLICY_VERSION } = require('../lib/factory/redaction');
const { createLaunchBinding } = require('../lib/factory/launcher');

test('hashTree is deterministic, ignores local run state, and changes with source', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'factory-hash-'));
  fs.writeFileSync(path.join(root, 'source.js'), 'one');
  const first = hashTree(root);
  fs.mkdirSync(path.join(root, '.factory'), { recursive: true });
  fs.writeFileSync(path.join(root, '.factory', 'state.json'), 'volatile');
  assert.equal(hashTree(root), first);
  fs.mkdirSync(path.join(root, '.claude', 'state'), { recursive: true });
  fs.writeFileSync(path.join(root, '.claude', 'state', 'quality.json'), 'volatile');
  assert.equal(hashTree(root), first);
  fs.mkdirSync(path.join(root, 'docs', 'operations'), { recursive: true });
  fs.writeFileSync(path.join(root, 'docs', 'operations', 'MEMORY.md'), 'curated memory is source');
  const withMemory = hashTree(root);
  assert.notEqual(withMemory, first);
  fs.rmSync(path.join(root, 'docs', 'operations', 'MEMORY.md'));
  fs.mkdirSync(path.join(root, 'nested'), { recursive: true });
  fs.writeFileSync(path.join(root, 'nested', '.coverage'), 'generated coverage state');
  assert.equal(hashTree(root), first);
  fs.writeFileSync(path.join(root, 'source.js'), 'two');
  assert.notEqual(hashTree(root), first);
});

test('hashTree ignores nested Unity and conventional build state while tracking authored siblings', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'factory-composite-hash-'));
  const unity = path.join(root, 'apps', 'mobile');
  fs.mkdirSync(path.join(unity, 'ProjectSettings'), { recursive: true });
  fs.mkdirSync(path.join(unity, 'Assets'), { recursive: true });
  fs.mkdirSync(path.join(unity, 'Library', 'Bee'), { recursive: true });
  fs.mkdirSync(path.join(root, 'backend', 'build', 'classes'), { recursive: true });
  fs.mkdirSync(path.join(root, 'backend', 'src'), { recursive: true });
  fs.writeFileSync(path.join(unity, 'ProjectSettings', 'ProjectVersion.txt'), 'm_EditorVersion: 6000.5.9f1\n');
  fs.writeFileSync(path.join(unity, 'Assets', 'Game.cs'), 'one');
  fs.writeFileSync(path.join(unity, 'Library', 'Bee', 'generated.dll'), 'generated-one');
  fs.writeFileSync(path.join(root, 'backend', 'build', 'classes', 'generated.class'), 'generated-one');
  fs.writeFileSync(path.join(root, 'backend', 'src', 'App.kt'), 'one');

  const first = hashTree(root);
  fs.writeFileSync(path.join(unity, 'Library', 'Bee', 'generated.dll'), 'generated-two');
  fs.writeFileSync(path.join(root, 'backend', 'build', 'classes', 'generated.class'), 'generated-two');
  assert.equal(hashTree(root), first);
  fs.writeFileSync(path.join(unity, 'Assets', 'Game.cs'), 'two');
  assert.notEqual(hashTree(root), first);
});

test('hashTree ignores child application repositories but tracks registry and child knowledge', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'factory-child-hash-'));
  const registry = path.join(root, 'app_entry_root', '_registry');
  const knowledge = path.join(root, 'app_entry_root', 'worlio', '_project');
  const checkout = path.join(root, 'app_entry_root', 'worlio', 'preview-client', 'Library', 'Bee');
  fs.mkdirSync(registry, { recursive: true });
  fs.mkdirSync(knowledge, { recursive: true });
  fs.mkdirSync(checkout, { recursive: true });
  fs.writeFileSync(path.join(registry, 'registry.json'), '{"projects":[]}');
  fs.writeFileSync(path.join(knowledge, 'MEMORY.md'), 'knowledge-one');
  fs.writeFileSync(path.join(checkout, 'volatile.dll'), 'build-one');

  const first = hashTree(root);
  fs.writeFileSync(path.join(checkout, 'volatile.dll'), 'build-two');
  assert.equal(hashTree(root), first);

  fs.writeFileSync(path.join(knowledge, 'MEMORY.md'), 'knowledge-two');
  const withKnowledgeChange = hashTree(root);
  assert.notEqual(withKnowledgeChange, first);

  fs.writeFileSync(path.join(registry, 'registry.json'), '{"projects":["worlio"]}');
  assert.notEqual(hashTree(root), withKnowledgeChange);
  assert.equal(isLocalChildPath('app_entry_root/worlio/preview-client/Library/Bee'), true);
  assert.equal(isLocalChildPath('app_entry_root/worlio/_project/MEMORY.md'), false);
  assert.equal(isLocalChildPath('app_entry_root/worlio/worlio-v1/README.md'), true);
  assert.equal(isLocalChildPath('app_entry_root/README.md'), false);
  assert.equal(isLocalChildPath('app_entry_root/_registry/registry.json'), false);
  assert.equal(isCityFabricBase(root), true);
});

test('hashTree tracks canonical skills and ignores generated skill mirrors in City Fabric', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'factory-skill-mirror-hash-'));
  fs.mkdirSync(path.join(root, 'app_entry_root', '_registry'), { recursive: true });
  fs.mkdirSync(path.join(root, 'skills', 'sample'), { recursive: true });
  fs.mkdirSync(path.join(root, '.agents', 'skills', 'sample'), { recursive: true });
  fs.mkdirSync(path.join(root, '.claude', 'skills', 'sample'), { recursive: true });
  fs.writeFileSync(path.join(root, 'app_entry_root', '_registry', 'registry.json'), '{"projects":[]}');
  fs.writeFileSync(path.join(root, 'skills', 'sample', 'SKILL.md'), 'canonical-one');
  fs.writeFileSync(path.join(root, '.agents', 'skills', 'sample', 'SKILL.md'), 'mirror-one');
  fs.writeFileSync(path.join(root, '.claude', 'skills', 'sample', 'SKILL.md'), 'mirror-one');
  const first = hashTree(root);
  fs.writeFileSync(path.join(root, '.agents', 'skills', 'sample', 'SKILL.md'), 'mirror-two');
  fs.writeFileSync(path.join(root, '.claude', 'skills', 'sample', 'SKILL.md'), 'mirror-two');
  assert.equal(hashTree(root), first);
  fs.writeFileSync(path.join(root, 'skills', 'sample', 'SKILL.md'), 'canonical-two');
  assert.notEqual(hashTree(root), first);
  assert.equal(isGeneratedSkillMirrorPath('.agents/skills/sample/SKILL.md'), true);
  assert.equal(isGeneratedSkillMirrorPath('skills/sample/SKILL.md'), false);
});

test('hashTree does not hide a similarly named application directory outside City Fabric', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ordinary-app-entry-'));
  const application = path.join(root, 'app_entry_root', 'ordinary', 'client');
  fs.mkdirSync(application, { recursive: true });
  fs.writeFileSync(path.join(application, 'source.js'), 'one');
  const first = hashTree(root);
  fs.writeFileSync(path.join(application, 'source.js'), 'two');
  assert.notEqual(hashTree(root), first);
  assert.equal(isCityFabricBase(root), false);
});

test('hashTree records a symlink identity without following its target', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'factory-hash-link-'));
  const target = fs.mkdtempSync(path.join(os.tmpdir(), 'factory-hash-link-target-'));
  fs.writeFileSync(path.join(target, 'outside.txt'), 'outside-one');
  try { fs.symlinkSync(target, path.join(root, 'linked'), 'junction'); } catch { return; }
  const first = hashTree(root);
  fs.writeFileSync(path.join(target, 'outside.txt'), 'outside-two');
  assert.equal(hashTree(root), first);
  assert.match(first, /^[a-f0-9]{64}$/);
});

test('fresh PASS evidence is accepted and tree/plan/expiry/tampering are rejected', () => {
  const evidence = createEvidence({
    stepId: 'tests', attempt: 1, status: 'PASS', sourceTreeHash: 'tree-a',
    certificationIdentityDigest: 'identity-a',
    planHash: 'plan-a', commandHash: 'cmd-a', startedAt: '2026-01-01T00:00:00.000Z',
    finishedAt: '2026-01-01T00:00:01.000Z', expiresAt: '2026-01-02T00:00:00.000Z',
    exitCode: 0,
  });
  const context = {
    sourceTreeHash: 'tree-a', certificationIdentityDigest: 'identity-a',
    planHash: 'plan-a', now: new Date('2026-01-01T01:00:00.000Z'),
  };
  assert.equal(assessEvidence(evidence, context).fresh, true);
  assert.match(assessEvidence(evidence, { ...context, sourceTreeHash: 'tree-b' }).reasons[0], /tree/);
  assert.match(assessEvidence(evidence, { ...context, certificationIdentityDigest: 'identity-b' }).reasons[0], /certification identity/);
  assert.match(assessEvidence(evidence, { ...context, planHash: 'plan-b' }).reasons[0], /plan/);
  assert.match(assessEvidence(evidence, { ...context, now: new Date('2026-02-01') }).reasons[0], /expired/);
  assert.match(assessEvidence({ ...evidence, status: 'FAIL' }, context).reasons[0], /digest/);
});

test('historical evidence without a contextual identity is stale for current certification', () => {
  const evidence = createEvidence({ stepId: 'tests', attempt: 1, status: 'PASS', sourceTreeHash: 'tree-a' });
  const result = assessEvidence(evidence, {
    sourceTreeHash: 'tree-a', certificationIdentityDigest: 'identity-a',
  });
  assert.equal(result.fresh, false);
  assert.ok(result.reasons.includes('certification identity digest mismatch'));
});

test('historical command evidence without provider binding is untrusted in current mode', () => {
  const evidence = createEvidence({
    stepId: 'tests', attempt: 1, status: 'PASS', sourceTreeHash: 'tree-a',
    certificationIdentityDigest: 'identity-a', planHash: 'plan-a', commandHash: 'command-a',
  });
  const result = assessEvidence(evidence, {
    sourceTreeHash: 'tree-a', certificationIdentityDigest: 'identity-a', planHash: 'plan-a',
    requireBinding: true, providerId: 'adapter-tests', bindingDigest: 'b'.repeat(64),
  });
  assert.equal(result.fresh, false);
  assert.ok(result.reasons.includes('UNTRUSTED_LEGACY_COMMAND'));
});

test('imported sensitive or policy-version-mismatched evidence is rejected without rewriting', () => {
  const base = createEvidence({
    stepId: 'tests', attempt: 1, status: 'PASS', sourceTreeHash: 'tree-a',
    certificationIdentityDigest: 'identity-a', planHash: 'plan-a', commandHash: 'command-a',
  });
  function reseal(fields) {
    const imported = { ...base, ...fields };
    delete imported.digest;
    imported.digest = hashValue(imported);
    return imported;
  }
  const oldPolicy = reseal({ redactionPolicyVersion: '0.9.0' });
  const oldResult = assessEvidence(oldPolicy);
  assert.equal(oldResult.fresh, false);
  assert.ok(oldResult.reasons.includes('REDACTION_POLICY_VERSION_MISMATCH'));
  assert.equal(oldPolicy.redactionPolicyVersion, '0.9.0');

  const oldFilesystem = reseal({ filesystemCapabilityDigest: 'f'.repeat(64) });
  const filesystemResult = assessEvidence(oldFilesystem);
  assert.equal(filesystemResult.fresh, false);
  assert.ok(filesystemResult.reasons.includes('FILESYSTEM_CAPABILITY_DIGEST_MISMATCH'));
  const oldBoundary = reseal({ filesystemBoundaryVersion: '0.9.0' });
  const boundaryResult = assessEvidence(oldBoundary);
  assert.equal(boundaryResult.fresh, false);
  assert.ok(boundaryResult.reasons.includes('FILESYSTEM_BOUNDARY_VERSION_MISMATCH'));

  const canary = 'imported-secret-canary';
  const sensitive = reseal({ stdout: `token=${canary}` });
  const sensitiveResult = assessEvidence(sensitive);
  assert.equal(sensitiveResult.fresh, false);
  assert.ok(sensitiveResult.reasons.includes('SENSITIVE_EVIDENCE_CONTENT'));
  assert.equal(sensitive.stdout.includes(canary), true);
});

test('locally created evidence sanitizes before sealing component and evidence digests', () => {
  const canary = 'local-evidence-secret-canary';
  const evidence = createEvidence({
    stepId: 'quality', attempt: 1, status: 'FAIL', reason: `token=${canary}`,
    components: [{ id: 'builtin:quality', operation: 'quality', status: 'FAIL', metadata: { password: canary }, digest: 'stale' }],
  });
  assert.equal(JSON.stringify(evidence).includes(canary), false);
  assert.equal(evidence.components[0].metadata.password, '<redacted>');
  assert.equal(evidence.components[0].digest, hashValue({
    id: 'builtin:quality', operation: 'quality', status: 'FAIL', metadata: { password: '<redacted>' },
  }));
  assert.equal(assessEvidence(evidence).fresh, true);
});

test('N/A evidence is valid only with an explicit reason', () => {
  assert.throws(() => createEvidence({ stepId: 'browser', attempt: 1, status: 'NA' }), /reason/);
  const evidence = createEvidence({ stepId: 'browser', attempt: 1, status: 'NA', reason: 'not-applicable' });
  assert.equal(evidence.status, 'NA');
});

test('invalid and future-dated evidence fails closed', () => {
  assert.deepEqual(assessEvidence(null).fresh, false);
  const evidence = createEvidence({
    stepId: 'tests', attempt: 1, status: 'FAIL', finishedAt: '2027-01-01T00:00:00.000Z',
  });
  const result = assessEvidence(evidence, { now: new Date('2026-01-01T00:00:00.000Z') });
  assert.equal(result.fresh, false);
  assert.match(result.reasons[0], /future/);
});

function finalizedBinding(fields) {
  const binding = {
    schemaVersion: '1.1.0',
    redactionPolicyVersion: REDACTION_POLICY_VERSION,
    filesystemBoundaryVersion: FILESYSTEM_BOUNDARY_VERSION,
    filesystemCapabilityDigest: FILESYSTEM_CAPABILITY_DIGEST,
    ...fields,
  };
  binding.bindingDigest = hashValue(binding);
  return binding;
}

function componentReceipt(command, status = 'PASS') {
  const receipt = {
    id: command.id, targetId: command.targetId,
    componentId: command.componentId, adapterId: command.adapterId,
    operation: command.operation, commandHash: command.commandHash,
    launchDigest: command.launchBinding.launchDigest, status,
    exitCode: status === 'PASS' ? 0 : 1, signal: null, stdout: '', stderr: '',
    outputTruncated: false, durationMs: 1,
  };
  receipt.digest = hashValue(receipt);
  return receipt;
}

function compositeFixture() {
  const commands = ['api', 'web'].map(componentId => {
    const command = {
      id: `${componentId}:test`, targetId: `${componentId}:test`,
      componentId, adapterId: 'node', operation: 'test',
      argv: ['node', '--test'], cwd: componentId, requiredAuthority: null,
    };
    command.launchBinding = createLaunchBinding(command.argv);
    command.commandHash = hashValue({
      providerId: 'module-tests', id: command.id, targetId: command.targetId,
      componentId: command.componentId, adapterId: command.adapterId,
      operation: command.operation, argv: command.argv, cwd: command.cwd,
      launchDigest: command.launchBinding.launchDigest,
    });
    return command;
  });
  const binding = finalizedBinding({
    providerId: 'module-tests', kind: 'composite', operation: null,
    operations: [{ name: 'test', selector: { componentIds: ['api', 'web'] } }],
    targets: commands.map(command => ({
      id: command.targetId, componentId: command.componentId, adapterId: command.adapterId,
      operation: command.operation, kind: 'command', commandIds: [command.id],
    })),
    commands, commandAggregateHash: hashValue(commands.map(command => command.commandHash)),
    targetAggregateHash: null,
    catalogDigests: { workflow: 'a'.repeat(64) },
  });
  binding.targetAggregateHash = hashValue(binding.targets);
  delete binding.bindingDigest;
  binding.bindingDigest = hashValue(binding);
  const components = commands.map(command => componentReceipt(command));
  const evidence = createEvidence({
    stepId: 'tests', attempt: 1, status: 'PASS', providerId: binding.providerId,
    bindingDigest: binding.bindingDigest, commandHash: binding.targetAggregateHash,
    command: { commands },
    components, componentAggregateHash: hashValue(components.map(component => component.digest)),
  });
  return { binding, evidence };
}

test('composite evidence requires the exact ordered complete receipt set from the current binding', () => {
  const { binding, evidence } = compositeFixture();
  const context = {
    requireBinding: true, providerId: binding.providerId, bindingDigest: binding.bindingDigest,
    commandHash: binding.targetAggregateHash, evidenceBinding: binding,
  };
  assert.equal(assessEvidence(evidence, context).fresh, true);

  for (const components of [[], evidence.components.slice(0, 1), [...evidence.components].reverse()]) {
    const imported = createEvidence({
      ...evidence, components,
      componentAggregateHash: hashValue(components.map(component => component.digest)),
    });
    const result = assessEvidence(imported, context);
    assert.equal(result.fresh, false);
    assert.ok(result.reasons.some(reason => /receipt (count|id|componentId|commandHash)/.test(reason)));
  }

  const forged = { ...evidence.components[0], commandHash: 'f'.repeat(64) };
  delete forged.digest;
  forged.digest = hashValue(forged);
  const components = [forged, evidence.components[1]];
  const imported = createEvidence({
    ...evidence, components,
    componentAggregateHash: hashValue(components.map(component => component.digest)),
  });
  assert.ok(assessEvidence(imported, context).reasons.includes('component receipt commandHash mismatch at index 0'));
});

test('composite receipts reject forged process results, extra fields, and command mirrors', () => {
  const { binding, evidence } = compositeFixture();
  const context = {
    requireBinding: true, providerId: binding.providerId, bindingDigest: binding.bindingDigest,
    commandHash: binding.targetAggregateHash, evidenceBinding: binding,
  };
  const forged = {
    ...evidence.components[0], exitCode: 17, signal: 'SIGKILL', injected: true,
  };
  delete forged.digest;
  const components = [forged, evidence.components[1]];
  const processForgery = createEvidence({ ...evidence, components });
  const processReasons = assessEvidence(processForgery, context).reasons;
  assert.ok(processReasons.includes('component receipt contains unexpected fields at index 0'));
  assert.ok(processReasons.includes('PASS component receipt has a failing process result at index 0'));

  const wrongCommands = evidence.command.commands.map((command, index) => (
    index === 0 ? { ...command, cwd: 'foreign-component' } : command
  ));
  const commandForgery = createEvidence({
    ...evidence, command: { commands: wrongCommands, extra: true },
  });
  const commandReasons = assessEvidence(commandForgery, context).reasons;
  assert.ok(commandReasons.includes('composite command receipt is invalid'));
  assert.ok(commandReasons.includes('composite command receipt mismatch at index 0'));

  const missingCommand = createEvidence({ ...evidence, command: undefined });
  assert.ok(assessEvidence(missingCommand, context).reasons.includes('composite command receipt is invalid'));
});

test('builtin and N/A evidence receipts fail closed on empty, partial, or foreign shapes', () => {
  const builtin = finalizedBinding({
    providerId: 'intake-contract', kind: 'builtin', operation: 'manifest-intent',
    commands: [], catalogDigests: { workflow: 'a'.repeat(64) },
  });
  const child = { id: 'builtin:manifest-intent', operation: 'manifest-intent', status: 'PASS', metadata: { mode: 'local' } };
  child.digest = hashValue(child);
  const validBuiltin = createEvidence({
    stepId: 'intake', attempt: 1, status: 'PASS', providerId: builtin.providerId,
    bindingDigest: builtin.bindingDigest,
    command: { operation: builtin.operation },
    commandHash: hashValue({ providerId: builtin.providerId, operation: builtin.operation }),
    components: [child], componentAggregateHash: hashValue([child.digest]),
  });
  const builtinContext = {
    requireBinding: true, providerId: builtin.providerId, bindingDigest: builtin.bindingDigest,
    commandHash: validBuiltin.commandHash, evidenceBinding: builtin,
  };
  assert.equal(assessEvidence(validBuiltin, builtinContext).fresh, true);
  const emptyBuiltin = createEvidence({
    ...validBuiltin, components: [], componentAggregateHash: hashValue([]),
  });
  assert.ok(assessEvidence(emptyBuiltin, builtinContext).reasons.includes('builtin receipt requires exactly one component'));

  const na = finalizedBinding({
    providerId: 'browser-e2e', kind: 'na', operation: null, commands: [],
    naReason: 'policy does not require browser-e2e', catalogDigests: { workflow: 'a'.repeat(64) },
  });
  const validNa = createEvidence({
    stepId: 'browser-e2e', attempt: 1, status: 'NA', reason: na.naReason,
    providerId: na.providerId, bindingDigest: na.bindingDigest,
    commandHash: hashValue({ providerId: na.providerId, operation: null }),
    components: [], componentAggregateHash: hashValue([]),
  });
  const naContext = {
    requireBinding: true, providerId: na.providerId, bindingDigest: na.bindingDigest,
    commandHash: validNa.commandHash, evidenceBinding: na,
  };
  assert.equal(assessEvidence(validNa, naContext).fresh, true);
  const wrongNa = createEvidence({ ...validNa, reason: 'caller supplied reason' });
  assert.ok(assessEvidence(wrongNa, naContext).reasons.includes('N/A receipt reason mismatch'));
});

test('evidence validation reports component and aggregate digest mutation independently', () => {
  const evidence = createEvidence({
    stepId: 'tests', attempt: 1, status: 'PASS',
    components: [{ id: 'builtin:test', operation: 'test', status: 'PASS' }],
  });
  const componentMutation = structuredClone(evidence);
  componentMutation.components[0].digest = 'f'.repeat(64);
  assert.ok(validateEvidence(componentMutation).some(issue => issue.startsWith('component digest mismatch:')));

  const aggregateMutation = structuredClone(evidence);
  aggregateMutation.componentAggregateHash = 'e'.repeat(64);
  assert.ok(validateEvidence(aggregateMutation).includes('component aggregate hash mismatch'));
});

test('receipt validation rejects policy and filesystem identity mismatches', () => {
  const { binding, evidence } = compositeFixture();
  const mutations = [
    ['redactionPolicyVersion', '0.0.0', 'receipt redaction policy version mismatch'],
    ['filesystemBoundaryVersion', '0.0.0', 'receipt filesystem boundary version mismatch'],
    ['filesystemCapabilityDigest', 'f'.repeat(64), 'receipt filesystem capability digest mismatch'],
  ];
  for (const [field, value, expected] of mutations) {
    assert.ok(validateEvidenceReceipt(evidence, { ...binding, [field]: value }).includes(expected));
  }
});

test('builtin receipts reject invalid optional reason and command shape', () => {
  const binding = finalizedBinding({
    providerId: 'intake-contract', kind: 'builtin', operation: 'manifest-intent',
    commands: [], catalogDigests: { workflow: 'a'.repeat(64) },
  });
  const component = {
    id: 'builtin:manifest-intent', operation: 'manifest-intent', status: 'PASS', reason: ' ',
  };
  component.digest = hashValue(component);
  const evidence = createEvidence({
    stepId: 'intake', attempt: 1, status: 'PASS', providerId: binding.providerId,
    bindingDigest: binding.bindingDigest, command: { operation: 'foreign', extra: true },
    components: [component],
  });
  const issues = validateEvidenceReceipt(evidence, binding);
  assert.ok(issues.includes('builtin receipt reason is invalid'));
  assert.ok(issues.includes('builtin command receipt mismatch'));
});

test('composite N/A target receipts validate exact shape, identity, and status', () => {
  const target = {
    id: 'web:test', componentId: 'web', adapterId: 'node', operation: 'test', kind: 'na',
    reasonCode: 'NOT_APPLICABLE', reason: 'web tests do not apply',
  };
  const binding = finalizedBinding({
    providerId: 'module-tests', kind: 'composite', operation: null,
    operations: [{ name: 'test', selector: { componentIds: ['web'] } }],
    targets: [target], commands: [], commandAggregateHash: hashValue([]),
    targetAggregateHash: hashValue([target]), catalogDigests: { workflow: 'a'.repeat(64) },
  });
  const component = { ...target, status: 'NA' };
  delete component.kind;
  component.digest = hashValue(component);
  const evidence = createEvidence({
    stepId: 'tests', attempt: 1, status: 'PASS', providerId: binding.providerId,
    bindingDigest: binding.bindingDigest, command: { commands: [] },
    commandHash: binding.targetAggregateHash, components: [component],
  });
  assert.deepEqual(validateEvidenceReceipt(evidence, binding), []);

  const malformed = structuredClone(evidence);
  malformed.components[0] = {
    ...malformed.components[0], id: 'foreign:test', status: 'FAIL', injected: true,
  };
  const issues = validateEvidenceReceipt(malformed, binding);
  assert.ok(issues.includes('N/A component receipt id mismatch at index 0'));
  assert.ok(issues.includes('N/A component receipt status mismatch at index 0'));
  assert.ok(issues.includes('N/A component receipt contains unexpected fields at index 0'));
});

test('composite process receipts reject each invalid process invariant', () => {
  const { binding, evidence } = compositeFixture();
  const invalidCases = [
    [{ launchDigest: 'f'.repeat(64) }, 'component receipt launchDigest mismatch at index 0'],
    [{ exitCode: -1 }, 'component receipt exitCode is invalid at index 0'],
    [{ signal: '' }, 'component receipt signal is invalid at index 0'],
    [{ stdout: null }, 'component receipt process metadata is invalid at index 0'],
    [{ status: 'FAIL', exitCode: 0, signal: null }, 'FAIL component receipt lacks a failing process result at index 0'],
  ];
  for (const [mutation, expected] of invalidCases) {
    const components = structuredClone(evidence.components);
    Object.assign(components[0], mutation);
    const mutated = { ...evidence, components };
    assert.ok(validateEvidenceReceipt(mutated, binding).includes(expected));
  }

  const failedComponents = structuredClone(evidence.components);
  Object.assign(failedComponents[0], { status: 'FAIL', exitCode: 1 });
  assert.ok(validateEvidenceReceipt(
    { ...evidence, components: failedComponents }, binding,
  ).includes('PASS evidence contains a failed component receipt'));
});

test('createEvidence rejects a redaction result that exceeds the bounded JSON envelope', () => {
  const payload = Object.fromEntries(
    Array.from({ length: 8_000 }, (_, index) => [`field${index}`, 'x'.repeat(160)]),
  );
  assert.throws(
    () => createEvidence({
      stepId: 'tests', attempt: 1, status: 'PASS', payload,
    }),
    /evidence must be JSON-serializable: redaction boundary rejected evidence/,
  );
});
