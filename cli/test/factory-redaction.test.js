'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const {
  FAILURE_REDACTED, LIMIT_REDACTED, REDACTED, REDACTION_POLICY_VERSION,
  assertCredentialFreeArgv, compileRedactionPolicy, containsSensitiveMaterial,
  createRedactingCollector, redactArgv, redactError, redactText, redactValue,
} = require('../lib/factory/redaction');

const CANARY = 'runtime-canary-8c2d7b6413';

test('versioned policy rejects credential-bearing provider argv without retaining values', () => {
  assert.equal(REDACTION_POLICY_VERSION, '1.0.0');
  assert.equal(assertCredentialFreeArgv(['npm', 'test']), true);
  for (const argv of [
    ['tool', '--token', CANARY],
    ['tool', '--API_KEY=embedded-value'],
    ['tool', '--github-token', CANARY],
    ['tool', `--aws-secret-access-key=${CANARY}`],
    ['curl', '-H', `Authorization: Bearer ${CANARY}`],
    ['tool', `https://user:${CANARY}@example.test/path`],
    ['tool', `https://example.test/path?access_token=${CANARY}`],
  ]) {
    assert.throws(() => assertCredentialFreeArgv(argv), error => {
      assert.equal(error.code, 'EVIDENCE_PROVIDER_CREDENTIAL');
      assert.equal(error.message.includes(CANARY), false);
      return true;
    });
  }
});

test('argv, environment literals, and shaped credentials share one idempotent sanitizer', () => {
  const policy = compileRedactionPolicy({
    argv: ['tool', '--token', CANARY],
    env: {
      CLIENT_SECRET: 'env-secret-42', GITHUB_TOKEN: 'github-secret-42',
      AWS_SECRET_ACCESS_KEY: 'aws-secret-42', SAFE: 'visible',
    },
  });
  assert.deepEqual(
    redactArgv(['tool', '--token', CANARY, '--name', 'safe'], policy),
    ['tool', '--token', REDACTED, '--name', 'safe'],
  );
  const raw = `echo ${CANARY} env-secret-42 github-secret-42 aws-secret-42 Authorization: Bearer abc.def.ghi token=plain-secret OPENAI_API_KEY=openai-secret`;
  const sanitized = redactText(raw, policy);
  assert.equal(sanitized.includes(CANARY), false);
  assert.equal(sanitized.includes('env-secret-42'), false);
  assert.equal(sanitized.includes('github-secret-42'), false);
  assert.equal(sanitized.includes('aws-secret-42'), false);
  assert.equal(sanitized.includes('openai-secret'), false);
  assert.equal(sanitized.includes('plain-secret'), false);
  assert.equal(redactText(sanitized, policy), sanitized);
  assert.equal(redactText('tokenization is safe and a'.repeat(32)), 'tokenization is safe and a'.repeat(32));
  const digest = 'a'.repeat(64);
  assert.equal(redactText(digest), digest);
  assert.equal(redactValue({ evidenceDigest: digest }, {
    policy: compileRedactionPolicy({ env: { API_TOKEN: digest } }),
  }).evidenceDigest, digest);
});

test('stream collector redacts every chunk split and remains safe across tail truncation', () => {
  const policy = compileRedactionPolicy({ env: { API_TOKEN: CANARY } });
  const payload = `before:${CANARY}:after`;
  for (let split = 0; split <= payload.length; split += 1) {
    const collector = createRedactingCollector({ policy, maxBytes: 128 });
    collector.write(Buffer.from(payload.slice(0, split)));
    collector.write(Buffer.from(payload.slice(split)));
    const result = collector.finish();
    assert.equal(result.text.includes(CANARY), false, `split ${split}`);
    assert.equal(result.text.includes(REDACTED), true, `split ${split}`);
  }

  const collector = createRedactingCollector({ policy, maxBytes: 24 });
  collector.write('x'.repeat(9000));
  collector.write(CANARY.slice(0, 7));
  collector.write(CANARY.slice(7));
  collector.write(':tail');
  const truncated = collector.finish();
  assert.equal(truncated.truncated, true);
  assert.equal(truncated.text.includes(CANARY), false);
  assert.equal(truncated.text.includes(CANARY.slice(-10)), false);
  assert.ok(Buffer.byteLength(truncated.text) <= 24);

  const shaped = createRedactingCollector({ maxBytes: 32 });
  shaped.write('x'.repeat(9000));
  shaped.write('-----BEGIN PRIVATE KEY-----\n');
  shaped.write('A'.repeat(9000));
  assert.deepEqual(shaped.finish(), { text: FAILURE_REDACTED, truncated: true });
  assert.equal(redactText('prefix -----BEGIN PRIVATE KEY-----\nPRIVATE-BODY'), `prefix ${REDACTED}`);
});

