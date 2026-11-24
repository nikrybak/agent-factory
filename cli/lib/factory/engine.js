'use strict';
/** @implements REQ-FK-010, REQ-FK-011, REQ-CITY-011 Governed init, planning, execution, and certification. */

const fs = require('node:fs');
const path = require('node:path');
const { detectStack } = require('./detect');
const { assessEvidence } = require('./evidence');
const { bindEvidenceProviders, validateEvidenceBinding } = require('./evidence-providers');
const { loadCatalog, loadCatalogRecord } = require('./catalog-loader');
const { hashValue } = require('./hash');
const { computeCertificationIdentity } = require('./identity');
const { loadManifest } = require('./manifest');
const { evaluatePolicy } = require('./policy');
const { runStep } = require('./runner');
const { createStageProviderExecutors } = require('./stage-providers');
const { FactoryStore, atomicWriteJson, readJson, resolveWithinRoot } = require('./store');
const { loadToolchainTrust, toolchainTrustPlanIdentity } = require('./toolchain-trust');
const { evaluateWorkflow, validateWorkflow } = require('./workflow');
const { resolveProject } = require('../project');

const INFRA_ROOT = path.resolve(__dirname, '../../..');
const PLANNING_CATALOG_FILES = [
  'profiles.json', 'stack-signals.json', 'workflow.json', 'evidence-providers.json',
  'roles.json', 'adapters.json', 'trust-policy.json', 'evals.json',
];
const CITY_BOOTSTRAP_FILES = [
  'factory/schema/artifact-graph.schema.json', 'factory/schema/role.schema.json',
  'factory/schema/adapter.schema.json', 'factory/schema/evidence-provider.schema.json',
  'factory/schema/stack-signal.schema.json', 'factory/schema/trust-policy.schema.json',
  'factory/schema/toolchain-trust.schema.json',
  'factory/catalog/profiles.json', 'factory/catalog/stack-signals.json',
  'factory/catalog/workflow.json', 'factory/catalog/evidence-providers.json', 'factory/catalog/roles.json',
  'factory/catalog/adapters.json', 'factory/catalog/trust-policy.json',
  'factory/catalog/evals.json',
];

