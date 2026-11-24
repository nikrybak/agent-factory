'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  DIAGNOSTIC_SCHEMA_VERSION, STAGE_OPERATIONS, classifyStageProviderError,
} = require('../lib/factory/stage-diagnostics');
const { computeCertificationIdentity } = require('../lib/factory/identity');
const { createEvidence, validateEvidence } = require('../lib/factory/evidence');
const { acquireLedgerLock, releaseLedgerLock } = require('../lib/factory/ledger-store');
const { createStageProviderExecutors } = require('../lib/factory/stage-providers');

const CANARY = 'stage-diagnostic-secret-canary';
const EXACT_KEYS = ['schemaVersion', 'operation', 'code', 'category', 'retryable'];
const CASES = [
  ['LEDGER_PATH_UNSAFE', 'STAGE_PROVIDER_LEDGER_PATH_UNSAFE', 'policy', false],
  ['LEDGER_JSON_INVALID', 'STAGE_PROVIDER_LEDGER_INVALID', 'integrity', false],
  ['LEDGER_CHAIN_INVALID', 'STAGE_PROVIDER_LEDGER_INVALID', 'integrity', false],
  ['LEDGER_LOCK_TIMEOUT', 'STAGE_PROVIDER_LEDGER_LOCK_TIMEOUT', 'contention', true],
  ['LEDGER_HEAD_CONFLICT', 'STAGE_PROVIDER_LEDGER_HEAD_CONFLICT', 'conflict', true],
  ['LEDGER_EVENT_REDACTION_FAILED', 'STAGE_PROVIDER_REDACTION_FAILED', 'security', false],
  ['LEDGER_COMMIT_UNCONFIRMED', 'STAGE_PROVIDER_LEDGER_COMMIT_UNCONFIRMED', 'durability', false],
  ['LEDGER_LOCK_OWNER_MISMATCH', 'STAGE_PROVIDER_LEDGER_OWNER_MISMATCH', 'integrity', false],
];

function expected(operation, code, category, retryable) {
  return { schemaVersion: DIAGNOSTIC_SCHEMA_VERSION, operation, code, category, retryable };
}

test('stage diagnostic classifier returns every exact frozen bounded mapping', () => {
  for (const operation of STAGE_OPERATIONS) {
    for (const [upstream, code, category, retryable] of CASES) {
      const error = Object.assign(new Error(CANARY), {
        code: upstream, path: CANARY, syscall: CANARY, command: CANARY,
        cause: new Error(CANARY),
      });
      error.stack = CANARY;
      const first = classifyStageProviderError(operation, error);
      const second = classifyStageProviderError(operation, error);
      assert.deepEqual(first, expected(operation, code, category, retryable));
      assert.deepEqual(second, first);
      assert.deepEqual(Object.keys(first), EXACT_KEYS);
      assert.equal(Object.isFrozen(first), true);
      assert.ok(Buffer.byteLength(JSON.stringify(first), 'utf8') <= 256);
      assert.equal(JSON.stringify(first).includes(CANARY), false);
    }
  }
});

test('unknown, malformed, proxied, and accessor-throwing errors fail closed after one code read', () => {
  const generic = expected(
    'candidate-eval', 'STAGE_PROVIDER_EXECUTION_FAILED', 'internal', false,
  );
  for (const error of [
    undefined, null, CANARY, 7, Symbol(CANARY),
    { code: `UNKNOWN_${CANARY}`, message: CANARY, path: CANARY, stack: CANARY, cause: CANARY },
    { code: new String('LEDGER_LOCK_TIMEOUT'), message: CANARY },
  ]) {
    assert.deepEqual(classifyStageProviderError('candidate-eval', error), generic);
  }

  let knownReads = 0;
  const known = new Proxy({}, {
    get(_target, property) {
      assert.equal(property, 'code');
      knownReads += 1;
      return 'LEDGER_LOCK_TIMEOUT';
    },
    ownKeys() { throw new Error(CANARY); },
  });
  assert.deepEqual(
    classifyStageProviderError('candidate-observation', known),
    expected('candidate-observation', 'STAGE_PROVIDER_LEDGER_LOCK_TIMEOUT', 'contention', true),
  );
  assert.equal(knownReads, 1);

  let throwingReads = 0;
  const hostile = Object.create(null, {
    code: { get() { throwingReads += 1; throw new Error(CANARY); } },
    message: { get() { throw new Error(CANARY); } },
    stack: { get() { throw new Error(CANARY); } },
    path: { get() { throw new Error(CANARY); } },
    cause: { get() { throw new Error(CANARY); } },
  });
  assert.deepEqual(classifyStageProviderError('candidate-eval', hostile), generic);
  assert.equal(throwingReads, 1);
  assert.throws(
    () => classifyStageProviderError(CANARY, new Error(CANARY)),
    error => error.message === 'stage diagnostic operation must be governed'
      && !error.message.includes(CANARY),
  );
});

test('stage executor converts a real unsafe ledger path without exposing upstream state', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'factory-stage-diagnostic-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(path.join(root, '.factory'), CANARY, 'utf8');
  const identity = computeCertificationIdentity(root);
  const runSnapshot = {
    runId: 'diagnostic-run',
    planFresh: true,
    plan: { policy: { status: 'ready' }, steps: [] },
    certificationIdentity: identity,
    evidence: [],
    workflow: { runState: 'RUNNING', steps: { observability: { state: 'READY' } } },
  };
  const executors = createStageProviderExecutors({
    root,
    runSnapshot,
    evidenceSelection: {
      status: 'PASS', runId: runSnapshot.runId, digests: [], certificationIdentity: identity,
    },
  });
  const result = executors['candidate-observation']();
  assert.equal(result.status, 'FAIL');
  assert.equal(result.reason, 'STAGE_PROVIDER_LEDGER_PATH_UNSAFE');
  assert.deepEqual(result.metadata.gaps, [expected(
    'candidate-observation', 'STAGE_PROVIDER_LEDGER_PATH_UNSAFE', 'policy', false,
  )]);
  assert.equal(JSON.stringify(result).includes(CANARY), false);
  assert.equal(JSON.stringify(result).includes(root), false);
});

test('real ledger contention produces a stable diagnostic that survives evidence round-trip', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'factory-stage-contention-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const owner = acquireLedgerLock(root);
  let contention;
  try {
    assert.throws(
      () => acquireLedgerLock(root, { lockTimeoutMs: 0, lockRetryMs: 1 }),
      error => { contention = error; return error.code === 'LEDGER_LOCK_TIMEOUT'; },
    );
  } finally {
    assert.equal(releaseLedgerLock(owner), true);
  }
  const diagnostic = classifyStageProviderError('candidate-observation', contention);
  assert.deepEqual(diagnostic, expected(
    'candidate-observation', 'STAGE_PROVIDER_LEDGER_LOCK_TIMEOUT', 'contention', true,
  ));
  const evidence = createEvidence({
    stepId: 'observability', attempt: 1, status: 'FAIL',
    components: [{
      id: 'builtin:candidate-observation', operation: 'candidate-observation',
      status: 'FAIL', reason: diagnostic.code, metadata: { gaps: [diagnostic] },
    }],
  });
  const roundTrip = JSON.parse(JSON.stringify(evidence));
  assert.deepEqual(validateEvidence(roundTrip), []);
  assert.equal(roundTrip.digest, evidence.digest);
  assert.deepEqual(roundTrip.components[0].metadata.gaps, [diagnostic]);
});
