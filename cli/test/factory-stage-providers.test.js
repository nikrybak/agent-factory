'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  collectAcceptedEvidenceFromStatus, initProject, planProject, runProjectStep, statusProject,
} = require('../lib/factory/engine');
const { computeCertificationIdentity } = require('../lib/factory/identity');
const { certifyCity } = require('../lib/factory/city');
const { publicKeyIdentity } = require('../lib/factory/provenance');
const {
  createStageProviderExecutors, sanitizeStageMetadata, STAGE_OPERATIONS,
} = require('../lib/factory/stage-providers');

test('stage summaries are sanitized before their evidence digest boundary', () => {
  const canary = 'stage-summary-secret-canary';
  const raw = { delivery: { rollback: { token: canary }, note: `password=${canary}` } };
  const safe = sanitizeStageMetadata(raw);
  assert.equal(JSON.stringify(safe).includes(canary), false);
  assert.equal(safe.delivery.rollback.token, '<redacted>');
  assert.equal(raw.delivery.rollback.token, canary);
});

function write(root, relative, content = '') {
  const filename = path.join(root, relative);
  fs.mkdirSync(path.dirname(filename), { recursive: true });
  fs.writeFileSync(filename, content);
}

function completeGraph() {
  return {
    schemaVersion: '1.0.0',
    nodes: [
      { id: 'intent-root', type: 'intent', path: 'intent.md' },
      { id: 'requirement-root', type: 'requirement', path: 'requirement.md' },
      { id: 'spec-root', type: 'spec', path: 'spec.md' },
      { id: 'adr-root', type: 'adr', path: 'adr.md' },
      { id: 'module-root', type: 'module', path: 'module.js' },
      { id: 'test-root', type: 'test', path: 'module.test.js' },
      { id: 'evidence-root', type: 'evidence', path: 'evidence.txt' },
      { id: 'release-root', type: 'release', path: 'release.txt' },
    ],
    edges: [
      { from: 'intent-root', to: 'requirement-root', type: 'defines' },
      { from: 'requirement-root', to: 'spec-root', type: 'specified-by' },
      { from: 'requirement-root', to: 'adr-root', type: 'governed-by' },
      { from: 'spec-root', to: 'module-root', type: 'implemented-by' },
      { from: 'module-root', to: 'test-root', type: 'verified-by' },
      { from: 'test-root', to: 'evidence-root', type: 'produces' },
      { from: 'evidence-root', to: 'release-root', type: 'qualifies' },
    ],
  };
}

function workflowFixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'factory-stage-dag-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  write(root, 'package.json', JSON.stringify({
    name: 'stage-dag-fixture', version: '1.0.0',
    bin: { fixture: './module.js' },
    scripts: { test: 'node module.test.js', coverage: 'node module.test.js' },
  }));
  write(root, 'package-lock.json', JSON.stringify({
    name: 'stage-dag-fixture', version: '1.0.0', lockfileVersion: 3, requires: true,
    packages: {
      '': {
        name: 'stage-dag-fixture', version: '1.0.0',
        bin: { fixture: 'module.js' },
      },
    },
  }));
  initProject(root, { name: 'Stage DAG Fixture', profiles: ['cli'] });
  const manifestFile = path.join(root, 'factory/project.json');
  const manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8'));
  manifest.quality.requiredGates = [];
  manifest.quality.additionalChecks = ['traceability'];
  fs.writeFileSync(manifestFile, JSON.stringify(manifest));
  for (const file of ['intent.md', 'requirement.md', 'spec.md', 'adr.md', 'module.js', 'module.test.js', 'evidence.txt', 'release.txt']) {
    write(root, file, file.endsWith('.js') ? "'use strict';\n" : `${file}\n`);
  }
  write(root, 'docs/app-architecture/ARCHITECTURE.md', '# Architecture\n');
  write(root, 'docs/operations/MEMORY.md', '# Memory\n');
  write(root, 'tasks/CURRENT_SPRINT.md', '# Sprint\n');
  fs.writeFileSync(path.join(root, 'factory/artifacts.json'), JSON.stringify(completeGraph()));
  return root;
}

