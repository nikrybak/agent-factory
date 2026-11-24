'use strict';

const DIAGNOSTIC_SCHEMA_VERSION = '1.0.0';
const STAGE_OPERATIONS = Object.freeze([
  'candidate-eval', 'candidate-observation', 'city-certification', 'quality', 'release-prepare',
]);
const OPERATIONS = new Set(STAGE_OPERATIONS);

const GENERIC = Object.freeze({
  code: 'STAGE_PROVIDER_EXECUTION_FAILED', category: 'internal', retryable: false,
});
const CODE_MAP = new Map([
  ['LEDGER_PATH_UNSAFE', Object.freeze({
    code: 'STAGE_PROVIDER_LEDGER_PATH_UNSAFE', category: 'policy', retryable: false,
  })],
  ['LEDGER_JSON_INVALID', Object.freeze({
    code: 'STAGE_PROVIDER_LEDGER_INVALID', category: 'integrity', retryable: false,
  })],
  ['LEDGER_CHAIN_INVALID', Object.freeze({
    code: 'STAGE_PROVIDER_LEDGER_INVALID', category: 'integrity', retryable: false,
  })],
  ['LEDGER_LOCK_TIMEOUT', Object.freeze({
    code: 'STAGE_PROVIDER_LEDGER_LOCK_TIMEOUT', category: 'contention', retryable: true,
  })],
  ['LEDGER_HEAD_CONFLICT', Object.freeze({
    code: 'STAGE_PROVIDER_LEDGER_HEAD_CONFLICT', category: 'conflict', retryable: true,
  })],
  ['LEDGER_EVENT_REDACTION_FAILED', Object.freeze({
    code: 'STAGE_PROVIDER_REDACTION_FAILED', category: 'security', retryable: false,
  })],
  ['LEDGER_COMMIT_UNCONFIRMED', Object.freeze({
    code: 'STAGE_PROVIDER_LEDGER_COMMIT_UNCONFIRMED', category: 'durability', retryable: false,
  })],
  ['LEDGER_LOCK_OWNER_MISMATCH', Object.freeze({
    code: 'STAGE_PROVIDER_LEDGER_OWNER_MISMATCH', category: 'integrity', retryable: false,
  })],
]);

function readErrorCode(error) {
  try {
    if (error === null || !['object', 'function'].includes(typeof error)) return undefined;
    return error.code;
  } catch {
    return undefined;
  }
}

function classifyStageProviderError(operation, error) {
  if (!OPERATIONS.has(operation)) throw new TypeError('stage diagnostic operation must be governed');
  const upstreamCode = readErrorCode(error);
  const selected = typeof upstreamCode === 'string' ? CODE_MAP.get(upstreamCode) || GENERIC : GENERIC;
  return Object.freeze({
    schemaVersion: DIAGNOSTIC_SCHEMA_VERSION,
    operation,
    code: selected.code,
    category: selected.category,
    retryable: selected.retryable,
  });
}

module.exports = {
  DIAGNOSTIC_SCHEMA_VERSION, STAGE_OPERATIONS, classifyStageProviderError,
};