function slug(value) {
  const result = String(value || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  return /^[a-z][a-z0-9-]{1,62}$/.test(result) ? result : `project-${hashValue(value).slice(0, 8)}`;
}

function defaultManifest(root, options = {}) {
  const name = options.name || path.basename(path.resolve(root));
  return {
    $schema: './schema/project.schema.json',
    schemaVersion: '1.1.0',
    project: { id: slug(name), name, intent: options.intent || 'Build dependable production software', repositoryRoot: '.' },
    profiles: options.profiles || [],
    sources: [{ id: 'code', kind: 'local', location: '.', required: true }],
    stack: { mode: 'detect', declared: [] },
    risk: { class: 'low', dataSensitivity: 'public', internetExposure: false, regulated: false },
    capabilities: { required: [], optional: [] },
    authority: { destructive: false, dependencyInstall: false, schemaMigration: false, publicApiChange: false, networkWrite: false, publish: false, deploy: false, release: false },
    quality: { changedCoverage: 100, requiredGates: ['security'], additionalChecks: [] },
  };
}

function initProject(root, options = {}) {
  const projectRoot = fs.realpathSync.native(path.resolve(root));
  const manifestPath = resolveWithinRoot(projectRoot, 'factory/project.json');
  const manifest = defaultManifest(projectRoot, options);
  const files = ['factory/project.json', 'factory/schema/project.schema.json', 'factory/artifacts.json', ...CITY_BOOTSTRAP_FILES];
  if (options.dryRun) return { status: 'planned', files, manifest };
  if (fs.existsSync(manifestPath) && !options.force) throw new Error('factory/project.json already exists');
  atomicWriteJson(projectRoot, 'factory/project.json', manifest);
  atomicWriteJson(projectRoot, 'factory/schema/project.schema.json', loadCatalog(INFRA_ROOT, 'factory/schema/project.schema.json'));
  for (const relative of CITY_BOOTSTRAP_FILES) {
    atomicWriteJson(projectRoot, relative, loadCatalog(INFRA_ROOT, relative));
  }
  atomicWriteJson(projectRoot, 'factory/artifacts.json', {
    $schema: './schema/artifact-graph.schema.json', schemaVersion: '1.0.0',
    nodes: [
      { id: 'project-intent', type: 'intent', path: 'factory/project.json' },
      { id: 'project-requirements', type: 'requirement', path: 'factory/project.json' },
    ],
    edges: [{ from: 'project-intent', to: 'project-requirements', type: 'defines' }],
  });
  return { status: 'created', files, manifest };
}

function detectProject(root, options = {}) {
  const projectRoot = fs.realpathSync.native(path.resolve(root));
  const loaded = fs.existsSync(path.join(projectRoot, 'factory', 'project.json')) ? loadManifest(projectRoot) : null;
  const localCatalog = path.join(projectRoot, 'factory', 'catalog', 'stack-signals.json');
  const context = resolveProject(projectRoot);
  const requiresLocalCatalog = context.scope === 'child';
  const catalog = options.catalog || ((fs.existsSync(localCatalog) || requiresLocalCatalog)
    ? loadCatalog(projectRoot, 'factory/catalog/stack-signals.json') : undefined);
  const detection = detectStack(projectRoot, {
    maxDepth: options.maxDepth, catalog, declarations: loaded?.manifest.stack?.declared || [],
  });
  const report = { ...detection, manifestDigest: loaded?.digest || null, generatedAt: new Date().toISOString() };
  if (options.write && !options.dryRun) atomicWriteJson(projectRoot, '.factory/detection.json', report);
  return report;
}

function buildSteps(policy, catalog) {
  const required = new Set(policy.requiredGates);
  return catalog.steps.map(step => {
    let applicable = true;
    let naReason;
    if (step.gate === 'architecture' && !['medium', 'high', 'critical'].includes(policy.effectiveRisk)) {
      applicable = false; naReason = 'effective risk is low';
    } else if (step.gate && !required.has(step.gate)) {
      applicable = false; naReason = `policy does not require ${step.gate}`;
    }
    return { id: step.id, needs: step.needs, gate: step.gate, applicable, ...(naReason ? { naReason } : {}) };
  });
}

function loadPlanningCatalogs(root = INFRA_ROOT) {
  const documents = {};
  const digests = {};
  for (const filename of PLANNING_CATALOG_FILES) {
    const relative = `factory/catalog/${filename}`;
    const record = loadCatalogRecord(root, relative);
    const key = filename.replace(/\.json$/, '').replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());
    documents[key] = record.document;
    digests[relative] = record.contentDigest;
  }
  return { documents, digests };
}

function planHashPayload(plan) {
  return {
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
  };
}

function detectionSemantics(detection) {
  return {
    components: detection.components,
    capabilities: detection.capabilities,
    gaps: detection.gaps,
  };
}

function resolvePlanSemantics(projectRoot, loadedManifest, detection, planningCatalogs = loadPlanningCatalogs(projectRoot)) {
  const { documents: catalogs, digests: catalogDigests } = planningCatalogs;
  const currentDetection = detection || detectProject(projectRoot, { catalog: catalogs.stackSignals });
  const evaluatedPolicy = evaluatePolicy({ manifest: loadedManifest.manifest, detection: currentDetection, catalogs });
  const workflow = catalogs.workflow;
  const providerCatalog = catalogs.evidenceProviders;
  const adapterCatalog = catalogs.adapters;
  const toolchainTrustSnapshot = loadToolchainTrust(projectRoot);
  const providerPlan = bindEvidenceProviders({
    workflow, providerCatalog, adapterCatalog, catalogDigests, detection: currentDetection,
    steps: buildSteps(evaluatedPolicy, workflow),
    projectRoot, toolchainTrust: toolchainTrustSnapshot,
  });
  const policyGaps = [...evaluatedPolicy.gaps, ...providerPlan.gaps];
  const policy = { ...evaluatedPolicy, status: policyGaps.length ? 'blocked' : 'ready', gaps: policyGaps };
  return {
    manifestDigest: loadedManifest.digest,
    detection: currentDetection,
    policy,
    steps: providerPlan.steps,
    catalogDigests,
    toolchainTrust: toolchainTrustPlanIdentity(toolchainTrustSnapshot),
  };
}