test('every stage executor rejects a wrong step or selected evidence run before side effects', async t => {
  const root = workflowFixture(t);
  const identity = computeCertificationIdentity(root);
  const runSnapshot = {
    runId: 'selected-run', planFresh: true,
    plan: { policy: { status: 'ready' }, steps: [] },
    certificationIdentity: identity,
    evidence: [],
    workflow: { runState: 'READY', steps: { intake: { state: 'READY' } } },
  };
  const executors = createStageProviderExecutors({
    root, runSnapshot,
    evidenceSelection: {
      status: 'PASS', runId: 'different-run', digests: ['a'.repeat(64)],
      certificationIdentity: identity,
    },
  });
  assert.deepEqual(Object.keys(executors).sort(), [...STAGE_OPERATIONS].sort());
  for (const operation of STAGE_OPERATIONS) {
    const result = await executors[operation]();
    assert.equal(result.status, 'FAIL', operation);
    assert.match(result.reason, /WORKFLOW_STAGE|STAGE_PROVIDER_EVIDENCE_RUN_MISMATCH/, operation);
  }
  assert.equal(fs.existsSync(path.join(root, '.factory/ledger.jsonl')), false);
});

test('a fresh governed 20-step DAG reaches COMPLETE and retains scoped prepare evidence', async t => {
  const root = workflowFixture(t);
  const bin = path.join(__dirname, '..', 'bin', 'infra.js');
  const invoke = argv => {
    const result = spawnSync(process.execPath, [bin, ...argv], { encoding: 'utf8', windowsHide: true });
    return { ...result, json: result.stdout ? JSON.parse(result.stdout) : null };
  };
  const pair = crypto.generateKeyPairSync('ed25519');
  const keyIdentity = publicKeyIdentity(pair.publicKey);
  const policyFile = path.join(root, 'factory/catalog/trust-policy.json');
  const policy = JSON.parse(fs.readFileSync(policyFile, 'utf8'));
  policy.provenance = {
    schemaVersion: '1.0.0', algorithm: 'Ed25519',
    trustedKeys: [{
      keyId: 'release-test', publicKeySpkiBase64: keyIdentity.publicKeySpkiBase64,
      fingerprintSha256: keyIdentity.fingerprintSha256,
    }],
  };
  fs.writeFileSync(policyFile, JSON.stringify(policy));
  const privatePem = pair.privateKey.export({ type: 'pkcs8', format: 'pem' });
  const insideKey = path.join(root, 'inside-private-key.pem');
  fs.writeFileSync(insideKey, privatePem);
  const externalDir = fs.mkdtempSync(path.join(os.tmpdir(), 'factory-release-key-'));
  t.after(() => fs.rmSync(externalDir, { recursive: true, force: true }));
  const externalKey = path.join(externalDir, 'release-private-key.pem');
  fs.writeFileSync(externalKey, privatePem);
  const insideLink = path.join(root, 'inside-external-key-link.pem');
  let insideLinkCreated = false;
  try {
    fs.symlinkSync(externalKey, insideLink, 'file');
    insideLinkCreated = true;
  } catch (error) {
    if (!['EPERM', 'EACCES', 'UNKNOWN'].includes(error.code)) throw error;
  }
  planProject(root, { runId: 'complete-dag', goal: 'Prove the full governed workflow' });
  const initial = statusProject(root, { run: 'complete-dag' });
  const firstStep = initial.workflow.ready[0];
  const firstResult = await runProjectStep(root, { run: 'complete-dag', step: firstStep });
  assert.equal(firstResult.evidence.status, 'PASS');
  const incompleteWrite = invoke([
    'attest', '--project', root, '--run', 'complete-dag', '--write', '--json',
  ]);
  assert.equal(incompleteWrite.status, 1);
  assert.match(incompleteWrite.json.diagnostics[0].message, /explicit COMPLETE workflow run/);
  assert.equal(fs.existsSync(path.join(root, '.factory/provenance.json')), false);
  const executed = [firstStep];
  for (let guard = 0; guard < 30; guard += 1) {
    const snapshot = statusProject(root, { run: 'complete-dag' });
    if (snapshot.workflow.runState === 'COMPLETE') break;
    assert.ok(snapshot.workflow.ready.length > 0, JSON.stringify(snapshot.workflow));
    const step = snapshot.workflow.ready[0];
    const result = await runProjectStep(root, { run: 'complete-dag', step });
    assert.equal(result.evidence.status, 'PASS', `${step}: ${result.evidence.reason || ''}`);
    executed.push(step);
  }

  const completed = statusProject(root, { run: 'complete-dag' });
  assert.equal(completed.plan.steps.length, 20);
  assert.equal(completed.workflow.runState, 'COMPLETE');
  assert.ok(Object.values(completed.workflow.steps).every(step => ['PASS', 'NA'].includes(step.state)));
  assert.ok(executed.includes('evals'));
  assert.ok(executed.includes('observability'));
  assert.ok(executed.includes('city-certification'));
  assert.ok(executed.includes('quality'));
  assert.ok(executed.includes('release-checkpoint'));
  assert.equal(collectAcceptedEvidenceFromStatus(completed).status, 'PASS');

  const cityEvidence = completed.evidence.find(item => item.stepId === 'city-certification');
  const certification = cityEvidence.components[0].metadata.certification;
  assert.equal(certification.status, 'COMPLETE');
  assert.equal(certification.workflowRunId, 'complete-dag');
  assert.equal(certification.workflowComplete, false);
  assert.equal(Object.hasOwn(cityEvidence.components[0].metadata, 'reports'), false);

  const qualityEvidence = completed.evidence.find(item => item.stepId === 'quality');
  assert.deepEqual(qualityEvidence.components[0].metadata.additionalChecks.map(item => item.providerId), ['traceability']);

  const releaseEvidence = completed.evidence.find(item => item.stepId === 'release-checkpoint');
  const delivery = releaseEvidence.components[0].metadata.delivery;
  assert.equal(delivery.status, 'PASS');
  assert.equal(delivery.action, 'prepare');
  assert.equal(delivery.workflowRunId, 'complete-dag');
  assert.equal(delivery.workflowComplete, false);
  assert.deepEqual(delivery.rollback, { type: 'restore-previous-artifact', verify: true });

  const implicitWrite = invoke(['attest', '--project', root, '--write', '--json']);
  assert.equal(implicitWrite.status, 1);
  assert.match(implicitWrite.json.diagnostics[0].message, /explicit COMPLETE workflow run/);
  const advisory = invoke(['attest', '--project', root, '--run', 'complete-dag', '--json']);
  assert.equal(advisory.status, 0, advisory.stderr);
  assert.equal(advisory.json.status, 'ADVISORY');
  assert.equal(advisory.json.data.releaseAssessment.releaseGrade, false);

  const inside = invoke([
    'attest', '--project', root, '--run', 'complete-dag', '--private-key', insideKey, '--json',
  ]);
  assert.equal(inside.status, 1);
  assert.equal(inside.json.status, 'FAIL');
  assert.equal(inside.stdout.includes(privatePem.slice(0, 20)), false);
  if (insideLinkCreated) {
    const linked = invoke([
      'attest', '--project', root, '--run', 'complete-dag', '--private-key', insideLink, '--json',
    ]);
    assert.equal(linked.status, 1);
    assert.equal(linked.json.diagnostics[0].code, 'PROVENANCE_PRIVATE_KEY_UNAVAILABLE');
  }
  const pathCanary = 'private-key-path-canary';
  const missingKey = path.join(externalDir, `${pathCanary}.pem`);
  const missing = invoke([
    'attest', '--project', root, '--run', 'complete-dag', '--private-key', missingKey, '--json',
  ]);
  assert.equal(missing.status, 1);
  assert.equal(missing.stdout.includes(pathCanary), false);
  assert.equal(missing.json.diagnostics[0].code, 'PROVENANCE_PRIVATE_KEY_UNAVAILABLE');

  const signed = invoke([
    'attest', '--project', root, '--run', 'complete-dag', '--private-key', externalKey, '--write', '--json',
  ]);
  assert.equal(signed.status, 0, signed.stderr);
  assert.equal(signed.json.status, 'PASS');
  assert.equal(signed.json.data.releaseAssessment.releaseGrade, true);
  assert.equal(signed.stdout.includes(externalKey), false);
  const persisted = JSON.parse(fs.readFileSync(path.join(root, '.factory/provenance.json'), 'utf8'));
  assert.deepEqual(Object.keys(persisted).sort(), ['attestation', 'schemaVersion', 'workflowRunId']);
  assert.equal(persisted.workflowRunId, 'complete-dag');
  assert.equal(JSON.stringify(persisted).includes(externalKey), false);
  assert.equal(JSON.stringify(persisted).includes('PRIVATE KEY'), false);

  const finalSnapshot = statusProject(root, { run: 'complete-dag' });
  const finalCity = certifyCity(root, {
    purpose: 'certify', explicitRun: true, runSnapshot: finalSnapshot,
    evidenceSelection: collectAcceptedEvidenceFromStatus(finalSnapshot),
  });
  assert.equal(finalCity.status, 'COMPLETE');
  assert.equal(finalCity.reports.provenance.releaseAssessment.releaseGrade, true);

  fs.writeFileSync(path.join(root, '.factory/provenance.json'), JSON.stringify({
    ...persisted, workflowRunId: 'wrong-run',
  }));
  const staleCity = certifyCity(root, {
    purpose: 'certify', explicitRun: true, runSnapshot: finalSnapshot,
    evidenceSelection: collectAcceptedEvidenceFromStatus(finalSnapshot),
  });
  assert.equal(staleCity.status, 'FAIL');
  assert.ok(staleCity.reports.provenance.gaps.some(gap => gap.code === 'PROVENANCE_RUN_MISMATCH'));
});
