const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const {
  aggregateCertification, certifyCity, evaluateProjectLayout, recordCityCertification,
} = require('../lib/factory/city');
const { computeCertificationIdentity } = require('../lib/factory/identity');
const { planProject } = require('../lib/factory/engine');

function candidateRunSnapshot(root, runId) {
  const discoveredPlan = planProject(root, { dryRun: true, runId }).plan;
  // Candidate aggregation is unit-tested independently of the operator-local toolchain overlay.
  // Host enrollment is intentionally mutable and is covered by engine/workflow-stage tests.
  const policyGaps = discoveredPlan.policy.gaps.filter(
    gap => gap.code !== 'EVIDENCE_TOOLCHAIN_UNAUTHORIZED',
  );
  const plan = {
    ...discoveredPlan,
    policy: {
      ...discoveredPlan.policy,
      status: policyGaps.length === 0 ? 'ready' : 'blocked',
      gaps: policyGaps,
    },
  };
  return {
    runId, planFresh: true, plan,
    workflow: { runState: 'READY', steps: { evals: { state: 'READY' } } },
  };
}

test('Factory City candidate certification is deterministic without mutable local evidence state', { skip: 'needs the full private monorepo (child registry, skill canon)' }, () => {
  const root = path.join(__dirname, '..', '..');
  const certificationIdentity = computeCertificationIdentity(root);
  const runSnapshot = candidateRunSnapshot(root, 'factory-city-unit');
  const report = certifyCity(root, {
    identityFn: () => certificationIdentity,
    ledgerMode: 'candidate',
    evidenceSelection: {
      status: 'PASS',
      runId: 'factory-city-unit',
      digests: ['a'.repeat(64)],
      gaps: [],
      certificationIdentity,
    },
    purpose: 'eval',
    explicitRun: true,
    runSnapshot,
  });
  assert.equal(report.status, 'PASS', JSON.stringify({ gaps: report.gaps, policy: runSnapshot.plan.policy.gaps }));
  assert.equal(report.level, 'candidate');
  assert.equal(report.workflowComplete, false);
  assert.equal(report.gaps.length, 0);
  assert.match(report.treeHash, /^[a-f0-9]{64}$/);
  assert.equal(report.reports.evals.score, 100);
  assert.equal(report.reports.delivery.phases.at(-1).id, 'rollback');
  assert.equal(report.reports.provenance.evidenceRunId, 'factory-city-unit');
  assert.equal(report.reports.ledger.candidate, true);
  assert.equal(report.certificationIdentityDigest, certificationIdentity.certificationIdentityDigest);
});

test('aggregate certification never hides a failing district', () => {
  const report = aggregateCertification({ trace: { status: 'PASS' }, trust: { status: 'FAIL', gaps: [{ code: 'denied' }] } }, 'a'.repeat(64));
  assert.equal(report.status, 'FAIL');
  assert.deepEqual(report.gaps.map(item => item.district), ['trust']);
});

test('City completion exposes workflow completion as an independent invariant', () => {
  const report = aggregateCertification(
    { city: { status: 'PASS' } },
    'a'.repeat(64),
    { workflowComplete: false, workflowRunId: 'city-boundary' },
  );
  assert.equal(report.status, 'COMPLETE');
  assert.equal(report.workflowComplete, false);
  assert.equal(report.workflowRunId, 'city-boundary');
});

test('observation cannot append without explicit scope at the exact stage', () => {
  const root = path.join(__dirname, '..', '..');
  assert.throws(() => recordCityCertification(root, {
    runSnapshot: {
      runId: 'unscoped-observation', planFresh: true, plan: { policy: { status: 'ready' } },
      workflow: { runState: 'READY', steps: { observability: { state: 'READY' } } },
    },
    evidenceSelection: { runId: 'unscoped-observation' },
  }), /trusted observability-stage assessment/);
});

test('Factory City fails closed when layout and certification identity are different snapshots', { skip: 'needs the full private monorepo (child registry, skill canon)' }, () => {
  const root = path.join(__dirname, '..', '..');
  const certificationIdentity = computeCertificationIdentity(root);
  const report = certifyCity(root, {
    identityFn: () => ({ ...certificationIdentity, layoutInputDigest: 'f'.repeat(64) }),
    ledgerMode: 'candidate',
    evidenceSelection: {
      status: 'PASS', runId: 'layout-race-unit', digests: ['a'.repeat(64)], gaps: [],
      certificationIdentity: { ...certificationIdentity, layoutInputDigest: 'f'.repeat(64) },
    },
    purpose: 'eval',
    explicitRun: true,
    runSnapshot: candidateRunSnapshot(root, 'layout-race-unit'),
  });
  assert.equal(report.status, 'FAIL');
  assert.ok(report.reports.layout.gaps.some(gap => gap.code === 'CERTIFICATION_INPUT_CHANGED'));
});

test('Factory City layout district fails on output outside the resolver-owned child root', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'city-layout-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(path.join(root, 'AGENTS.md'), '# Factory City\n');
  fs.mkdirSync(path.join(root, 'cli', 'bin'), { recursive: true });
  fs.writeFileSync(path.join(root, 'cli', 'bin', 'infra.js'), '');
  fs.mkdirSync(path.join(root, 'app_entry_root', '_registry'), { recursive: true });
  fs.writeFileSync(path.join(root, 'app_entry_root', '_registry', 'registry.json'), JSON.stringify({
    schemaVersion: '1.0.0',
    projects: [{ key: 'worlio' }],
  }));
  fs.mkdirSync(path.join(root, 'app_entry_root', 'worlio', '_project'), { recursive: true });
  fs.mkdirSync(path.join(root, '_output', 'worlio'), { recursive: true });

  const report = evaluateProjectLayout(root);
  assert.equal(report.status, 'FAIL');
  assert.equal(report.gaps[0].code, 'PROJECT_LAYOUT_DRIFT');
  assert.match(report.gaps[0].problem, /outside its child directory/);
});

test('Factory City child certification validates only its registry-owned layout slice', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'city-child-layout-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(path.join(root, 'AGENTS.md'), '# Factory City\n');
  fs.mkdirSync(path.join(root, 'cli', 'bin'), { recursive: true });
  fs.writeFileSync(path.join(root, 'cli', 'bin', 'infra.js'), '');
  fs.mkdirSync(path.join(root, 'app_entry_root', '_registry'), { recursive: true });
  fs.writeFileSync(path.join(root, 'app_entry_root', '_registry', 'registry.json'), JSON.stringify({
    schemaVersion: '1.0.0',
    projects: [{ key: 'worlio', presentLocally: true, app: { active: 'v1', versions: [{ id: 'v1' }] } }],
  }));
  const child = path.join(root, 'app_entry_root', 'worlio');
  fs.mkdirSync(path.join(child, '_project'), { recursive: true });
  fs.mkdirSync(path.join(child, 'worlio-v1'), { recursive: true });
  fs.mkdirSync(path.join(child, '_output', 'worlio-v1'), { recursive: true });

  const initial = evaluateProjectLayout(child);
  assert.equal(initial.status, 'PASS');
  assert.equal(initial.baseRoot, root);
  assert.match(initial.inputDigest, /^[a-f0-9]{64}$/);

  fs.mkdirSync(path.join(root, '_output', 'unrelated'), { recursive: true });
  assert.equal(evaluateProjectLayout(child).status, 'PASS');

  fs.mkdirSync(path.join(root, '_output', 'worlio'), { recursive: true });
  const drift = evaluateProjectLayout(child);
  assert.equal(drift.status, 'FAIL');
  assert.match(drift.gaps[0].problem, /outside its child directory/);
});
