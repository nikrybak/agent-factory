'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { assessWorkflowStage, candidateResult } = require('../lib/factory/workflow-stage');

function snapshot(stepId, state = 'READY', runState = 'READY') {
  return {
    runId: 'selected-run',
    planFresh: true,
    plan: { policy: { status: 'ready' } },
    workflow: {
      runState,
      ready: stepId && state === 'READY' ? [stepId] : [],
      steps: stepId ? { [stepId]: { state } } : {},
    },
  };
}

test('workflow stage authorizes only the exact eval and observation boundaries', () => {
  const evalStage = assessWorkflowStage({ purpose: 'eval', runSnapshot: snapshot('evals'), explicitRun: true });
  assert.equal(evalStage.status, 'PASS');
  assert.equal(evalStage.level, 'candidate');

  const wrongEval = assessWorkflowStage({ purpose: 'eval', runSnapshot: snapshot('evals', 'PASS'), explicitRun: true });
  assert.equal(wrongEval.status, 'FAIL');
  assert.equal(wrongEval.gaps[0].code, 'WORKFLOW_STAGE_NOT_READY');

  const unscopedRecord = assessWorkflowStage({ purpose: 'observe-record', runSnapshot: snapshot('observability') });
  assert.equal(unscopedRecord.status, 'FAIL');
  assert.ok(unscopedRecord.gaps.some(item => item.code === 'WORKFLOW_STAGE_EXPLICIT_RUN_REQUIRED'));
});

test('workflow stage accepts canonical queued stale work and explicit failed-step retries', () => {
  const queuedStale = snapshot('evals', 'STALE');
  queuedStale.workflow.ready = ['evals'];
  assert.equal(assessWorkflowStage({
    purpose: 'eval', runSnapshot: queuedStale, explicitRun: true,
  }).status, 'PASS');

  const retry = snapshot('evals', 'FAIL');
  assert.equal(assessWorkflowStage({
    purpose: 'eval', runSnapshot: retry, explicitRun: true,
  }).status, 'PASS');

  const unqueuedStale = snapshot('evals', 'STALE');
  const rejected = assessWorkflowStage({
    purpose: 'eval', runSnapshot: unqueuedStale, explicitRun: true,
  });
  assert.equal(rejected.status, 'FAIL');
  assert.equal(rejected.gaps[0].code, 'WORKFLOW_STAGE_NOT_READY');
});

test('certification requires explicit scope and exposes workflow completion independently', () => {
  const boundary = assessWorkflowStage({ purpose: 'certify', runSnapshot: snapshot('city-certification') });
  assert.equal(boundary.status, 'FAIL');
  assert.equal(boundary.authorized, false);
  assert.equal(boundary.trusted, false);
  assert.equal(boundary.workflowComplete, false);
  assert.ok(boundary.gaps.some(item => item.code === 'WORKFLOW_STAGE_EXPLICIT_RUN_REQUIRED'));

  const completed = assessWorkflowStage({
    purpose: 'certify', runSnapshot: snapshot(null, null, 'COMPLETE'), explicitRun: true,
  });
  assert.equal(completed.status, 'PASS');
  assert.equal(completed.workflowComplete, true);
});

test('outward purposes require explicit scope and a complete workflow', () => {
  const partial = assessWorkflowStage({ purpose: 'release', runSnapshot: snapshot('city-certification'), explicitRun: true });
  assert.equal(partial.status, 'FAIL');
  assert.ok(partial.gaps.some(item => item.code === 'WORKFLOW_STAGE_INCOMPLETE'));

  const unscoped = assessWorkflowStage({ purpose: 'deploy', runSnapshot: snapshot(null, null, 'COMPLETE') });
  assert.equal(unscoped.status, 'FAIL');
  assert.ok(unscoped.gaps.some(item => item.code === 'WORKFLOW_STAGE_EXPLICIT_RUN_REQUIRED'));

  const completed = assessWorkflowStage({
    purpose: 'publish', runSnapshot: snapshot(null, null, 'COMPLETE'), explicitRun: true,
  });
  assert.equal(completed.status, 'PASS');
  assert.equal(completed.trusted, true);
});

test('release checkpoint has a dedicated prepare-only boundary without a completion cycle', () => {
  const stage = assessWorkflowStage({
    purpose: 'release-checkpoint-prepare', runSnapshot: snapshot('release-checkpoint'), explicitRun: true,
  });
  assert.equal(stage.status, 'PASS');
  assert.equal(stage.workflowComplete, false);
});

test('candidate reports can pass or fail but never return COMPLETE', () => {
  assert.deepEqual(candidateResult({ status: 'COMPLETE', value: 1 }), {
    status: 'PASS', value: 1, level: 'candidate', sourceStatus: 'COMPLETE',
  });
  assert.equal(candidateResult({ status: 'FAIL' }).status, 'FAIL');
  assert.throws(() => candidateResult(null), /candidate report is required/);
});

test('stage assessment rejects missing, stale, blocked, and unknown inputs', () => {
  const missing = assessWorkflowStage({ purpose: 'certify' });
  assert.equal(missing.status, 'FAIL');
  assert.equal(missing.gaps[0].code, 'WORKFLOW_STAGE_RUN_MISSING');

  const stale = snapshot('city-certification');
  stale.planFresh = false;
  stale.plan.policy.status = 'blocked';
  const rejected = assessWorkflowStage({ purpose: 'certify', runSnapshot: stale, explicitRun: true });
  assert.deepEqual(
    rejected.gaps.map(item => item.code),
    ['WORKFLOW_STAGE_PLAN_STALE', 'WORKFLOW_STAGE_POLICY_BLOCKED'],
  );
  assert.throws(() => assessWorkflowStage({ purpose: 'unknown', runSnapshot: stale }), /unsupported/);
});

test('eval, certification, and prepare cannot become trusted through latest-run fallback', () => {
  for (const [purpose, step] of [['eval', 'evals'], ['certify', 'city-certification'], ['prepare', 'city-certification']]) {
    const assessment = assessWorkflowStage({ purpose, runSnapshot: snapshot(step), explicitRun: false });
    assert.equal(assessment.authorized, false);
    assert.ok(assessment.gaps.some(gap => gap.code === 'WORKFLOW_STAGE_EXPLICIT_RUN_REQUIRED'));
  }
});
