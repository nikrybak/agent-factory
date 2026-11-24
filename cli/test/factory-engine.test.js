'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const {
  collectAcceptedEvidence,
  collectAcceptedEvidenceFromStatus,
  detectProject,
  explainProject,
  initProject,
  planProject,
  resumeProject,
  runProjectStep,
  statusProject,
  verifyProject,
} = require('../lib/factory/engine');
const { hashValue } = require('../lib/factory/hash');
const { FactoryStore } = require('../lib/factory/store');
const { resolveProjectKey } = require('../lib/project');

function rehashPlan(plan) {
  plan.planHash = hashValue({
    goal: plan.goal,
    manifestDigest: plan.manifestDigest,
    detection: {
      components: plan.detection.components,
      capabilities: plan.detection.capabilities,
      gaps: plan.detection.gaps,
    },
    policy: plan.policy,
    steps: plan.steps,
    catalogDigests: plan.catalogDigests,
    toolchainTrust: plan.toolchainTrust,
  });
}

function projectFixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'factory-engine-'));
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({
    name: 'killer-cli',
    bin: { killer: './bin.js' },
    scripts: { test: 'node --test' },
  }));
  return root;
}

test('init is dry-run safe, writes a strict manifest/schema, and refuses overwrite', () => {
  const root = projectFixture();
  const preview = initProject(root, { name: 'Killer CLI', profiles: ['cli'], dryRun: true });
  assert.equal(preview.status, 'planned');
  assert.equal(fs.existsSync(path.join(root, 'factory')), false);

  const created = initProject(root, { name: 'Killer CLI', profiles: ['cli'] });
  assert.equal(created.status, 'created');
  assert.equal(created.manifest.project.id, 'killer-cli');
  assert.equal(fs.existsSync(path.join(root, 'factory', 'schema', 'project.schema.json')), true);
  assert.equal(fs.existsSync(path.join(root, 'factory', 'schema', 'toolchain-trust.schema.json')), true);
  assert.throws(() => initProject(root, { name: 'Again' }), /already exists/);
});

test('detect and plan produce evidence-backed policy and a persisted resumable DAG', () => {
  const root = projectFixture();
  initProject(root, { name: 'Killer CLI', profiles: ['cli'] });
  const detection = detectProject(root, { write: true });
  assert.ok(detection.components.some(component => component.family === 'node'));
  assert.ok(detection.capabilities.includes('command-line'));

  const planned = planProject(root, { runId: 'run-001', goal: 'Ship reliable CLI' });
  assert.equal(planned.plan.runId, 'run-001');
  assert.equal(planned.plan.schemaVersion, '1.1.0');
  assert.equal(planned.plan.policy.status, 'ready');
  const workflowBytes = fs.readFileSync(path.join(root, 'factory/catalog/workflow.json'));
  assert.equal(
    planned.plan.catalogDigests['factory/catalog/workflow.json'],
    crypto.createHash('sha256').update(workflowBytes).digest('hex')
  );
  assert.ok(planned.plan.steps.some(step => step.id === 'security'));
  assert.ok(planned.plan.steps.some(step => step.id === 'browser-e2e' && step.applicable === false));

  const status = statusProject(root, { run: 'run-001' });
  assert.equal(status.workflow.runState, 'READY');
  assert.deepEqual(status.workflow.ready, ['intake']);
  assert.deepEqual(resumeProject(root, { run: 'run-001' }).ready, ['intake']);
  assert.equal(explainProject(root, { run: 'run-001', step: 'browser-e2e' }).step.applicable, false);
});

test('raw catalog byte drift stales a plan even when parsed semantics are unchanged', () => {
  const root = projectFixture();
  initProject(root, { name: 'Catalog Bytes', profiles: ['cli'] });
  planProject(root, { runId: 'catalog-bytes' });
  const workflow = path.join(root, 'factory/catalog/workflow.json');
  fs.appendFileSync(workflow, ' \n');
  const status = statusProject(root, { run: 'catalog-bytes' });
  assert.equal(status.planFresh, false);
  assert.deepEqual(status.workflow.ready, []);
});

