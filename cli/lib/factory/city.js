'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { loadCatalog } = require('./catalog-loader');
const { computeCertificationIdentity, evaluateProjectLayout } = require('./identity');
const { loadManifest } = require('./manifest');
const { loadArtifactGraph, analyzeArtifactGraph } = require('./traceability');
const { routeWorkforce } = require('./workforce');
const { selectAdapters } = require('./adapters');
const { evaluateTrust } = require('./trust');
const { generateSbom } = require('./sbom');
const { assessReleaseProvenance, createAttestation, verifyAttestation } = require('./provenance');
const { stableDigest } = require('./stable-json');
const { evaluateAssertions } = require('./evals');
const {
  assessCertificationLedger, summarizeLedger, verifyLedger,
} = require('./ledger');
const { readLedger, transactLedger } = require('./ledger-store');
const { buildControlReport } = require('./control');
const { planDelivery } = require('./delivery');
const { assessWorkflowStage, candidateResult } = require('./workflow-stage');

function pass(status) { return ['PASS', 'COMPLETE', 'pass', 'ready', 'allow'].includes(status); }
function district(status, report, gaps = []) { return { status: pass(status) ? 'PASS' : 'FAIL', gaps, report }; }

function aggregateCertification(reports, identityOrTreeHash, metadata = {}) {
  const gaps = [];
  for (const [name, report] of Object.entries(reports).sort(([a], [b]) => a.localeCompare(b))) {
    if (!report || !pass(report.status)) gaps.push({ district: name, status: report?.status || 'MISSING', gaps: report?.gaps || [] });
  }
  const identity = typeof identityOrTreeHash === 'string'
    ? { sourceTreeHash: identityOrTreeHash }
    : identityOrTreeHash;
  return {
    schemaVersion: '1.0.0', status: gaps.length ? 'FAIL' : 'COMPLETE',
    treeHash: identity.sourceTreeHash,
    ...(identity.certificationIdentityDigest ? {
      certificationIdentityDigest: identity.certificationIdentityDigest,
      layoutInputDigest: identity.layoutInputDigest,
    } : {}),
    ...metadata, gaps, reports,
  };
}

function workflowStageDistrict(assessment, candidate) {
  const expected = candidate ? new Set(['eval', 'observe-record']) : new Set(['certify']);
  const validPurpose = expected.has(assessment?.purpose);
  const authorized = assessment?.authorized === true && validPurpose;
  const gaps = [...(assessment?.gaps || [])];
  if (assessment && !validPurpose) gaps.push({ code: 'WORKFLOW_STAGE_PURPOSE_MISMATCH' });
  if (!assessment) gaps.push({ code: 'WORKFLOW_STAGE_ASSESSMENT_MISSING' });
  return {
    ...(assessment || {}),
    status: authorized ? 'PASS' : 'FAIL',
    authorized,
    gaps,
  };
}

function candidateDelivery(stageAssessment) {
  return {
    schemaVersion: '1.0.0', status: 'PASS', action: 'prepare', level: 'candidate',
    workflowRunId: stageAssessment?.runId || null,
    workflowComplete: false,
    trusted: false,
    advisory: true,
    phases: [
      { id: 'verify', required: true, checks: ['certification', 'tree-identity', 'certification-identity', 'authority', 'provenance'] },
      { id: 'action', required: true, mode: 'prepare', argv: null },
      { id: 'rollback', required: true, strategy: { type: 'restore-previous-artifact', verify: true } },
    ],
  };
}

function readPersistedProvenance(root) {
  const filename = path.join(root, '.factory', 'provenance.json');
  if (!fs.existsSync(filename)) return { present: false, document: null, malformed: false };
  try {
    const document = JSON.parse(fs.readFileSync(filename, 'utf8'));
    const keys = document && typeof document === 'object' && !Array.isArray(document)
      ? Object.keys(document).sort() : [];
    const valid = keys.length === 3
      && keys[0] === 'attestation' && keys[1] === 'schemaVersion' && keys[2] === 'workflowRunId'
      && document.schemaVersion === '1.0.0'
      && typeof document.workflowRunId === 'string'
      && document.attestation && typeof document.attestation === 'object' && !Array.isArray(document.attestation);
    return { present: true, document: valid ? document : null, malformed: !valid };
  } catch {
    return { present: true, document: null, malformed: true };
  }
}

