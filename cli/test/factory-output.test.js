'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  ENVELOPE_SCHEMA_VERSION,
  EXIT_CODES,
  createEnvelope,
  formatFactoryError,
  formatJsonEnvelope,
} = require('../lib/factory/output');
const { compileRedactionPolicy } = require('../lib/factory/redaction');

test('exit taxonomy preserves legacy codes and defines new failure classes', () => {
  assert.deepEqual(EXIT_CODES, {
    SUCCESS: 0,
    VALIDATION_FAILED: 1,
    DRIFT: 2,
    USAGE: 3,
    CAPABILITY_GAP: 4,
    EXECUTION_FAILED: 5,
    POLICY_DENIED: 6,
    INTERNAL_ERROR: 7,
  });
  assert.equal(Object.isFrozen(EXIT_CODES), true);
});

test('createEnvelope returns a stable key order and defensive diagnostics copy', () => {
  const diagnostics = [{ level: 'warn', code: 'GAP', message: 'tool unavailable' }];
  const envelope = createEnvelope({
    command: 'detect',
    status: 'PASS_WITH_GAPS',
    data: { components: [] },
    diagnostics,
  });
  diagnostics[0].message = 'mutated';

  assert.deepEqual(Object.keys(envelope), [
    'schemaVersion', 'command', 'status', 'data', 'diagnostics',
  ]);
  assert.equal(envelope.schemaVersion, ENVELOPE_SCHEMA_VERSION);
  assert.equal(envelope.diagnostics[0].message, 'tool unavailable');
});

test('createEnvelope supplies deterministic empty payloads', () => {
  assert.deepEqual(createEnvelope({ command: 'status', status: 'PASS' }), {
    schemaVersion: ENVELOPE_SCHEMA_VERSION,
    command: 'status',
    status: 'PASS',
    data: {},
    diagnostics: [],
  });
});

test('createEnvelope represents read-only advisory results without claiming PASS', () => {
  const envelope = createEnvelope({ command: 'observe', status: 'ADVISORY', data: { trusted: false } });
  assert.equal(envelope.status, 'ADVISORY');
  assert.equal(envelope.data.trusted, false);
});

test('createEnvelope validates command, status, and diagnostics', () => {
  assert.throws(() => createEnvelope({ status: 'PASS' }), /command/);
  assert.throws(() => createEnvelope({ command: 'run', status: 'maybe' }), /status/);
  assert.throws(
    () => createEnvelope({ command: 'run', status: 'FAIL', diagnostics: [{}] }),
    /diagnostic/,
  );
  assert.throws(
    () => createEnvelope({ command: 'run', status: 'FAIL', diagnostics: [null] }),
    /diagnostic/,
  );
  assert.throws(
    () => createEnvelope({ command: 'run', status: 'FAIL', diagnostics: {} }),
    /diagnostics must be an array/,
  );
});

test('formatJsonEnvelope emits one parseable JSON document with trailing newline', () => {
  const text = formatJsonEnvelope({ command: 'verify', status: 'FAIL', data: { failed: 1 } });
  assert.equal(text.endsWith('\n'), true);
  assert.equal(text.trim().split('\n')[0], '{');
  assert.deepEqual(JSON.parse(text), createEnvelope({
    command: 'verify', status: 'FAIL', data: { failed: 1 },
  }));
});

test('nested envelopes and Factory errors share the bounded redaction policy', () => {
  const canary = 'output-secret-canary';
  const policy = compileRedactionPolicy({ env: { API_TOKEN: canary } });
  const input = {
    command: 'run', status: 'FAIL',
    data: { nested: { password: canary }, echoed: `value=${canary}` },
    diagnostics: [{ level: 'error', code: 'FAILED', message: `token=${canary}`, detail: { cookie: canary } }],
  };
  const text = formatJsonEnvelope(input, { policy });
  assert.equal(text.includes(canary), false);
  const parsed = JSON.parse(text);
  assert.equal(parsed.data.nested.password, '<redacted>');
  assert.equal(parsed.diagnostics[0].detail.cookie, '<redacted>');
  assert.equal(input.data.nested.password, canary);

  const human = formatFactoryError(new Error(`Authorization: Bearer ${canary}`), { policy });
  assert.equal(human.includes(canary), false);
  assert.match(human, /^\[infra\] /);
});

test('oversized envelope values fail closed instead of returning raw data', () => {
  const canary = 'oversized-secret-canary';
  const envelope = createEnvelope({
    command: 'status', status: 'PASS', data: { payload: `${'x'.repeat(1024 * 1024)} token=${canary}` },
  });
  assert.equal(JSON.stringify(envelope).includes(canary), false);
  assert.equal(envelope.data.payload, '<redacted:limit>');
});