test('local toolchain trust appearance or raw-byte drift stales the current plan', () => {
  const root = projectFixture();
  initProject(root, { name: 'Tool Trust Bytes', profiles: ['cli'] });
  planProject(root, { runId: 'tool-trust-bytes' });
  fs.mkdirSync(path.join(root, '.factory'), { recursive: true });
  fs.writeFileSync(path.join(root, '.factory', 'toolchain-trust.json'), JSON.stringify({
    schemaVersion: '1.0.0',
    platformFamily: process.platform === 'win32' ? 'win32' : 'posix',
    entries: [],
  }));
  const appeared = statusProject(root, { run: 'tool-trust-bytes' });
  assert.equal(appeared.planFresh, false);
  assert.deepEqual(appeared.workflow.ready, []);
});

test('planning rejects a governed catalog directory junction before using external bytes', (t) => {
  const root = projectFixture();
  initProject(root, { name: 'Catalog Junction', profiles: ['cli'] });
  const catalog = path.join(root, 'factory', 'catalog');
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'factory-catalog-outside-'));
  fs.cpSync(catalog, outside, { recursive: true });
  fs.rmSync(catalog, { recursive: true });
  try {
    fs.symlinkSync(outside, catalog, 'junction');
  } catch (error) {
    t.skip(`junctions unavailable: ${error.code}`);
    return;
  }
  assert.throws(
    () => planProject(root, { runId: 'catalog-junction' }),
    error => error.code === 'FACTORY_FILESYSTEM_PATH_UNSAFE'
  );
});

test('run executes only a ready step, persists PASS evidence, and verify rejects incomplete work', async () => {
  const root = projectFixture();
  initProject(root, { name: 'Killer CLI', profiles: ['cli'] });
  planProject(root, { runId: 'run-002' });

  await assert.rejects(
    () => runProjectStep(root, { run: 'run-002', step: 'tests', commandArgv: ['node', '-e', 'process.exit(0)'] }),
    /not ready/
  );
  await assert.rejects(
    () => runProjectStep(root, { run: 'run-002', step: 'intake', commandArgv: ['node', '-e', 'process.exit(0)'] }),
    /reject caller argv/
  );
  const result = await runProjectStep(root, {
    run: 'run-002', step: 'intake',
  });
  assert.equal(result.evidence.status, 'PASS');
  const accepted = collectAcceptedEvidence(root, { run: 'run-002' });
  assert.equal(accepted.status, 'PASS');
  assert.deepEqual(accepted.digests, [result.evidence.digest]);
  const frozen = statusProject(root, { run: 'run-002' });
  assert.deepEqual(collectAcceptedEvidenceFromStatus(frozen).digests, [result.evidence.digest]);
  frozen.plan.steps[0] = { ...frozen.plan.steps[0], evidenceBinding: undefined };
  assert.ok(collectAcceptedEvidenceFromStatus(frozen).gaps.some(gap => gap.code === 'LEGACY_UNBOUND_PLAN'));
  assert.equal(statusProject(root, { run: 'run-002' }).workflow.ready.includes('plan'), true);
  const verification = verifyProject(root, { run: 'run-002' });
  assert.equal(verification.status, 'FAIL');
  assert.match(verification.treeHash, /^[a-f0-9]{64}$/);
  assert.match(verification.certificationIdentityDigest, /^[a-f0-9]{64}$/);
  assert.match(verification.layoutInputDigest, /^[a-f0-9]{64}$/);
  assert.ok(verification.gaps.some(gap => gap.stepId === 'plan'));
});

