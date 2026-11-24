'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { loadCatalog } = require('./catalog-loader');
const { certifyCity, recordCityCertification } = require('./city');
const { planDelivery } = require('./delivery');
const { hashValue } = require('./hash');
const { loadManifest } = require('./manifest');
const { redactValue } = require('./redaction');
const { classifyStageProviderError, STAGE_OPERATIONS } = require('./stage-diagnostics');
const { assessWorkflowStage, isWorkflowStepRunnable } = require('./workflow-stage');

const DIGEST = /^[a-f0-9]{64}$/;

function sanitizeStageMetadata(value) {
  return redactValue(value);
}

function failure(gaps, metadata = {}) {
  const normalized = sanitizeStageMetadata(gaps.map(item => typeof item === 'string' ? { code: item } : item));
  const safeMetadata = sanitizeStageMetadata(metadata);
  return {
    status: 'FAIL',
    reason: normalized.map(item => item.code).join(', '),
    metadata: { ...safeMetadata, gaps: normalized },
  };
}

function stageGaps(purpose, runSnapshot, evidenceSelection) {
  const assessment = assessWorkflowStage({ purpose, runSnapshot, explicitRun: true });
  const gaps = [...assessment.gaps];
  if (!evidenceSelection || evidenceSelection.runId !== runSnapshot?.runId) {
    gaps.push({ code: 'STAGE_PROVIDER_EVIDENCE_RUN_MISMATCH' });
  }
  if (evidenceSelection?.certificationIdentity?.certificationIdentityDigest
    !== runSnapshot?.certificationIdentity?.certificationIdentityDigest) {
    gaps.push({ code: 'STAGE_PROVIDER_EVIDENCE_IDENTITY_MISMATCH' });
  }
  if (evidenceSelection?.status !== 'PASS') {
    gaps.push({ code: 'STAGE_PROVIDER_EVIDENCE_REJECTED' });
  }
  return { assessment, gaps };
}

function exactStepGaps(stepId, runSnapshot, evidenceSelection) {
  const gaps = [];
  if (!runSnapshot?.runId || !runSnapshot?.workflow) gaps.push({ code: 'WORKFLOW_STAGE_RUN_MISSING' });
  if (runSnapshot?.planFresh !== true) gaps.push({ code: 'WORKFLOW_STAGE_PLAN_STALE' });
  if (runSnapshot?.plan?.policy?.status !== 'ready') gaps.push({ code: 'WORKFLOW_STAGE_POLICY_BLOCKED' });
  const state = runSnapshot?.workflow?.steps?.[stepId]?.state || 'MISSING';
  if (!isWorkflowStepRunnable(runSnapshot?.workflow, stepId)) {
    gaps.push({ code: 'WORKFLOW_STAGE_NOT_READY', stepId, state });
  }
  if (!evidenceSelection || evidenceSelection.runId !== runSnapshot?.runId) {
    gaps.push({ code: 'STAGE_PROVIDER_EVIDENCE_RUN_MISMATCH' });
  }
  if (evidenceSelection?.certificationIdentity?.certificationIdentityDigest
    !== runSnapshot?.certificationIdentity?.certificationIdentityDigest) {
    gaps.push({ code: 'STAGE_PROVIDER_EVIDENCE_IDENTITY_MISMATCH' });
  }
  if (evidenceSelection?.status !== 'PASS') gaps.push({ code: 'STAGE_PROVIDER_EVIDENCE_REJECTED' });
  return gaps;
}

function reportError(operation, error) {
  return failure([classifyStageProviderError(operation, error)]);
}

function candidateEval(root, runSnapshot, evidenceSelection) {
  const { assessment, gaps } = stageGaps('eval', runSnapshot, evidenceSelection);
  if (gaps.length) return failure(gaps, { level: 'candidate', workflowRunId: runSnapshot?.runId || null });
  try {
    const city = certifyCity(root, {
      purpose: 'eval', ledgerMode: 'candidate', explicitRun: true,
      runSnapshot, evidenceSelection,
    });
    const evals = city.reports?.evals || {};
    const metadata = {
      level: 'candidate', workflowRunId: assessment.runId,
      cityStatus: city.status,
      evals: {
        status: evals.status || 'FAIL', score: evals.score ?? null,
        passed: evals.passed ?? null, total: evals.total ?? null,
      },
      reportDigest: hashValue(redactValue(city)),
    };
    return city.status === 'PASS'
      ? { status: 'PASS', metadata }
      : failure(city.gaps?.map(item => ({ code: `CITY_${item.district || 'UNKNOWN'}` })) || [{ code: 'CITY_CANDIDATE_FAILED' }], metadata);
  } catch (error) {
    return reportError('candidate-eval', error);
  }
}

