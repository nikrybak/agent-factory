const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const crypto = require('node:crypto');
const { evaluateTrust, validateTrustPolicy } = require('../lib/factory/trust');
const { publicKeyIdentity } = require('../lib/factory/provenance');

const policy = {
  schemaVersion: '1.0.0', defaultDecision: 'deny', allowedRoots: ['workspace'],
  tiers: {
    restricted: { executables: ['node'], authorities: ['read'], network: { mode: 'none', hosts: [] }, maximumRisk: 'medium' },
    privileged: { executables: ['node', 'git'], authorities: ['read', 'write-local'], network: { mode: 'allowlist', hosts: ['registry.npmjs.org'] }, maximumRisk: 'high' },
  },
};

function workspace() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'factory-trust-'));
  fs.mkdirSync(path.join(root, 'workspace'));
  return root;
}

test('trust policy is strict and unknown tiers, risk, executables, and authority deny by default', () => {
  assert.equal(validateTrustPolicy(policy).valid, true);
  const root = workspace();
  for (const descriptor of [
    { tier: 'unknown', executable: 'node', cwd: 'workspace', authority: ['read'], risk: 'low', network: { mode: 'none' } },
    { tier: 'restricted', executable: 'curl', cwd: 'workspace', authority: ['read'], risk: 'low', network: { mode: 'none' } },
    { tier: 'restricted', executable: 'node', cwd: 'workspace', authority: ['write-local'], risk: 'low', network: { mode: 'none' } },
    { tier: 'restricted', executable: 'node', cwd: 'workspace', authority: ['read'], risk: 'unknown', network: { mode: 'none' } },
    { tier: 'restricted', executable: 'node', cwd: 'workspace', authority: ['read'], risk: 'high', network: { mode: 'none' } },
  ]) assert.equal(evaluateTrust({ descriptor, policy, projectRoot: root }).decision, 'deny');
});

test('trust evaluation enforces allowed roots including symlink escape', () => {
  const root = workspace();
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'factory-outside-'));
  const base = { tier: 'restricted', executable: 'node', authority: ['read'], risk: 'low', network: { mode: 'none' } };
  assert.equal(evaluateTrust({ descriptor: { ...base, cwd: 'workspace' }, policy, projectRoot: root }).decision, 'allow');
  assert.equal(evaluateTrust({ descriptor: { ...base, cwd: '../outside' }, policy, projectRoot: root }).decision, 'deny');
  try {
    fs.symlinkSync(outside, path.join(root, 'workspace', 'escape'), 'junction');
    assert.equal(evaluateTrust({ descriptor: { ...base, cwd: 'workspace/escape' }, policy, projectRoot: root }).decision, 'deny');
  } catch (error) {
    if (!['EPERM', 'EACCES'].includes(error.code)) throw error;
  }
});

test('network egress is explicit and host allowlisted', () => {
  const root = workspace();
  const base = { tier: 'privileged', executable: 'node', cwd: 'workspace', authority: ['read'], risk: 'medium' };
  assert.equal(evaluateTrust({ descriptor: { ...base, network: { mode: 'egress', hosts: ['registry.npmjs.org'] } }, policy, projectRoot: root }).decision, 'allow');
  assert.equal(evaluateTrust({ descriptor: { ...base, network: { mode: 'egress', hosts: ['evil.example'] } }, policy, projectRoot: root }).decision, 'deny');
  assert.equal(evaluateTrust({ descriptor: base, policy, projectRoot: root }).decision, 'deny');
});

test('malformed policies fail closed', () => {
  assert.equal(validateTrustPolicy({ ...policy, defaultDecision: 'allow' }).valid, false);
  assert.equal(validateTrustPolicy({ ...policy, allowedRoots: ['..'] }).valid, false);
  assert.equal(validateTrustPolicy({ ...policy, tiers: { restricted: { ...policy.tiers.restricted, surprise: true } } }).valid, false);
  assert.equal(validateTrustPolicy({ ...policy, tiers: { 'Bad Tier': null } }).valid, false);
  assert.equal(evaluateTrust({ descriptor: {}, policy: { defaultDecision: 'allow' }, projectRoot: workspace() }).decision, 'deny');
  assert.equal(evaluateTrust({ descriptor: null, policy, projectRoot: workspace() }).decision, 'deny');
});

test('descriptor path lists and explicit no-egress intent are validated', () => {
  const root = workspace();
  const base = { tier: 'restricted', executable: 'node', cwd: 'workspace', authority: ['read'], risk: 'low' };
  assert.equal(evaluateTrust({ descriptor: { ...base, paths: ['workspace'], network: { mode: 'none' } }, policy, projectRoot: root }).decision, 'allow');
  assert.equal(evaluateTrust({ descriptor: { ...base, paths: ['missing'], network: { mode: 'none' } }, policy, projectRoot: root }).decision, 'deny');
  assert.equal(evaluateTrust({ descriptor: { ...base, network: { mode: 'none', hosts: ['example.test'] } }, policy, projectRoot: root }).decision, 'deny');
  assert.equal(evaluateTrust({ descriptor: { ...base, network: { mode: 'mystery' } }, policy, projectRoot: root }).decision, 'deny');
});

test('optional provenance trust anchors require canonical unique Ed25519 identities', () => {
  const identity = publicKeyIdentity(crypto.generateKeyPairSync('ed25519').publicKey);
  const trusted = {
    ...policy,
    provenance: {
      schemaVersion: '1.0.0', algorithm: 'Ed25519',
      trustedKeys: [{
        keyId: 'release-2026', publicKeySpkiBase64: identity.publicKeySpkiBase64,
        fingerprintSha256: identity.fingerprintSha256,
      }],
    },
  };
  assert.deepEqual(validateTrustPolicy(trusted), { valid: true, errors: [] });
  for (const invalid of [
    { ...trusted, provenance: { ...trusted.provenance, surprise: true } },
    { ...trusted, provenance: { ...trusted.provenance, algorithm: 'RSA' } },
    { ...trusted, provenance: { ...trusted.provenance, trustedKeys: [{ ...trusted.provenance.trustedKeys[0], keyId: 'Bad Key' }] } },
    { ...trusted, provenance: { ...trusted.provenance, trustedKeys: [{ ...trusted.provenance.trustedKeys[0], fingerprintSha256: '0'.repeat(64) }] } },
    { ...trusted, provenance: { ...trusted.provenance, trustedKeys: [trusted.provenance.trustedKeys[0], { ...trusted.provenance.trustedKeys[0] }] } },
    { ...trusted, provenance: { ...trusted.provenance, trustedKeys: [null] } },
    { ...trusted, provenance: { ...trusted.provenance, trustedKeys: [{
      ...trusted.provenance.trustedKeys[0], publicKeySpkiBase64: 'not base64',
    }] } },
    { ...trusted, provenance: { ...trusted.provenance, trustedKeys: [{
      ...trusted.provenance.trustedKeys[0], publicKeySpkiBase64: Buffer.from('not a key').toString('base64'),
    }] } },
  ]) assert.equal(validateTrustPolicy(invalid).valid, false);
  assert.equal(validateTrustPolicy({ ...policy, provenance: {
    schemaVersion: '1.0.0', algorithm: 'Ed25519', trustedKeys: [],
  } }).valid, true);
});