test('run never returns success or accepts evidence while lock release is unconfirmed', { concurrency: false }, async (t) => {
  const root = projectFixture();
  initProject(root, { name: 'Release Fence', profiles: ['cli'] });
  planProject(root, { runId: 'release-fence' });
  const original = FactoryStore.prototype.releaseRunLock;
  FactoryStore.prototype.releaseRunLock = function failRelease() {
    const error = new Error('workflow run lock ownership is not confirmed');
    error.code = 'RUN_LOCK_OWNER_MISMATCH';
    throw error;
  };
  t.after(() => { FactoryStore.prototype.releaseRunLock = original; });
  await assert.rejects(
    () => runProjectStep(root, { run: 'release-fence', step: 'intake' }),
    error => error.code === 'RUN_LOCK_OWNER_MISMATCH'
  );
  FactoryStore.prototype.releaseRunLock = original;
  const blocked = statusProject(root, { run: 'release-fence' });
  assert.equal(blocked.runLocked, true);
  assert.equal(blocked.workflow.runState, 'BLOCKED');
  assert.ok(collectAcceptedEvidenceFromStatus(blocked).gaps.some(gap => gap.code === 'RUN_LOCK_HELD'));
  const store = new FactoryStore(root);
  const lock = JSON.parse(fs.readFileSync(path.join(root, '.factory/runs/release-fence/lock.json'), 'utf8'));
  assert.equal(store.releaseRunLock('release-fence', lock.token), true);
  assert.equal(statusProject(root, { run: 'release-fence' }).runLocked, false);
});

test('initial checkpoint failure still releases the exact run lock', { concurrency: false }, async (t) => {
  const root = projectFixture();
  initProject(root, { name: 'Checkpoint Fence', profiles: ['cli'] });
  planProject(root, { runId: 'checkpoint-fence' });
  const original = FactoryStore.prototype.writeCheckpoint;
  let writes = 0;
  FactoryStore.prototype.writeCheckpoint = function failFirstCheckpoint(...args) {
    writes += 1;
    if (writes === 1) throw new Error('checkpoint-failed');
    return original.apply(this, args);
  };
  t.after(() => { FactoryStore.prototype.writeCheckpoint = original; });
  await assert.rejects(
    () => runProjectStep(root, { run: 'checkpoint-fence', step: 'intake' }),
    /checkpoint-failed/
  );
  FactoryStore.prototype.writeCheckpoint = original;
  const store = new FactoryStore(root);
  assert.equal(store.hasRunLock('checkpoint-fence'), false);
  const successor = store.acquireRunLock('checkpoint-fence', 'intake');
  assert.equal(store.releaseRunLock('checkpoint-fence', successor.token), true);
});

test('plan hash is deterministic and manifest changes block stale plans', async () => {
  const root = projectFixture();
  initProject(root, { name: 'Killer CLI', profiles: ['cli'] });
  const first = planProject(root, { runId: 'stable-one', goal: 'Same goal', dryRun: true });
  const second = planProject(root, { runId: 'stable-two', goal: 'Same goal', dryRun: true });
  assert.equal(first.plan.planHash, second.plan.planHash);

  planProject(root, { runId: 'stale-plan' });
  const manifestPath = path.join(root, 'factory', 'project.json');
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  manifest.project.intent = 'Changed intent';
  fs.writeFileSync(manifestPath, JSON.stringify(manifest));
  const status = statusProject(root, { run: 'stale-plan' });
  assert.equal(status.planFresh, false);
  assert.deepEqual(status.workflow.ready, []);
  await assert.rejects(
    () => runProjectStep(root, { run: 'stale-plan', step: 'intake', commandArgv: ['node', '-e', ''] }),
    /plan is stale/
  );
  assert.ok(verifyProject(root, { run: 'stale-plan' }).gaps.some(gap => gap.code === 'stale-plan'));
});

