'use strict';

const { assessWorkflowStage } = require('./workflow-stage');

const AUTHORITY = { release: 'release', deploy: 'deploy', publish: 'publish' };

function blocked(action, reason) {
  return { schemaVersion: '1.0.0', status: 'BLOCKED', action, reason, phases: [] };
}

function planDelivery({
  manifest, action = 'prepare', certification, adapterPlan = null,
  runSnapshot = null, explicitRun = false, purpose = null,
} = {}) {
  if (!['prepare', 'release', 'deploy', 'publish'].includes(action)) throw new Error(`unsupported delivery action: ${action}`);
  const complete = certification?.status === 'COMPLETE';
  if (!complete) return blocked(action, 'current-tree certification is incomplete');
  const stageAssessment = assessWorkflowStage({
    purpose: action === 'prepare' ? (purpose || 'prepare') : action,
    runSnapshot,
    explicitRun,
  });
  const allowedPreparePurposes = new Set(['prepare', 'certify', 'release-checkpoint-prepare']);
  if (!stageAssessment?.authorized
    || (action === 'prepare' && !allowedPreparePurposes.has(stageAssessment.purpose))
    || (action !== 'prepare' && stageAssessment.purpose !== action)) {
    return blocked(action, 'selected workflow stage does not authorize this delivery plan');
  }
  if (action !== 'prepare'
    && (!stageAssessment.trusted || !stageAssessment.workflowComplete || certification.workflowComplete !== true)) {
    return blocked(action, 'outward delivery requires an explicit COMPLETE workflow');
  }
  const authority = AUTHORITY[action];
  if (authority && manifest?.authority?.[authority] !== true) {
    return { schemaVersion: '1.0.0', status: 'DENIED', action, reason: `manifest authority '${authority}' is false`, phases: [] };
  }
  if (action !== 'prepare' && (!adapterPlan || adapterPlan.status !== 'PASS')) {
    return { schemaVersion: '1.0.0', status: 'BLOCKED', action, reason: 'a passing adapter plan is required', phases: [] };
  }
  const releaseAssessment = certification?.reports?.provenance?.releaseAssessment;
  if (action !== 'prepare' && (releaseAssessment?.releaseGrade !== true
    || releaseAssessment.workflowRunId !== stageAssessment.runId)) {
    return blocked(action, 'outward delivery requires current release-grade provenance for the selected run');
  }
  return {
    schemaVersion: '1.0.0', status: 'PASS', action, treeHash: certification.treeHash,
    workflowRunId: stageAssessment.runId,
    workflowComplete: stageAssessment.workflowComplete,
    trusted: stageAssessment.trusted,
    advisory: !stageAssessment.trusted,
    releaseProvenance: releaseAssessment || null,
    workflowStage: stageAssessment,
    ...(certification.certificationIdentityDigest && certification.layoutInputDigest ? {
      certificationIdentityDigest: certification.certificationIdentityDigest,
      layoutInputDigest: certification.layoutInputDigest,
    } : {}),
    phases: [
      { id: 'verify', required: true, checks: ['certification', 'tree-identity', 'certification-identity', 'authority', 'provenance'] },
      { id: 'action', required: true, mode: action, argv: adapterPlan?.argv || null },
      { id: 'rollback', required: true, strategy: adapterPlan?.rollback || { type: 'restore-previous-artifact', verify: true } },
    ],
  };
}

module.exports = { planDelivery };