function certifyCity(rootDir, options = {}) {
  const root = fs.realpathSync.native(path.resolve(rootDir));
  const identityFn = options.identityFn || computeCertificationIdentity;
  const candidate = options.ledgerMode === 'candidate';
  const purpose = options.purpose || (candidate ? 'eval' : 'certify');
  const stageAssessment = assessWorkflowStage({
    purpose,
    runSnapshot: options.runSnapshot,
    explicitRun: options.explicitRun === true,
  });
  const workflowStage = workflowStageDistrict(stageAssessment, candidate);
  const beforeIdentity = identityFn(root);
  const observedLayout = evaluateProjectLayout(root);
  const layout = observedLayout.inputDigest === beforeIdentity.layoutInputDigest
    ? observedLayout
    : {
      ...observedLayout,
      status: 'FAIL',
      gaps: [...observedLayout.gaps, { code: 'CERTIFICATION_INPUT_CHANGED' }],
    };
  const loaded = loadManifest(root);
  const plan = options.runSnapshot?.plan;
  if (!plan) throw new Error('City certification requires the selected run snapshot plan');

  const graph = loadArtifactGraph(root);
  const rawTrace = analyzeArtifactGraph(graph, root);
  const trace = { ...rawTrace, status: pass(rawTrace.status) ? 'PASS' : 'FAIL' };

  const roles = loadCatalog(root, 'factory/catalog/roles.json');
  const rawWorkforce = routeWorkforce({ catalog: roles, plan, detection: plan.detection });
  const workforce = { ...rawWorkforce, status: pass(rawWorkforce.status) ? 'PASS' : 'FAIL' };

  const adapterCatalog = loadCatalog(root, 'factory/catalog/adapters.json');
  const rawAdapters = selectAdapters({ catalog: adapterCatalog, detection: plan.detection });
  const adapters = { ...rawAdapters, status: pass(rawAdapters.status) ? 'PASS' : 'FAIL' };

  const trustPolicy = loadCatalog(root, 'factory/catalog/trust-policy.json');
  const rawTrust = evaluateTrust({
    descriptor: { tier: 'verified', executable: 'node', authority: ['read'], risk: 'high', cwd: '.', paths: ['factory'], network: { mode: 'none', hosts: [] } },
    policy: trustPolicy,
    projectRoot: root,
  });
  const trust = { ...rawTrust, status: rawTrust.decision === 'allow' ? 'PASS' : 'FAIL', gaps: rawTrust.reasons.map(code => ({ code })) };

  const rawSbom = generateSbom(root);
  const sbom = { status: 'PASS', componentCount: rawSbom.components.length, sourceCount: rawSbom.metadata.sources.length, digest: rawSbom.serialNumber, bom: rawSbom };
  const selectedEvidence = options.evidenceSelection || {
    status: 'FAIL', runId: null, digests: [], gaps: [{ code: 'PROVENANCE_RUN_SNAPSHOT_REQUIRED' }],
  };
  let provenance;
  const evidenceIdentityMismatch = selectedEvidence.certificationIdentity?.certificationIdentityDigest
    !== beforeIdentity.certificationIdentityDigest;
  if (selectedEvidence.status !== 'PASS'
    || selectedEvidence.runId !== stageAssessment?.runId
    || evidenceIdentityMismatch) {
    const gaps = [...(selectedEvidence.gaps || [])];
    if (selectedEvidence.status === 'PASS' && selectedEvidence.runId !== stageAssessment?.runId) {
      gaps.push({ code: 'PROVENANCE_RUN_MISMATCH' });
    }
    if (selectedEvidence.status === 'PASS' && evidenceIdentityMismatch) {
      gaps.push({ code: 'PROVENANCE_IDENTITY_MISMATCH' });
    }
    provenance = { status: 'FAIL', gaps, attestation: null, evidenceRunId: selectedEvidence.runId || null };
  } else {
    const rawAttestation = createAttestation({
      treeHash: beforeIdentity.sourceTreeHash,
      certificationIdentityDigest: beforeIdentity.certificationIdentityDigest,
      layoutInputDigest: beforeIdentity.layoutInputDigest,
      manifestDigest: loaded.digest,
      evidenceDigests: selectedEvidence.digests,
      sbom: rawSbom,
      subject: [{ name: loaded.manifest.project.id }],
      workflowRunId: stageAssessment.runId,
      planHash: plan.planHash,
    });
    const persisted = readPersistedProvenance(root);
    const attestation = persisted.document?.attestation || rawAttestation;
    const verification = verifyAttestation(attestation.signature ? (() => {
      const unsigned = { ...attestation }; delete unsigned.signature; return unsigned;
    })() : attestation);
    const releaseAssessment = persisted.malformed
      ? {
        schemaVersion: '1.0.0', status: 'FAIL', releaseGrade: false, advisory: false,
        workflowRunId: null, keyId: null, keyFingerprintSha256: null,
        provenancePolicyDigest: null, gaps: [{ code: 'PROVENANCE_DOCUMENT_INVALID' }],
      }
      : assessReleaseProvenance(attestation, {
        policy: trustPolicy,
        workflowComplete: stageAssessment.workflowComplete === true,
        expected: {
          workflowRunId: stageAssessment.runId,
          planHash: plan.planHash,
          treeHash: beforeIdentity.sourceTreeHash,
          manifestDigest: loaded.digest,
          certificationIdentityDigest: beforeIdentity.certificationIdentityDigest,
          layoutInputDigest: beforeIdentity.layoutInputDigest,
          sbomDigest: stableDigest(rawSbom),
          evidenceDigests: selectedEvidence.digests,
        },
      });
    const wrapperMatches = !persisted.document
      || persisted.document.workflowRunId === stageAssessment.runId;
    const persistedValid = !persisted.present || (!persisted.malformed && wrapperMatches
      && releaseAssessment.status !== 'FAIL');
    provenance = {
      status: verification.valid && verification.current && persistedValid ? 'PASS' : 'FAIL',
      gaps: [
        ...verification.reasons.map(code => ({ code })),
        ...(!wrapperMatches ? [{ code: 'PROVENANCE_RUN_MISMATCH' }] : []),
        ...(!persistedValid ? releaseAssessment.gaps : []),
      ],
      attestation, releaseAssessment,
      evidenceRunId: selectedEvidence.runId || null,
    };
  }

  const ledgerEntries = options.ledgerEntries || readLedger(root);
  const structuralLedger = verifyLedger(ledgerEntries);
  const currentLedger = assessCertificationLedger(ledgerEntries, beforeIdentity, {
    runId: stageAssessment?.runId || null,
    level: 'candidate',
  });
  const ledger = options.ledgerMode === 'candidate'
    ? {
      ...structuralLedger,
      candidate: true,
      current: currentLedger.current,
      currentGaps: currentLedger.gaps,
      summary: summarizeLedger(ledgerEntries),
    }
    : { ...currentLedger, summary: summarizeLedger(ledgerEntries) };

  const provisional = aggregateCertification(
    { trace, workforce, adapters, trust, sbom, provenance, ledger, layout, workflowStage },
    beforeIdentity,
    { workflowComplete: stageAssessment?.workflowComplete === true },
  );
  const delivery = candidate
    ? candidateDelivery(stageAssessment)
    : planDelivery({
      manifest: loaded.manifest, action: 'prepare', certification: provisional,
      runSnapshot: options.runSnapshot, explicitRun: options.explicitRun === true, purpose: 'certify',
    });

  const suite = loadCatalog(root, 'factory/catalog/evals.json');
  const evalFacts = {
    trace: { status: trace.status, coverage: trace.coverage.requirements.percent },
    workforce: { status: workforce.status }, adapters: { status: adapters.status }, trust: { status: trust.status },
    sbom: { componentCount: sbom.componentCount, sourceCount: sbom.sourceCount }, provenance: { status: provenance.status },
    ledger: { status: ledger.status }, delivery: { status: delivery.status },
  };
  const evals = evaluateAssertions(suite, evalFacts);
  const districts = { trace, workforce, adapters, trust, sbom, provenance, ledger, layout, workflowStage, delivery, evals };
  const control = buildControlReport(districts, ledger.summary);
  const afterIdentity = identityFn(root);
  const identityStability = afterIdentity.certificationIdentityDigest === beforeIdentity.certificationIdentityDigest
    ? { status: 'PASS', gaps: [] }
    : { status: 'FAIL', gaps: [{ code: 'CERTIFICATION_INPUT_CHANGED' }] };
  const report = aggregateCertification(
    { ...districts, control, identity: identityStability },
    afterIdentity,
    {
      workflowComplete: stageAssessment?.workflowComplete === true,
      workflowRunId: stageAssessment?.runId || null,
      trusted: stageAssessment?.trusted === true,
      advisory: stageAssessment?.trusted !== true,
    },
  );
  return candidate ? candidateResult(report) : report;
}