test('plan binding or plan hash tampering blocks execution before spawn', async () => {
  const root = projectFixture();
  initProject(root, { name: 'Killer CLI', profiles: ['cli'] });
  planProject(root, { runId: 'tampered-plan' });
  const planPath = path.join(root, '.factory/runs/tampered-plan/plan.json');
  const plan = JSON.parse(fs.readFileSync(planPath, 'utf8'));
  plan.steps[0].evidenceBinding.providerId = 'forged-provider';
  fs.writeFileSync(planPath, JSON.stringify(plan));
  assert.equal(statusProject(root, { run: 'tampered-plan' }).planFresh, false);
  await assert.rejects(
    () => runProjectStep(root, { run: 'tampered-plan', step: 'intake' }),
    /plan is stale/
  );
});

test('historical 1.0 plans are stale even when their hash payload is otherwise current', () => {
  const root = projectFixture();
  initProject(root, { name: 'Historical Plan', profiles: ['cli'] });
  planProject(root, { runId: 'historical-plan' });
  const planPath = path.join(root, '.factory/runs/historical-plan/plan.json');
  const plan = JSON.parse(fs.readFileSync(planPath, 'utf8'));
  plan.schemaVersion = '1.0.0';
  fs.writeFileSync(planPath, JSON.stringify(plan));
  const status = statusProject(root, { run: 'historical-plan' });
  assert.equal(status.planFresh, false);
  assert.deepEqual(status.workflow.ready, []);
});

test('self-rehashed arbitrary bindings and plans cannot replace trusted catalog resolution', async () => {
  const root = projectFixture();
  initProject(root, { name: 'Killer CLI', profiles: ['cli'] });
  planProject(root, { runId: 'rehashed-binding' });
  const planPath = path.join(root, '.factory/runs/rehashed-binding/plan.json');
  const plan = JSON.parse(fs.readFileSync(planPath, 'utf8'));
  const binding = plan.steps.find(step => step.id === 'tests').evidenceBinding;
  const command = binding.commands[0];
  command.argv = ['node', '-e', 'process.exit(0)'];
  command.commandHash = hashValue({
    providerId: binding.providerId,
    componentId: command.componentId,
    adapterId: command.adapterId,
    operation: command.operation,
    argv: command.argv,
    cwd: command.cwd,
  });
  binding.commandAggregateHash = hashValue(binding.commands.map(item => item.commandHash));
  delete binding.bindingDigest;
  binding.bindingDigest = hashValue(binding);
  rehashPlan(plan);
  fs.writeFileSync(planPath, JSON.stringify(plan));

  const status = statusProject(root, { run: 'rehashed-binding' });
  assert.equal(status.planFresh, false);
  assert.deepEqual(status.workflow.ready, []);
  assert.ok(collectAcceptedEvidenceFromStatus(status).gaps.some(gap => gap.code === 'STALE_PLAN'));
  await assert.rejects(
    () => runProjectStep(root, { run: 'rehashed-binding', step: 'intake' }),
    /plan is stale/
  );
});

test('self-rehashed legacy plans without physical launch identity are stale before execution', async () => {
  const root = projectFixture();
  initProject(root, { name: 'Legacy Launcher', profiles: ['cli'] });
  planProject(root, { runId: 'legacy-launcher' });
  const planPath = path.join(root, '.factory/runs/legacy-launcher/plan.json');
  const plan = JSON.parse(fs.readFileSync(planPath, 'utf8'));
  const binding = plan.steps.find(step => step.id === 'tests').evidenceBinding;
  const command = binding.commands[0];
  delete command.launchBinding;
  command.commandHash = hashValue({
    providerId: binding.providerId,
    componentId: command.componentId,
    adapterId: command.adapterId,
    operation: command.operation,
    argv: command.argv,
    cwd: command.cwd,
  });
  binding.commandAggregateHash = hashValue(binding.commands.map(item => item.commandHash));
  delete binding.bindingDigest;
  binding.bindingDigest = hashValue(binding);
  rehashPlan(plan);
  fs.writeFileSync(planPath, JSON.stringify(plan));

  const status = statusProject(root, { run: 'legacy-launcher' });
  assert.equal(status.planFresh, false);
  assert.deepEqual(status.workflow.ready, []);
  assert.ok(collectAcceptedEvidenceFromStatus(status).gaps.some(gap => gap.code === 'STALE_PLAN'));
  await assert.rejects(
    () => runProjectStep(root, { run: 'legacy-launcher', step: 'intake' }),
    /plan is stale/,
  );
});