function planSemanticsPayload(plan) {
  return {
    manifestDigest: plan.manifestDigest,
    detection: detectionSemantics(plan.detection || {}),
    policy: plan.policy,
    steps: plan.steps,
    catalogDigests: plan.catalogDigests,
    toolchainTrust: plan.toolchainTrust,
  };
}

function planProject(root, options = {}) {
  const projectRoot = fs.realpathSync.native(path.resolve(root));
  const loadedManifest = loadManifest(projectRoot);
  const { manifest, digest: manifestDigest } = loadedManifest;
  const planningCatalogs = loadPlanningCatalogs(projectRoot);
  const detection = detectProject(projectRoot, { catalog: planningCatalogs.documents.stackSignals });
  const semantics = resolvePlanSemantics(projectRoot, loadedManifest, detection, planningCatalogs);
  const runId = options.runId || `run-${new Date().toISOString().replace(/[^0-9]/g, '').slice(0, 14)}`;
  const plan = {
    schemaVersion: '1.1.0', runId, goal: options.goal || manifest.project.intent,
    manifestDigest, detection, policy: semantics.policy, steps: semantics.steps,
    catalogDigests: semantics.catalogDigests, toolchainTrust: semantics.toolchainTrust,
    createdAt: new Date().toISOString(),
  };
  validateWorkflow(plan);
  plan.planHash = hashValue(planHashPayload(plan));
  if (!options.dryRun) {
    const store = new FactoryStore(projectRoot);
    store.writePlan(runId, plan);
    atomicWriteJson(projectRoot, '.factory/latest.json', { runId });
    store.writeCheckpoint(runId, { schemaVersion: '1.0.0', runId, running: null, updatedAt: new Date().toISOString() });
  }
  return { plan };
}

function selectedRun(root, options = {}) {
  if (options.run) return options.run;
  const latest = readJson(root, '.factory/latest.json');
  if (!latest?.runId) throw new Error('no factory run exists');
  return latest.runId;
}

function assessedEvidence(identity, plan, evidence, expectedSteps = plan.steps) {
  return evidence.map(item => {
    const binding = expectedSteps.find(step => step.id === item.stepId)?.evidenceBinding;
    return {
      ...item,
      ...assessEvidence(item, {
      sourceTreeHash: identity.sourceTreeHash,
      certificationIdentityDigest: identity.certificationIdentityDigest,
      planHash: plan.planHash,
      requireBinding: true,
      providerId: binding?.providerId,
      bindingDigest: binding?.bindingDigest,
      evidenceBinding: binding,
      commandHash: binding && (binding.targetAggregateHash || binding.commandAggregateHash
        || hashValue({ providerId: binding.providerId, operation: binding.operation })),
      }),
    };
  });
}

/** The run `statusProject` reads (the latest unless one is named), checked to exist, without its plan check or tree hash. */
function selectedRunId(root, options = {}) {
  const projectRoot = fs.realpathSync.native(path.resolve(root));
  const runId = selectedRun(projectRoot, options);
  if (!new FactoryStore(projectRoot).readPlan(runId)) throw new Error(`run not found: ${runId}`);
  return runId;
}

function statusProject(root, options = {}) {
  const projectRoot = fs.realpathSync.native(path.resolve(root));
  const runId = selectedRun(projectRoot, options);
  const store = new FactoryStore(projectRoot);
  const plan = store.readPlan(runId);
  if (!plan) throw new Error(`run not found: ${runId}`);
  const runLocked = store.hasRunLock(runId);
  const currentManifest = loadManifest(projectRoot);
  const expectedSemantics = resolvePlanSemantics(projectRoot, currentManifest);
  const planFresh = currentManifest.digest === plan.manifestDigest
    && hashValue(planHashPayload(plan)) === plan.planHash
    && plan.schemaVersion === '1.1.0'
    && plan.runId === runId
    && typeof plan.goal === 'string' && plan.goal.length > 0
    && hashValue(planSemanticsPayload(plan)) === hashValue(planSemanticsPayload(expectedSemantics));
  const certificationIdentity = computeCertificationIdentity(projectRoot);
  const evidence = assessedEvidence(certificationIdentity, plan, store.listEvidence(runId), expectedSemantics.steps)
    .map(item => planFresh ? item : {
      ...item, fresh: false, reasons: [...new Set([...(item.reasons || []), 'plan semantics mismatch'])],
    });
  const checkpoint = store.readCheckpoint(runId);
  const workflow = evaluateWorkflow(plan, evidence, checkpoint);
  if (!planFresh || runLocked) { workflow.runState = 'BLOCKED'; workflow.ready = []; }
  return { runId, plan, planFresh, runLocked, certificationIdentity, evidence, workflow };
}

