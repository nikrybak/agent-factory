const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { assessCertificationLedger, createEntry, verifyLedger, summarizeLedger } = require('../lib/factory/ledger');
const { appendEntry, readLedger } = require('../lib/factory/ledger-store');
const { REDACTION_POLICY_VERSION } = require('../lib/factory/redaction');

const identity = {
  sourceTreeHash: 'a'.repeat(64),
  certificationIdentityDigest: 'b'.repeat(64),
  layoutInputDigest: 'c'.repeat(64),
};

function certification(status = 'PASS', overrides = {}) {
  return {
    type: 'certification', schemaVersion: '2.0.0', status,
    redactionPolicyVersion: REDACTION_POLICY_VERSION,
    level: 'candidate', workflowRunId: 'run-a',
    treeHash: identity.sourceTreeHash,
    certificationIdentityDigest: identity.certificationIdentityDigest,
    layoutInputDigest: identity.layoutInputDigest,
    ...overrides,
  };
}

test('ledger creates and verifies an append-only deterministic hash chain', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'factory-ledger-'));
  const one = appendEntry(root, { type: 'run', status: 'PASS', durationMs: 10 }, { now: '2026-01-01T00:00:00.000Z' });
  const two = appendEntry(root, { type: 'run', status: 'FAIL', durationMs: 20 }, { now: '2026-01-01T00:01:00.000Z' });
  assert.equal(two.previousHash, one.hash);
  const entries = readLedger(root);
  assert.equal(verifyLedger(entries).status, 'PASS');
  assert.deepEqual(summarizeLedger(entries), { total: 2, passed: 1, failed: 1, durationMs: 30, successRate: 50, hasData: true });
});

test('ledger rejects malformed events and detects tampering', () => {
  assert.throws(() => createEntry(null, null), /event/);
  const entry = createEntry(null, { type: 'run', status: 'PASS' }, { now: '2026-01-01T00:00:00.000Z' });
  assert.equal(verifyLedger([{ ...entry, event: { ...entry.event, status: 'FAIL' } }]).status, 'FAIL');
});

test('empty structural ledgers remain valid but do not report healthy data', () => {
  assert.deepEqual(verifyLedger([]), { status: 'PASS', entries: 0, head: null, gaps: [] });
  assert.deepEqual(summarizeLedger([]), { total: 0, passed: 0, failed: 0, durationMs: 0, successRate: null, hasData: false });
  const assessed = assessCertificationLedger([], identity);
  assert.equal(assessed.status, 'FAIL');
  assert.equal(assessed.current, false);
  assert.ok(assessed.gaps.some(gap => gap.code === 'CERTIFICATION_LEDGER_MISSING'));
});

test('certification ledger passes only for the latest matching v2 PASS identity', () => {
  const matching = createEntry(null, certification(), { now: '2026-01-01T00:00:00.000Z' });
  assert.deepEqual(assessCertificationLedger([matching], identity, { runId: 'run-a', level: 'candidate' }), {
    status: 'PASS', current: true, entries: 1, head: matching.hash, scoped: true, gaps: [], latest: matching.event,
  });

  const failed = createEntry(null, certification('FAIL'), { now: '2026-01-01T00:00:00.000Z' });
  assert.ok(assessCertificationLedger([failed], identity).gaps.some(gap => gap.code === 'CERTIFICATION_LEDGER_CURRENT_FAIL'));

  const stale = createEntry(null, certification('PASS', { layoutInputDigest: 'd'.repeat(64) }), { now: '2026-01-01T00:00:00.000Z' });
  assert.ok(assessCertificationLedger([stale], identity).gaps.some(gap => gap.code === 'CERTIFICATION_LEDGER_STALE'));
});

test('certification ledger cannot cross selected runs or certification levels', () => {
  const matching = createEntry(null, certification(), { now: '2026-01-01T00:00:00.000Z' });
  const wrongRun = assessCertificationLedger([matching], identity, { runId: 'run-b', level: 'candidate' });
  assert.equal(wrongRun.status, 'FAIL');
  assert.ok(wrongRun.gaps.some(gap => gap.code === 'CERTIFICATION_LEDGER_RUN_MISMATCH'));
  const wrongLevel = assessCertificationLedger([matching], identity, { runId: 'run-a', level: 'full' });
  assert.equal(wrongLevel.status, 'FAIL');
  assert.ok(wrongLevel.gaps.some(gap => gap.code === 'CERTIFICATION_LEDGER_LEVEL_MISMATCH'));
});

test('historical and tampered certification ledgers cannot satisfy current identity', () => {
  const historical = createEntry(null, { type: 'certification', status: 'PASS', treeHash: identity.sourceTreeHash }, { now: '2026-01-01T00:00:00.000Z' });
  assert.ok(assessCertificationLedger([historical], identity).gaps.some(gap => gap.code === 'CERTIFICATION_LEDGER_HISTORICAL'));

  const current = createEntry(null, certification(), { now: '2026-01-01T00:00:00.000Z' });
  const tampered = { ...current, event: { ...current.event, status: 'FAIL' } };
  assert.ok(assessCertificationLedger([tampered], identity).gaps.some(gap => gap.code === 'CERTIFICATION_LEDGER_TAMPERED'));

  const priorPolicy = createEntry(null, certification('PASS', { redactionPolicyVersion: '0.9.0' }), { now: '2026-01-01T00:00:00.000Z' });
  assert.ok(assessCertificationLedger([priorPolicy], identity).gaps
    .some(gap => gap.code === 'CERTIFICATION_LEDGER_REDACTION_POLICY_MISMATCH'));
});