function candidateObservation(root, runSnapshot, evidenceSelection) {
  const { assessment, gaps } = stageGaps('observe-record', runSnapshot, evidenceSelection);
  if (gaps.length) return failure(gaps, { level: 'candidate', workflowRunId: runSnapshot?.runId || null });
  try {
    const recorded = recordCityCertification(root, {
      purpose: 'observe-record', explicitRun: true, runSnapshot, evidenceSelection,
    });
    const ledger = recorded.candidateAfter.reports?.ledger || {};
    const metadata = {
      level: 'candidate', workflowRunId: assessment.runId,
      candidateStatus: recorded.candidate.status,
      candidateAfterStatus: recorded.candidateAfter.status,
      ledger: {
        status: ledger.status || 'FAIL', current: ledger.current === true,
        entries: ledger.entries ?? null, head: ledger.head || null,
      },
      recordedEntryHash: recorded.entry.hash,
      reportDigest: hashValue(redactValue(recorded.candidateAfter)),
    };
    return recorded.candidate.status === 'PASS' && recorded.candidateAfter.status === 'PASS'
      ? { status: 'PASS', metadata }
      : failure([{ code: 'CITY_CANDIDATE_OBSERVATION_FAILED' }], metadata);
  } catch (error) {
    return reportError('candidate-observation', error);
  }
}

function certificationSummary(report) {
  return {
    status: report.status,
    treeHash: report.treeHash,
    certificationIdentityDigest: report.certificationIdentityDigest,
    layoutInputDigest: report.layoutInputDigest,
    workflowComplete: report.workflowComplete === true,
    workflowRunId: report.workflowRunId || null,
    trusted: report.trusted === true,
  };
}

function cityCertification(root, runSnapshot, evidenceSelection) {
  const { gaps } = stageGaps('certify', runSnapshot, evidenceSelection);
  if (gaps.length) return failure(gaps, { workflowRunId: runSnapshot?.runId || null });
  try {
    const city = certifyCity(root, {
      purpose: 'certify', explicitRun: true, runSnapshot, evidenceSelection,
    });
    const certification = certificationSummary(city);
    const metadata = {
      certification,
      certificationDigest: hashValue(certification),
      reportDigest: hashValue(redactValue(city)),
    };
    return city.status === 'COMPLETE'
      ? { status: 'PASS', metadata }
      : failure(city.gaps?.map(item => ({ code: `CITY_${item.district || 'UNKNOWN'}` })) || [{ code: 'CITY_CERTIFICATION_FAILED' }], metadata);
  } catch (error) {
    return reportError('city-certification', error);
  }
}

function latestEvidence(runSnapshot, stepId) {
  return (runSnapshot?.evidence || [])
    .filter(item => item.stepId === stepId)
    .sort((left, right) => (right.attempt || 0) - (left.attempt || 0))[0] || null;
}

function currentCityCertification(runSnapshot) {
  const evidence = latestEvidence(runSnapshot, 'city-certification');
  const child = evidence?.components?.find(item => item.id === 'builtin:city-certification');
  const certification = child?.metadata?.certification;
  const digest = child?.metadata?.certificationDigest;
  const identity = runSnapshot?.certificationIdentity;
  const valid = evidence?.fresh === true
    && evidence.status === 'PASS'
    && child?.status === 'PASS'
    && certification?.status === 'COMPLETE'
    && digest === hashValue(certification)
    && DIGEST.test(certification.treeHash || '')
    && certification.treeHash === identity?.sourceTreeHash
    && certification.certificationIdentityDigest === identity?.certificationIdentityDigest
    && certification.layoutInputDigest === identity?.layoutInputDigest
    && certification.workflowRunId === runSnapshot?.runId;
  return valid ? { evidence, certification, certificationDigest: digest } : null;
}

function governedAdditionalChecks(root, runSnapshot) {
  const { manifest } = loadManifest(root);
  const requested = manifest.quality.additionalChecks || [];
  const catalog = loadCatalog(root, 'factory/catalog/evidence-providers.json');
  const catalogIds = new Set((catalog.providers || []).map(provider => provider.id));
  const qualityIndex = runSnapshot.plan.steps.findIndex(step => step.id === 'quality');
  const gaps = [];
  const checks = [];
  for (const providerId of requested) {
    if (!catalogIds.has(providerId)) {
      gaps.push({ code: 'QUALITY_PROVIDER_UNKNOWN', providerId });
      continue;
    }
    const matches = runSnapshot.plan.steps
      .map((step, index) => ({ step, index }))
      .filter(item => item.step.evidenceBinding?.providerId === providerId && item.index < qualityIndex);
    if (matches.length !== 1) {
      gaps.push({ code: matches.length ? 'QUALITY_PROVIDER_AMBIGUOUS' : 'QUALITY_PROVIDER_UNBOUND', providerId });
      continue;
    }
    const stepId = matches[0].step.id;
    const evidence = latestEvidence(runSnapshot, stepId);
    const derived = runSnapshot.workflow.steps?.[stepId]?.state;
    if (!evidence?.fresh || !['PASS', 'NA'].includes(evidence.status) || !['PASS', 'NA'].includes(derived)) {
      gaps.push({ code: 'QUALITY_PROVIDER_EVIDENCE_MISSING', providerId, stepId });
      continue;
    }
    checks.push({ providerId, stepId, status: evidence.status, evidenceDigest: evidence.digest });
  }
  return { checks, gaps };
}