function collectAcceptedEvidenceFromStatus(status, options = {}) {
  const latest = new Map();
  for (const item of status.evidence) {
    const previous = latest.get(item.stepId);
    if (!previous || item.attempt >= previous.attempt) latest.set(item.stepId, item);
  }
  const knownSteps = new Set(status.plan.steps.map(step => step.id));
  let consideredSteps = knownSteps;
  if (options.beforeStepId !== undefined) {
    const boundary = status.plan.steps.findIndex(step => step.id === options.beforeStepId);
    if (boundary < 0) throw new Error(`unknown evidence selection boundary: ${options.beforeStepId}`);
    consideredSteps = new Set(status.plan.steps.slice(0, boundary).map(step => step.id));
  }
  const accepted = [];
  const gaps = [];
  if (!status.planFresh) gaps.push({ code: 'STALE_PLAN', message: 'plan semantics do not match current trusted inputs' });
  if (status.runLocked) gaps.push({ code: 'RUN_LOCK_HELD', message: 'workflow run lock requires owner recovery' });
  for (const step of status.plan.steps) {
    if (validateEvidenceBinding(step.evidenceBinding).length) {
      gaps.push({ code: 'LEGACY_UNBOUND_PLAN', stepId: step.id });
    }
  }
  for (const [stepId, item] of [...latest.entries()].sort(([left], [right]) => left.localeCompare(right))) {
    if (!knownSteps.has(stepId)) {
      gaps.push({ code: 'PROVENANCE_EVIDENCE_UNKNOWN_STEP', stepId });
      continue;
    }
    if (!consideredSteps.has(stepId)) continue;
    const derived = status.workflow.steps[stepId];
    const acceptedStatus = item.status === 'PASS' || (item.status === 'NA' && derived?.state === 'NA');
    if (!item.fresh || !acceptedStatus || !/^[a-f0-9]{64}$/.test(item.digest || '')) {
      gaps.push({
        code: item.reasons?.includes('UNTRUSTED_LEGACY_COMMAND') ? 'UNTRUSTED_LEGACY_COMMAND' : 'PROVENANCE_EVIDENCE_REJECTED', stepId, status: item.status,
        reasons: item.reasons || [],
      });
      continue;
    }
    accepted.push(item);
  }
  const digests = [...new Set(accepted.map(item => item.digest))].sort();
  if (digests.length === 0) gaps.push({ code: 'PROVENANCE_EVIDENCE_MISSING' });
  return {
    status: gaps.length ? 'FAIL' : 'PASS', runId: status.runId, digests,
    evidence: accepted, gaps, certificationIdentity: status.certificationIdentity,
  };
}

function collectAcceptedEvidence(root, options = {}) {
  try {
    return collectAcceptedEvidenceFromStatus(statusProject(root, options));
  } catch (error) {
    return {
      status: 'FAIL', runId: null, digests: [], evidence: [],
      gaps: [{ code: 'PROVENANCE_RUN_MISSING', message: error.message }],
    };
  }
}

function resumeProject(root, options = {}) {
  const status = statusProject(root, options);
  const failed = Object.entries(status.workflow.steps).filter(([, value]) => value.state === 'FAIL').map(([id]) => id);
  return {
    runId: status.runId,
    runState: status.workflow.runState,
    ready: [...new Set([...status.workflow.ready, ...(options.retryFailed ? failed : [])])],
    failed,
    blocked: Object.entries(status.workflow.steps).filter(([, value]) => value.state === 'BLOCKED').map(([id]) => id),
  };
}

