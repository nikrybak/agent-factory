'use strict';

const { compileRedactionPolicy, redactError, redactValue } = require('./redaction');

const ENVELOPE_SCHEMA_VERSION = '1.0';

const EXIT_CODES = Object.freeze({
  SUCCESS: 0,
  VALIDATION_FAILED: 1,
  DRIFT: 2,
  USAGE: 3,
  CAPABILITY_GAP: 4,
  EXECUTION_FAILED: 5,
  POLICY_DENIED: 6,
  INTERNAL_ERROR: 7,
});

const STATUSES = new Set([
  'PASS',
  'PASS_WITH_GAPS',
  'ADVISORY',
  'FAIL',
  'N_A',
  'PLANNED',
  'RUNNING',
  'PAUSED',
  'COMPLETE',
]);

function copyDiagnostic(diagnostic, policy) {
  if (!diagnostic || typeof diagnostic !== 'object' || Array.isArray(diagnostic)) {
    throw new TypeError('each diagnostic must be an object');
  }
  if (typeof diagnostic.level !== 'string' ||
      typeof diagnostic.code !== 'string' ||
      typeof diagnostic.message !== 'string') {
    throw new TypeError('each diagnostic requires string level, code, and message');
  }
  return redactValue({ ...diagnostic }, { policy });
}

function createEnvelope({ command, status, data = {}, diagnostics = [] } = {}, options = {}) {
  if (typeof command !== 'string' || command.length === 0) {
    throw new TypeError('envelope command must be a non-empty string');
  }
  if (!STATUSES.has(status)) {
    throw new TypeError(`envelope status '${String(status)}' is not supported`);
  }
  if (!Array.isArray(diagnostics)) {
    throw new TypeError('envelope diagnostics must be an array');
  }

  const policy = options.policy || compileRedactionPolicy();
  return {
    schemaVersion: ENVELOPE_SCHEMA_VERSION,
    command,
    status,
    data: redactValue(data, { policy }),
    diagnostics: diagnostics.map(diagnostic => copyDiagnostic(diagnostic, policy)),
  };
}

function formatJsonEnvelope(input, options = {}) {
  return `${JSON.stringify(createEnvelope(input, options), null, 2)}\n`;
}

function formatFactoryError(error, options = {}) {
  const policy = options.policy || compileRedactionPolicy();
  return `[infra] ${redactError(error, policy).message}\n`;
}

module.exports = {
  ENVELOPE_SCHEMA_VERSION,
  EXIT_CODES,
  createEnvelope,
  formatFactoryError,
  formatJsonEnvelope,
};