test('recursive redaction is deterministic, bounded, non-mutating, and fail closed', () => {
  const input = {
    password: CANARY,
    nested: { authorization: `Bearer ${CANARY}`, digest: 'b'.repeat(64) },
    text: `token=${CANARY}`,
  };
  input.loop = input;
  const first = redactValue(input, { maxStringBytes: 1024, maxTotalBytes: 4096 });
  const second = redactValue(first, { maxStringBytes: 1024, maxTotalBytes: 4096 });
  assert.equal(input.password, CANARY);
  assert.equal(first.password, REDACTED);
  assert.equal(first.nested.authorization, REDACTED);
  assert.equal(first.nested.digest, 'b'.repeat(64));
  assert.equal(first.loop, LIMIT_REDACTED);
  assert.deepEqual(second, first);
  assert.equal(redactValue('x'.repeat(200), { maxStringBytes: 16 }), LIMIT_REDACTED);
  assert.equal(redactValue(Symbol('unsafe')), FAILURE_REDACTED);
});

test('sensitive-content detection and error redaction never rewrite or return the canary', () => {
  const raw = { nested: { client_secret: CANARY } };
  assert.equal(containsSensitiveMaterial(raw), true);
  assert.equal(containsSensitiveMaterial(redactValue(raw)), false);
  assert.equal(raw.nested.client_secret, CANARY);
  const safe = redactError(Object.assign(new Error(`request token=${CANARY}`), { code: 'AUTH_FAILED' }));
  assert.equal(safe.code, 'AUTH_FAILED');
  assert.equal(safe.message.includes(CANARY), false);
  assert.ok(safe.message.length <= 4096);
});

test('flag-valued sensitive variables are not literal secrets but assignments stay redacted', () => {
  const policy = compileRedactionPolicy({
    env: { CHILD_SESSION: '1', FEATURE_TOKEN: 'true', SESSION_ID: 'off', API_TOKEN: 'abcd-secret' },
  });
  assert.deepEqual(policy.secrets, ['abcd-secret']);
  const text = 'C:\\Temp\\factory cli space-1rFoli\\preview-client is true, off, 1/2';
  assert.equal(redactText(text, policy), text);
  assert.equal(redactText('session_id=1 token: true', policy), `session_id=${REDACTED} token: ${REDACTED}`);
  assert.equal(redactText('key abcd-secret', policy), `key ${REDACTED}`);
});

test('oversized runtime secrets force generic fail-closed output', () => {
  const policy = compileRedactionPolicy({ env: { API_TOKEN: 's'.repeat(5000) } });
  const collector = createRedactingCollector({ policy, maxBytes: 128 });
  collector.write('otherwise safe output');
  assert.equal(collector.finish().text, FAILURE_REDACTED);
  assert.equal(redactText('otherwise safe output', policy), FAILURE_REDACTED);
});

test('sanitizer edge branches remain fail closed without weakening safe values', () => {
  assert.throws(() => assertCredentialFreeArgv(null), error => error.code === 'EVIDENCE_PROVIDER_CREDENTIAL');
  assert.throws(() => assertCredentialFreeArgv(['tool', 42]), error => error.code === 'EVIDENCE_PROVIDER_CREDENTIAL');
  assert.throws(() => assertCredentialFreeArgv(['tool', '--token']), error => error.code === 'EVIDENCE_PROVIDER_CREDENTIAL');
  assert.deepEqual(redactArgv(null), [FAILURE_REDACTED]);
  assert.throws(() => createRedactingCollector({ maxBytes: 0 }), /positive integer/);

  const policy = compileRedactionPolicy({ argv: ['tool', '--token=inline'], env: { TOKEN: null } });
  const nested = { argv: ['tool', '--token', 'inline'], safe: [true, 7, null, undefined] };
  const sanitized = redactValue(nested, { policy });
  assert.deepEqual(sanitized.argv, ['tool', '--token', REDACTED]);
  assert.deepEqual(sanitized.safe, [true, 7, null, null]);
  assert.equal(containsSensitiveMaterial(nested, policy), true);
  assert.equal(containsSensitiveMaterial(sanitized, policy), false);

  const throwingPolicy = Object.defineProperty({}, 'secrets', {
    get() { throw new Error('classifier fault'); },
  });
  assert.equal(redactText('must not escape', throwingPolicy), FAILURE_REDACTED);
  const throwingValue = new Proxy({}, { ownKeys() { throw new Error('value fault'); } });
  assert.equal(redactValue(throwingValue), FAILURE_REDACTED);
});