test('current stack detection drift stales an otherwise untampered plan', () => {
  const root = projectFixture();
  initProject(root, { name: 'Killer CLI', profiles: ['cli'] });
  planProject(root, { runId: 'detection-drift' });
  fs.mkdirSync(path.join(root, 'service'), { recursive: true });
  fs.writeFileSync(path.join(root, 'service', 'package.json'), JSON.stringify({
    name: 'new-service', scripts: { test: 'node --test' },
  }));

  const status = statusProject(root, { run: 'detection-drift' });
  assert.equal(status.planFresh, false);
  assert.deepEqual(status.workflow.ready, []);
  assert.ok(verifyProject(root, { run: 'detection-drift' }).gaps.some(gap => gap.code === 'stale-plan'));
});

test('registered child registry mutation stales evidence without changing its source tree', async t => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'factory-engine-city-'));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  fs.writeFileSync(path.join(base, 'AGENTS.md'), '# Factory City\n');
  fs.mkdirSync(path.join(base, 'cli', 'bin'), { recursive: true });
  fs.writeFileSync(path.join(base, 'cli', 'bin', 'infra.js'), '');
  fs.mkdirSync(path.join(base, 'app_entry_root', '_registry'), { recursive: true });
  const registryFile = path.join(base, 'app_entry_root', '_registry', 'registry.json');
  const registry = {
    schemaVersion: '1.0.0',
    projects: [{
      key: 'worlio', title: 'Worlio', presentLocally: true,
      app: { active: 'v1', versions: [{ id: 'v1' }] },
    }],
  };
  fs.writeFileSync(registryFile, JSON.stringify(registry));
  // The application repository is the version directory; its Factory manifest lives there.
  const childRoot = path.join(base, 'app_entry_root', 'worlio');
  const child = path.join(childRoot, 'worlio-v1');
  fs.mkdirSync(path.join(childRoot, '_project'), { recursive: true });
  fs.mkdirSync(child, { recursive: true });
  fs.writeFileSync(path.join(child, 'package.json'), JSON.stringify({ name: 'worlio' }));
  initProject(child, { name: 'Worlio', profiles: ['cli'] });
  planProject(child, { runId: 'child-context' });
  const result = await runProjectStep(child, {
    run: 'child-context', step: 'intake',
  });
  const before = result.evidence.certificationIdentityDigest;
  const beforeTree = result.evidence.sourceTreeHash;

  registry.projects[0].title = 'Worlio renamed';
  fs.writeFileSync(registryFile, JSON.stringify(registry));
  const status = statusProject(child, { run: 'child-context' });
  assert.equal(status.evidence[0].sourceTreeHash, beforeTree);
  assert.notEqual(status.certificationIdentity.certificationIdentityDigest, before);
  assert.equal(status.evidence[0].fresh, false);
  assert.ok(status.evidence[0].reasons.includes('certification identity digest mismatch'));
  const accepted = collectAcceptedEvidence(child, { run: 'child-context' });
  assert.equal(accepted.status, 'FAIL');
  assert.ok(accepted.gaps.some(gap => gap.code === 'PROVENANCE_EVIDENCE_REJECTED'));
  assert.ok(verifyProject(child, { run: 'child-context' }).gaps.some(gap => gap.state === 'STALE'));
});