function recordCityCertification(rootDir, options = {}) {
  const root = fs.realpathSync.native(path.resolve(rootDir));
  const evidenceSelection = options.evidenceSelection;
  const stageAssessment = assessWorkflowStage({
    purpose: 'observe-record',
    runSnapshot: options.runSnapshot,
    explicitRun: options.explicitRun === true,
  });
  if (!stageAssessment?.authorized || !stageAssessment.trusted || stageAssessment.purpose !== 'observe-record') {
    throw new Error('observe record requires a trusted observability-stage assessment');
  }
  if (!evidenceSelection || evidenceSelection.runId !== stageAssessment.runId) {
    throw new Error('observe record requires evidence from the selected run snapshot');
  }
  const frozenOptions = { ...options, purpose: 'observe-record', evidenceSelection };
  const transaction = transactLedger(root, ledgerEntries => {
    const candidate = certifyCity(root, {
      ...frozenOptions, ledgerMode: 'candidate', ledgerEntries,
    });
    if (candidate.reports.ledger.status !== 'PASS') {
      throw new Error('cannot record certification against a tampered ledger');
    }
    return {
      event: {
        type: 'certification', schemaVersion: '2.0.0',
        level: 'candidate',
        workflowRunId: stageAssessment.runId,
        status: candidate.status === 'PASS' ? 'PASS' : 'FAIL',
        sourceTreeHash: candidate.treeHash,
        certificationIdentityDigest: candidate.certificationIdentityDigest,
        layoutInputDigest: candidate.layoutInputDigest,
      },
      value: { candidate },
      afterCommit: afterEntries => certifyCity(root, {
        ...frozenOptions, ledgerMode: 'candidate', ledgerEntries: afterEntries,
      }),
    };
  }, options.ledgerTransactionOptions);
  return {
    candidate: transaction.value.candidate,
    entry: transaction.entry,
    candidateAfter: transaction.postValue,
  };
}

module.exports = {
  aggregateCertification, certifyCity, district, evaluateProjectLayout, recordCityCertification,
};
