const { test } = require('node:test');
const assert = require('node:assert/strict');
const { planDelivery } = require('../lib/factory/delivery');

const manifest = { authority: { release: false, deploy: false, publish: false, networkWrite: false, destructive: false } };
const prepareRun = {
  runId: 'selected-run', planFresh: true, plan: { policy: { status: 'ready' } },
  workflow: { runState: 'READY', steps: { 'city-certification': { state: 'READY' } } },
};
const outwardRun = {
  runId: 'selected-run', planFresh: true, plan: { policy: { status: 'ready' } },
  workflow: { runState: 'COMPLETE', steps: {} },
};

test('delivery preparation always includes verify/action/rollback and needs no outward authority', () => {
  const plan = planDelivery({
    manifest,
    action: 'prepare',
    certification: {
      status: 'COMPLETE',
      treeHash: 'a'.repeat(64),
      certificationIdentityDigest: 'b'.repeat(64),
      layoutInputDigest: 'c'.repeat(64),
    },
    runSnapshot: prepareRun,
    explicitRun: true,
  });
  assert.equal(plan.status, 'PASS');
  assert.deepEqual(plan.phases.map(item => item.id), ['verify', 'action', 'rollback']);
  assert.equal(plan.phases[2].required, true);
  assert.equal(plan.treeHash, 'a'.repeat(64));
  assert.equal(plan.certificationIdentityDigest, 'b'.repeat(64));
  assert.equal(plan.layoutInputDigest, 'c'.repeat(64));
  assert.equal(plan.workflowRunId, 'selected-run');
  assert.equal(plan.workflowComplete, false);
  assert.ok(plan.phases[0].checks.includes('certification-identity'));
});

test('delivery denies outward actions without matching authority or complete certification', () => {
  assert.equal(planDelivery({
    manifest, action: 'release', certification: { status: 'COMPLETE', workflowComplete: true },
    runSnapshot: outwardRun, explicitRun: true,
  }).status, 'DENIED');
  assert.equal(planDelivery({
    manifest: { authority: { ...manifest.authority, release: true } },
    action: 'release', certification: { status: 'FAIL', workflowComplete: true },
    runSnapshot: outwardRun, explicitRun: true,
  }).status, 'BLOCKED');
  assert.equal(
    planDelivery({
      manifest,
      certification: { status: 'COMPLETE', treeHash: 'a'.repeat(64), certificationIdentityDigest: 'b'.repeat(64) },
      runSnapshot: prepareRun,
      explicitRun: true,
    }).layoutInputDigest,
    undefined,
  );
  assert.throws(() => planDelivery({ manifest, action: 'destroy', certification: {} }), /unsupported/);
});

test('delivery independently blocks partial or unscoped outward workflows', () => {
  const allowedManifest = { authority: { ...manifest.authority, release: true } };
  const adapterPlan = { status: 'PASS', argv: ['release'], rollback: { type: 'restore', verify: true } };
  const certification = {
    status: 'COMPLETE', workflowComplete: true, treeHash: 'a'.repeat(64),
    reports: { provenance: { releaseAssessment: {
      releaseGrade: true, workflowRunId: 'selected-run',
    } } },
  };

  const partial = planDelivery({
    manifest: allowedManifest, action: 'release', certification, adapterPlan,
    runSnapshot: prepareRun, explicitRun: true,
  });
  assert.equal(partial.status, 'BLOCKED');

  const advisory = planDelivery({
    manifest: allowedManifest, action: 'release', certification, adapterPlan,
    runSnapshot: outwardRun,
  });
  assert.equal(advisory.status, 'BLOCKED');

  const complete = planDelivery({
    manifest: allowedManifest, action: 'release', certification: {
      ...certification,
      reports: { provenance: { releaseAssessment: {
        releaseGrade: true, workflowRunId: 'complete-run',
      } } },
    }, adapterPlan,
    runSnapshot: { ...outwardRun, runId: 'complete-run' }, explicitRun: true,
  });
  assert.equal(complete.status, 'PASS');
  assert.equal(complete.workflowRunId, 'complete-run');
});

test('outward delivery independently requires release-grade provenance for the selected run', () => {
  const allowedManifest = { authority: { ...manifest.authority, release: true } };
  const adapterPlan = { status: 'PASS', argv: ['release'], rollback: { type: 'restore', verify: true } };
  const base = { status: 'COMPLETE', workflowComplete: true, reports: { provenance: {} } };
  assert.match(planDelivery({
    manifest: allowedManifest, action: 'release', certification: base, adapterPlan,
    runSnapshot: outwardRun, explicitRun: true,
  }).reason, /release-grade provenance/);
  assert.match(planDelivery({
    manifest: allowedManifest, action: 'release', certification: {
      ...base, reports: { provenance: { releaseAssessment: {
        releaseGrade: true, workflowRunId: 'another-run',
      } } },
    }, adapterPlan,
    runSnapshot: outwardRun, explicitRun: true,
  }).reason, /release-grade provenance/);
});

test('release checkpoint can create a scoped prepare-only plan before workflow completion', () => {
  const checkpointRun = {
    runId: 'checkpoint-run', planFresh: true, plan: { policy: { status: 'ready' } },
    workflow: { runState: 'READY', steps: { 'release-checkpoint': { state: 'READY' } } },
  };
  const plan = planDelivery({
    manifest,
    certification: { status: 'COMPLETE', workflowComplete: false, treeHash: 'a'.repeat(64) },
    runSnapshot: checkpointRun,
    explicitRun: true,
    purpose: 'release-checkpoint-prepare',
  });
  assert.equal(plan.status, 'PASS');
  assert.equal(plan.action, 'prepare');
  assert.equal(plan.workflowComplete, false);
  assert.equal(plan.trusted, true);
});