test('registered child plans from its migrated owned catalog without base fallback', { skip: 'needs the full private monorepo (child registry, skill canon)' }, t => {
  const repository = path.resolve(__dirname, '../..');
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'factory-engine-child-catalog-'));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  fs.writeFileSync(path.join(base, 'AGENTS.md'), '# Factory City\n');
  fs.mkdirSync(path.join(base, 'cli', 'bin'), { recursive: true });
  fs.writeFileSync(path.join(base, 'cli', 'bin', 'infra.js'), '');
  fs.mkdirSync(path.join(base, 'app_entry_root', '_registry'), { recursive: true });
  fs.writeFileSync(path.join(base, 'app_entry_root', '_registry', 'registry.json'), JSON.stringify({
    schemaVersion: '1.0.0',
    projects: [{
      key: 'worlio', title: 'Worlio', presentLocally: true,
      app: { active: 'v1', versions: [{ id: 'v1' }] },
    }],
  }));

  const childRoot = path.join(base, 'app_entry_root', 'worlio');
  const child = path.join(childRoot, 'worlio-v1');
  fs.mkdirSync(path.join(childRoot, '_project'), { recursive: true });
  fs.mkdirSync(child, { recursive: true });
  fs.writeFileSync(path.join(child, 'package.json'), JSON.stringify({
    name: 'worlio', scripts: { test: 'node --test', coverage: 'node --test' },
  }));
  // The catalog lives in the local, ignored Worlio application repository; resolve it by key.
  const sourceCatalog = path.join(resolveProjectKey(repository, 'worlio').appRoot, 'factory');
  if (!fs.existsSync(sourceCatalog)) {
    t.skip('local Worlio checkout with a migrated factory catalog is absent');
    return;
  }
  fs.cpSync(sourceCatalog, path.join(child, 'factory'), { recursive: true });

  const providerRelative = 'factory/catalog/evidence-providers.json';
  const providerPath = path.join(child, providerRelative);
  const localProviderBytes = Buffer.concat([fs.readFileSync(providerPath), Buffer.from(' \n')]);
  fs.writeFileSync(providerPath, localProviderBytes);
  const baseProviderBytes = fs.readFileSync(path.join(repository, providerRelative));
  const planned = planProject(child, { runId: 'child-owned-catalog', dryRun: true });
  const localDigest = crypto.createHash('sha256').update(localProviderBytes).digest('hex');
  const baseDigest = crypto.createHash('sha256').update(baseProviderBytes).digest('hex');

  assert.equal(planned.plan.catalogDigests[providerRelative], localDigest);
  assert.notEqual(planned.plan.catalogDigests[providerRelative], baseDigest);
  assert.equal(planned.plan.steps.length, 20);
  assert.ok(planned.plan.steps.every(step => step.evidenceBinding?.providerId));

  fs.rmSync(providerPath);
  assert.throws(
    () => planProject(child, { runId: 'no-base-fallback', dryRun: true }),
    error => error.code === 'FACTORY_FILESYSTEM_PATH_UNSAFE',
  );
});

test('engine fail-closed branches reject missing runs, unknown evidence, and stale evidence', async () => {
  const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'factory-engine-empty-run-'));
  const missing = collectAcceptedEvidence(empty);
  assert.equal(missing.status, 'FAIL');
  assert.equal(missing.gaps[0].code, 'PROVENANCE_RUN_MISSING');

  const root = projectFixture();
  initProject(root, { name: 'Fail Closed Branches', profiles: ['cli'] });
  planProject(root, { runId: 'fail-closed' });
  assert.equal(statusProject(root).runId, 'fail-closed');
  const executed = await runProjectStep(root, { run: 'fail-closed', step: 'intake' });
  const current = statusProject(root, { run: 'fail-closed' });
  const unknown = {
    ...executed.evidence, stepId: 'foreign-step', attempt: 2,
  };
  const selection = collectAcceptedEvidenceFromStatus({
    ...current, evidence: [...current.evidence, unknown],
  });
  assert.ok(selection.gaps.some(gap => gap.code === 'PROVENANCE_EVIDENCE_UNKNOWN_STEP'));

  const failedDownstream = {
    ...executed.evidence,
    stepId: 'evals',
    status: 'FAIL',
    attempt: 99,
  };
  const retrySnapshot = { ...current, evidence: [...current.evidence, failedDownstream] };
  assert.equal(collectAcceptedEvidenceFromStatus(retrySnapshot).status, 'FAIL');
  const priorOnly = collectAcceptedEvidenceFromStatus(retrySnapshot, { beforeStepId: 'plan' });
  assert.equal(priorOnly.status, 'PASS');
  assert.deepEqual(priorOnly.evidence.map(item => item.stepId), ['intake']);
  assert.throws(
    () => collectAcceptedEvidenceFromStatus(retrySnapshot, { beforeStepId: 'unknown' }),
    /unknown evidence selection boundary/,
  );

  fs.appendFileSync(path.join(root, 'factory/catalog/workflow.json'), ' \n');
  const stale = statusProject(root, { run: 'fail-closed' });
  assert.equal(stale.evidence[0].fresh, false);
  assert.ok(stale.evidence[0].reasons.includes('plan semantics mismatch'));
});