function quality(root, runSnapshot, evidenceSelection) {
  const gaps = exactStepGaps('quality', runSnapshot, evidenceSelection);
  const city = currentCityCertification(runSnapshot);
  if (!city) gaps.push({ code: 'QUALITY_CITY_CERTIFICATION_MISSING' });
  let additional = { checks: [], gaps: [] };
  try {
    additional = governedAdditionalChecks(root, runSnapshot);
    gaps.push(...additional.gaps);
  } catch {
    gaps.push({ code: 'QUALITY_PROVIDER_CATALOG_INVALID' });
  }
  const metadata = {
    workflowRunId: runSnapshot?.runId || null,
    cityCertificationDigest: city?.certificationDigest || null,
    additionalChecks: additional.checks,
    additionalChecksDigest: hashValue(additional.checks),
  };
  return gaps.length ? failure(gaps, metadata) : { status: 'PASS', metadata };
}

function releasePrepare(root, runSnapshot, evidenceSelection) {
  const { gaps } = stageGaps('release-checkpoint-prepare', runSnapshot, evidenceSelection);
  const city = currentCityCertification(runSnapshot);
  if (!city) gaps.push({ code: 'RELEASE_PREPARE_CITY_CERTIFICATION_MISSING' });
  const qualityEvidence = latestEvidence(runSnapshot, 'quality');
  if (!qualityEvidence?.fresh || qualityEvidence.status !== 'PASS'
    || runSnapshot?.workflow?.steps?.quality?.state !== 'PASS') {
    gaps.push({ code: 'RELEASE_PREPARE_QUALITY_MISSING' });
  }
  if (gaps.length) return failure(gaps, { workflowRunId: runSnapshot?.runId || null });
  try {
    const { manifest } = loadManifest(root);
    const delivery = planDelivery({
      manifest, action: 'prepare', certification: city.certification,
      runSnapshot, explicitRun: true, purpose: 'release-checkpoint-prepare',
    });
    const rollback = delivery.phases?.find(phase => phase.id === 'rollback')?.strategy || null;
    const summary = redactValue({
      status: delivery.status, action: delivery.action,
      treeHash: delivery.treeHash,
      certificationIdentityDigest: delivery.certificationIdentityDigest,
      layoutInputDigest: delivery.layoutInputDigest,
      workflowRunId: delivery.workflowRunId,
      workflowComplete: delivery.workflowComplete === true,
      trusted: delivery.trusted === true,
      advisory: delivery.advisory === true,
      rollback,
    });
    const metadata = { delivery: summary, deliveryDigest: hashValue(summary) };
    return delivery.status === 'PASS'
      ? { status: 'PASS', metadata }
      : failure([{ code: 'RELEASE_PREPARE_BLOCKED' }], metadata);
  } catch (error) {
    return reportError('release-prepare', error);
  }
}

function executeStage(operation, executor) {
  try {
    return executor();
  } catch (error) {
    return reportError(operation, error);
  }
}

function createStageProviderExecutors({ root, runSnapshot, evidenceSelection } = {}) {
  const projectRoot = fs.realpathSync.native(path.resolve(root));
  return Object.freeze({
    'candidate-eval': () => executeStage(
      'candidate-eval', () => candidateEval(projectRoot, runSnapshot, evidenceSelection),
    ),
    'candidate-observation': () => executeStage(
      'candidate-observation', () => candidateObservation(projectRoot, runSnapshot, evidenceSelection),
    ),
    'city-certification': () => executeStage(
      'city-certification', () => cityCertification(projectRoot, runSnapshot, evidenceSelection),
    ),
    quality: () => executeStage('quality', () => quality(projectRoot, runSnapshot, evidenceSelection)),
    'release-prepare': () => executeStage(
      'release-prepare', () => releasePrepare(projectRoot, runSnapshot, evidenceSelection),
    ),
  });
}

module.exports = {
  STAGE_OPERATIONS, createStageProviderExecutors, sanitizeStageMetadata,
};