async function runProjectStep(root, options = {}) {
  const projectRoot = fs.realpathSync.native(path.resolve(root));
  const status = statusProject(projectRoot, options);
  if (status.runLocked) throw Object.assign(new Error('workflow run lock is already held'), { code: 'RUN_LOCK_HELD' });
  if (!status.planFresh) throw new Error('workflow plan is stale for the current manifest');
  if (status.plan.policy.status !== 'ready') throw new Error('workflow policy is blocked');
  const derived = status.workflow.steps[options.step];
  const retryableFailure = derived?.state === 'FAIL';
  if (!status.workflow.ready.includes(options.step) && !retryableFailure) throw new Error(`step is not ready: ${options.step}`);
  if (validateEvidenceBinding(status.plan.steps.find(step => step.id === options.step)?.evidenceBinding).length) {
    throw new Error(`LEGACY_UNBOUND_PLAN: ${options.step}`);
  }
  const attempts = status.evidence.filter(item => item.stepId === options.step).map(item => item.attempt || 0);
  const attempt = Math.max(0, ...attempts) + 1;
  const store = new FactoryStore(projectRoot);
  const lock = store.acquireRunLock(status.runId, options.step);
  try {
    store.writeCheckpoint(status.runId, {
      schemaVersion: '1.0.0', runId: status.runId,
      running: { stepId: options.step, leaseExpiresAt: new Date(Date.now() + 10 * 60 * 1000).toISOString() },
      updatedAt: new Date().toISOString(),
    });
    const evidenceSelection = collectAcceptedEvidenceFromStatus(status, { beforeStepId: options.step });
    const providerExecutors = createStageProviderExecutors({
      root: projectRoot,
      runSnapshot: status,
      evidenceSelection,
    });
    const evidence = await runStep(
      { id: options.step, evidenceBinding: status.plan.steps.find(step => step.id === options.step).evidenceBinding },
      {
        root: projectRoot, attempt, planHash: status.plan.planHash, plan: status.plan,
        commandArgv: options.commandArgv, providerExecutors,
      }
    );
    store.writeEvidence(status.runId, evidence);
    return { runId: status.runId, evidence };
  } finally {
    let checkpointError;
    try {
      store.writeCheckpoint(status.runId, {
        schemaVersion: '1.0.0', runId: status.runId,
        running: null, updatedAt: new Date().toISOString(),
      });
    } catch (error) {
      checkpointError = error;
    }
    let releaseError;
    try {
      store.releaseRunLock(status.runId, lock.token);
    } catch (error) {
      releaseError = error;
    }
    if (releaseError) throw releaseError;
    if (checkpointError) throw checkpointError;
  }
}

function verifyProject(root, options = {}) {
  const status = statusProject(root, options);
  const gaps = [];
  if (!status.planFresh) gaps.push({ code: 'stale-plan', message: 'plan manifest digest does not match current manifest' });
  if (status.plan.policy.status !== 'ready') gaps.push(...status.plan.policy.gaps.map(gap => ({ ...gap, source: 'policy' })));
  for (const [stepId, value] of Object.entries(status.workflow.steps)) {
    if (!['PASS', 'NA'].includes(value.state)) gaps.push({ stepId, state: value.state, message: `step ${stepId} is ${value.state}` });
  }
  const afterIdentity = computeCertificationIdentity(root);
  if (afterIdentity.certificationIdentityDigest !== status.certificationIdentity.certificationIdentityDigest) {
    gaps.push({ code: 'certification-input-changed', message: 'certification input changed during verification' });
  }
  return {
    status: gaps.length ? 'FAIL' : 'PASS', runId: status.runId,
    treeHash: afterIdentity.sourceTreeHash,
    certificationIdentityDigest: afterIdentity.certificationIdentityDigest,
    layoutInputDigest: afterIdentity.layoutInputDigest,
    gaps,
  };
}

function explainProject(root, options = {}) {
  const status = statusProject(root, options);
  const step = options.step ? status.plan.steps.find(item => item.id === options.step) : null;
  if (options.step && !step) throw new Error(`unknown workflow step: ${options.step}`);
  return {
    runId: status.runId,
    policy: status.plan.policy,
    workflow: status.workflow,
    ...(step ? { step: { ...step, derivedState: status.workflow.steps[step.id] } } : {}),
  };
}

module.exports = {
  collectAcceptedEvidence, collectAcceptedEvidenceFromStatus, defaultManifest, detectProject, explainProject, initProject, planProject,
  resumeProject, runProjectStep, selectedRunId, statusProject, verifyProject,
};