test('run rejects a binding that becomes invalid after the status snapshot', { concurrency: false }, async (t) => {
  const root = projectFixture();
  initProject(root, { name: 'Binding Snapshot', profiles: ['cli'] });
  planProject(root, { runId: 'binding-snapshot' });
  const original = FactoryStore.prototype.readPlan;
  FactoryStore.prototype.readPlan = function readPlanWithLateInvalidBinding(...args) {
    const plan = original.apply(this, args);
    const step = plan.steps.find(item => item.id === 'intake');
    const binding = step.evidenceBinding;
    let reads = 0;
    Object.defineProperty(step, 'evidenceBinding', {
      configurable: true,
      enumerable: true,
      get() {
        reads += 1;
        return reads <= 2 ? binding : undefined;
      },
    });
    return plan;
  };
  t.after(() => { FactoryStore.prototype.readPlan = original; });
  await assert.rejects(
    () => runProjectStep(root, { run: 'binding-snapshot', step: 'intake' }),
    /LEGACY_UNBOUND_PLAN/,
  );
});

test('cleanup checkpoint failure is reported only after releasing the run lock', { concurrency: false }, async (t) => {
  const root = projectFixture();
  initProject(root, { name: 'Cleanup Checkpoint', profiles: ['cli'] });
  planProject(root, { runId: 'cleanup-checkpoint' });
  const original = FactoryStore.prototype.writeCheckpoint;
  FactoryStore.prototype.writeCheckpoint = function failCleanupCheckpoint(runId, checkpoint) {
    if (checkpoint?.running === null) throw new Error('cleanup-checkpoint-failed');
    return original.call(this, runId, checkpoint);
  };
  t.after(() => { FactoryStore.prototype.writeCheckpoint = original; });
  await assert.rejects(
    () => runProjectStep(root, { run: 'cleanup-checkpoint', step: 'intake' }),
    /cleanup-checkpoint-failed/,
  );
  FactoryStore.prototype.writeCheckpoint = original;
  assert.equal(new FactoryStore(root).hasRunLock('cleanup-checkpoint'), false);
});

test('verify fails when certification identity changes during its status snapshot', { concurrency: false }, (t) => {
  const root = projectFixture();
  initProject(root, { name: 'Identity Drift', profiles: ['cli'] });
  planProject(root, { runId: 'identity-drift-during-verify' });
  const original = FactoryStore.prototype.readCheckpoint;
  let mutated = false;
  FactoryStore.prototype.readCheckpoint = function mutateAfterIdentity(...args) {
    const checkpoint = original.apply(this, args);
    if (!mutated) {
      mutated = true;
      fs.appendFileSync(path.join(root, 'README.md'), '\nidentity drift\n');
    }
    return checkpoint;
  };
  t.after(() => { FactoryStore.prototype.readCheckpoint = original; });
  const result = verifyProject(root, { run: 'identity-drift-during-verify' });
  assert.ok(result.gaps.some(gap => gap.code === 'certification-input-changed'));
});
