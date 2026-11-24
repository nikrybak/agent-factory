'use strict';

const PURPOSES = Object.freeze({
  eval: Object.freeze({ stepId: 'evals', allowedStates: ['READY'], candidate: true, requiresScope: true }),
  'observe-record': Object.freeze({ stepId: 'observability', allowedStates: ['READY'], candidate: true, requiresScope: true }),
  certify: Object.freeze({ stepId: 'city-certification', allowedStates: ['READY'], allowComplete: true, requiresScope: true }),
  prepare: Object.freeze({ stepId: 'city-certification', allowedStates: ['READY'], allowComplete: true, requiresScope: true }),
  'release-checkpoint-prepare': Object.freeze({ stepId: 'release-checkpoint', allowedStates: ['READY'], allowComplete: true }),
  release: Object.freeze({ allowComplete: true, completeOnly: true, requiresScope: true }),
  deploy: Object.freeze({ allowComplete: true, completeOnly: true, requiresScope: true }),
  publish: Object.freeze({ allowComplete: true, completeOnly: true, requiresScope: true }),
});

function gap(code, message) { return { code, message }; }

function isWorkflowStepRunnable(workflow, stepId, allowedStates = ['READY']) {
  const state = workflow?.steps?.[stepId]?.state || 'MISSING';
  const queued = Array.isArray(workflow?.ready) && workflow.ready.includes(stepId);
  return allowedStates.includes(state) || queued || state === 'FAIL';
}

function assessWorkflowStage({ purpose, runSnapshot, explicitRun = false } = {}) {
  const rule = PURPOSES[purpose];
  if (!rule) throw new Error(`unsupported workflow-stage purpose: ${purpose}`);

  const gaps = [];
  const workflow = runSnapshot?.workflow;
  const runId = runSnapshot?.runId || null;
  const workflowComplete = workflow?.runState === 'COMPLETE';
  const stepState = rule.stepId ? workflow?.steps?.[rule.stepId]?.state || 'MISSING' : null;

  if (!runId || !workflow) {
    gaps.push(gap('WORKFLOW_STAGE_RUN_MISSING', 'an explicit selected-run snapshot is required'));
  } else {
    if (runSnapshot.planFresh !== true) {
      gaps.push(gap('WORKFLOW_STAGE_PLAN_STALE', 'the selected workflow plan is stale'));
    }
    if (runSnapshot.plan?.policy?.status !== 'ready') {
      gaps.push(gap('WORKFLOW_STAGE_POLICY_BLOCKED', 'the selected workflow policy is blocked'));
    }
    if (rule.completeOnly && !workflowComplete) {
      gaps.push(gap('WORKFLOW_STAGE_INCOMPLETE', `purpose '${purpose}' requires a COMPLETE workflow`));
    } else if (!workflowComplete || !rule.allowComplete) {
      if (rule.stepId && !isWorkflowStepRunnable(workflow, rule.stepId, rule.allowedStates)) {
        gaps.push(gap(
          'WORKFLOW_STAGE_NOT_READY',
          `purpose '${purpose}' requires ${rule.stepId} in ${rule.allowedStates.join(' or ')}, found ${stepState}`,
        ));
      }
    }
  }

  if (rule.requiresScope && !explicitRun) {
    gaps.push(gap('WORKFLOW_STAGE_EXPLICIT_RUN_REQUIRED', `purpose '${purpose}' requires an explicit run id`));
  }

  const authorized = gaps.length === 0;
  const trusted = authorized && explicitRun;
  return {
    schemaVersion: '1.0.0',
    purpose,
    runId,
    status: authorized ? (trusted ? 'PASS' : 'ADVISORY') : 'FAIL',
    level: rule.candidate ? 'candidate' : 'full',
    authorized,
    trusted,
    advisory: authorized && !trusted,
    workflowComplete,
    requiredStep: rule.stepId || null,
    stepState,
    gaps,
  };
}

function candidateResult(report) {
  if (!report || typeof report !== 'object') throw new TypeError('candidate report is required');
  const passed = report.status === 'PASS' || report.status === 'COMPLETE';
  return {
    ...report,
    status: passed ? 'PASS' : 'FAIL',
    level: 'candidate',
    sourceStatus: report.status,
  };
}

module.exports = { PURPOSES, assessWorkflowStage, candidateResult, isWorkflowStepRunnable };
