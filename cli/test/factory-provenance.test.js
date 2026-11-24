const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');

const {
  assessReleaseProvenance, createAttestation, provenancePolicyDigest, publicKeyIdentity,
  signAttestation, signReleaseAttestation, verifyAttestation,
} = require('../lib/factory/provenance');
const { canonicalize, stableDigest } = require('../lib/factory/stable-json');

function input() {
  return {
    subject: [{ name: 'artifact.tgz', digest: { sha256: 'a'.repeat(64) } }],
    treeHash: 'b'.repeat(64), manifestDigest: 'c'.repeat(64),
    certificationIdentityDigest: '1'.repeat(64), layoutInputDigest: '2'.repeat(64),
    evidenceDigests: ['e'.repeat(64), 'd'.repeat(64)],
    sbom: { bomFormat: 'CycloneDX', components: [{ name: 'alpha', version: '1' }] },
  };
}

function releaseFixture() {
  const pair = crypto.generateKeyPairSync('ed25519');
  const identity = publicKeyIdentity(pair.publicKey);
  const policy = {
    provenance: {
      schemaVersion: '1.0.0', algorithm: 'Ed25519',
      trustedKeys: [{
        keyId: 'release-2026', publicKeySpkiBase64: identity.publicKeySpkiBase64,
        fingerprintSha256: identity.fingerprintSha256,
      }],
    },
  };
  const releaseInput = { ...input(), workflowRunId: 'selected-run', planHash: '3'.repeat(64) };
  const unsigned = createAttestation(releaseInput);
  const expected = {
    workflowRunId: releaseInput.workflowRunId, planHash: releaseInput.planHash,
    treeHash: releaseInput.treeHash, manifestDigest: releaseInput.manifestDigest,
    certificationIdentityDigest: releaseInput.certificationIdentityDigest,
    layoutInputDigest: releaseInput.layoutInputDigest,
    sbomDigest: stableDigest(releaseInput.sbom),
    evidenceDigests: [...releaseInput.evidenceDigests].sort(),
  };
  return { pair, policy, releaseInput, unsigned, expected };
}

test('provenance is deterministic, content addressed, and bound to all inputs', () => {
  const first = createAttestation(input());
  const second = createAttestation({ ...input(), evidenceDigests: [...input().evidenceDigests].reverse() });
  assert.deepEqual(first, second);
  assert.deepEqual(verifyAttestation(first), { valid: true, current: true, version: 'v2', reasons: [] });
  assert.equal(first.predicateType, 'https://example.org/factory/provenance/v2');
  assert.deepEqual(first.evidenceDigests, ['d'.repeat(64), 'e'.repeat(64)]);
  assert.equal(verifyAttestation({ ...first, treeHash: 'f'.repeat(64) }).valid, false);
  assert.equal(verifyAttestation({ ...first, sbomDigest: '0'.repeat(64) }).valid, false);
});

test('Ed25519 signatures verify and reject tampering or the wrong public key', () => {
  const pair = crypto.generateKeyPairSync('ed25519');
  const other = crypto.generateKeyPairSync('ed25519');
  const signed = signAttestation(createAttestation(input()), pair.privateKey, { keyId: 'release-key' });
  assert.equal(verifyAttestation(signed, { publicKey: pair.publicKey }).valid, true);
  assert.equal(verifyAttestation(signed, { publicKey: other.publicKey }).valid, false);
  assert.equal(verifyAttestation({ ...signed, manifestDigest: 'f'.repeat(64) }, { publicKey: pair.publicKey }).valid, false);
  assert.equal(JSON.stringify(signed).includes('PRIVATE KEY'), false);
});

test('signing rejects non-Ed25519 keys and malformed attestations fail closed', () => {
  const pair = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  assert.throws(() => signAttestation(createAttestation(input()), pair.privateKey), /Ed25519/);
  assert.equal(verifyAttestation(null).valid, false);
  assert.equal(verifyAttestation({}).valid, false);
});

test('signature records require a key and accept PEM public keys', () => {
  const pair = crypto.generateKeyPairSync('ed25519');
  const signed = signAttestation(createAttestation(input()), pair.privateKey.export({ type: 'pkcs8', format: 'pem' }));
  assert.equal(verifyAttestation(signed).valid, false);
  assert.equal(verifyAttestation(signed, { publicKey: pair.publicKey.export({ type: 'spki', format: 'pem' }) }).valid, true);
  assert.equal(verifyAttestation({ ...signed, signature: { algorithm: 'RSA', value: 'bad' } }, { publicKey: pair.publicKey }).valid, false);
  assert.equal(verifyAttestation(signed, { publicKey: 'not a public key' }).valid, false);
});

test('provenance rejects incomplete bindings and invalid attestations cannot be signed', () => {
  for (const invalid of [
    null, {}, { ...input(), treeHash: 'short' }, { ...input(), certificationIdentityDigest: null },
    { ...input(), layoutInputDigest: null }, { ...input(), sbom: null },
    { ...input(), evidenceDigests: [] }, { ...input(), evidenceDigests: ['bad'] },
  ]) assert.throws(() => createAttestation(invalid));
  assert.throws(() => signAttestation({}, crypto.generateKeyPairSync('ed25519').privateKey), /invalid attestation/);
  const valid = createAttestation({ ...input(), subject: null });
  assert.equal(verifyAttestation({ ...valid, evidenceDigests: ['bad'] }).valid, false);
});

test('historical v1 provenance remains verifiable but is never current', () => {
  const payload = canonicalize({
    predicateType: 'https://example.org/factory/provenance/v1',
    subject: input().subject,
    treeHash: input().treeHash,
    manifestDigest: input().manifestDigest,
    evidenceDigests: input().evidenceDigests.slice().sort(),
    sbomDigest: stableDigest(input().sbom),
  });
  const historical = { ...payload, attestationDigest: stableDigest(payload) };
  assert.deepEqual(verifyAttestation(historical), { valid: true, current: false, version: 'v1', reasons: [] });
});

test('v2 verification rejects empty, duplicate, or unsorted evidence bindings', () => {
  const valid = createAttestation(input());
  for (const evidenceDigests of [[], ['d'.repeat(64), 'd'.repeat(64)], ['e'.repeat(64), 'd'.repeat(64)]]) {
    const { attestationDigest, ...payload } = { ...valid, evidenceDigests };
    const malformed = { ...payload, attestationDigest: stableDigest(payload) };
    const verified = verifyAttestation(malformed);
    assert.equal(verified.valid, false);
    assert.equal(verified.current, false);
    assert.ok(verified.reasons.includes('invalid-binding'));
  }
});

test('governed release signatures bind run, plan, key identity, and current policy', () => {
  const fixture = releaseFixture();
  const signed = signReleaseAttestation(fixture.unsigned, fixture.pair.privateKey, fixture.policy);
  assert.equal(verifyAttestation(signed, { publicKey: fixture.pair.publicKey }).valid, true);
  const assessed = assessReleaseProvenance(signed, {
    policy: fixture.policy, expected: fixture.expected, workflowComplete: true,
  });
  assert.deepEqual(assessed, {
    schemaVersion: '1.0.0', status: 'PASS', releaseGrade: true, advisory: false,
    workflowRunId: 'selected-run', keyId: 'release-2026',
    keyFingerprintSha256: fixture.policy.provenance.trustedKeys[0].fingerprintSha256,
    provenancePolicyDigest: provenancePolicyDigest(fixture.policy), gaps: [],
  });
  assert.deepEqual(Object.keys(signed.signature).sort(), [
    'algorithm', 'keyFingerprintSha256', 'keyId', 'provenancePolicyDigest',
    'schemaVersion', 'value',
  ]);
});

test('unsigned, caller-key-only, and legacy signatures remain explicit advisory evidence', () => {
  const fixture = releaseFixture();
  const unsigned = assessReleaseProvenance(fixture.unsigned, {
    policy: fixture.policy, expected: fixture.expected, workflowComplete: true,
  });
  assert.equal(unsigned.status, 'ADVISORY');
  assert.equal(unsigned.releaseGrade, false);
  assert.equal(unsigned.keyId, null);
  assert.equal(unsigned.keyFingerprintSha256, null);
  assert.deepEqual(unsigned.gaps, [{ code: 'PROVENANCE_SIGNATURE_MISSING' }]);
  assert.deepEqual(assessReleaseProvenance(fixture.unsigned, {
    policy: fixture.policy,
    expected: { ...fixture.expected, workflowRunId: 'another-run' },
    workflowComplete: true,
  }).gaps, [{ code: 'PROVENANCE_FINAL_BINDING_MISMATCH' }]);
  assert.equal(verifyAttestation(signAttestation(fixture.unsigned, fixture.pair.privateKey), {
    publicKey: fixture.pair.publicKey,
  }).valid, true);
  const legacy = assessReleaseProvenance(
    signAttestation(fixture.unsigned, fixture.pair.privateKey),
    { policy: fixture.policy, expected: fixture.expected, workflowComplete: true },
  );
  assert.equal(legacy.status, 'ADVISORY');
  assert.deepEqual(legacy.gaps, [{ code: 'PROVENANCE_SIGNATURE_LEGACY' }]);
});

test('release assessment fails closed on policy drift, binding drift, tampering, and ungoverned keys', () => {
  const fixture = releaseFixture();
  const signed = signReleaseAttestation(fixture.unsigned, fixture.pair.privateKey, fixture.policy);
  const driftedPolicy = {
    provenance: { ...fixture.policy.provenance, trustedKeys: fixture.policy.provenance.trustedKeys.map(key => ({ ...key, keyId: 'rotated-key' })) },
  };
  assert.equal(assessReleaseProvenance(signed, {
    policy: driftedPolicy, expected: fixture.expected, workflowComplete: true,
  }).status, 'FAIL');
  assert.deepEqual(assessReleaseProvenance(signed, {
    policy: fixture.policy, expected: { ...fixture.expected, planHash: '4'.repeat(64) }, workflowComplete: true,
  }).gaps, [{ code: 'PROVENANCE_FINAL_BINDING_MISMATCH' }]);
  assert.equal(assessReleaseProvenance({ ...signed, treeHash: 'f'.repeat(64) }, {
    policy: fixture.policy, expected: fixture.expected, workflowComplete: true,
  }).status, 'FAIL');
  const corruptSignature = {
    ...signed, signature: { ...signed.signature, value: Buffer.alloc(64, 7).toString('base64') },
  };
  assert.deepEqual(assessReleaseProvenance(corruptSignature, {
    policy: fixture.policy, expected: fixture.expected, workflowComplete: true,
  }).gaps, [{ code: 'PROVENANCE_SIGNATURE_INVALID' }]);
  for (const signature of [
    { ...signed.signature, surprise: true },
    { ...signed.signature, schemaVersion: '2.0.0' },
    { ...signed.signature, value: `${signed.signature.value} ` },
    { algorithm: 'Ed25519', keyId: signed.signature.keyId, value: signed.signature.value, surprise: true },
  ]) assert.deepEqual(assessReleaseProvenance({ ...signed, signature }, {
    policy: fixture.policy, expected: fixture.expected, workflowComplete: true,
  }).gaps, [{ code: 'PROVENANCE_SIGNATURE_INVALID' }]);
  assert.deepEqual(assessReleaseProvenance(signed, {
    policy: fixture.policy, expected: fixture.expected, workflowComplete: false,
  }).gaps, [{ code: 'PROVENANCE_WORKFLOW_INCOMPLETE' }]);
  const other = crypto.generateKeyPairSync('ed25519');
  assert.throws(() => signReleaseAttestation(fixture.unsigned, other.privateKey, fixture.policy), /not uniquely governed/);
});

test('release-capable v2 inputs require a complete run and plan binding', () => {
  assert.throws(() => createAttestation({ ...input(), workflowRunId: 'selected-run' }), /release provenance binding/);
  assert.throws(() => createAttestation({ ...input(), workflowRunId: '../unsafe', planHash: '3'.repeat(64) }), /release provenance binding/);
  const historicalV2 = createAttestation(input());
  assert.equal(verifyAttestation(historicalV2).current, true);
  assert.equal(assessReleaseProvenance(historicalV2, { workflowComplete: true }).status, 'ADVISORY');
  assert.equal(assessReleaseProvenance(null).status, 'FAIL');
  const historicalPayload = canonicalize({
    predicateType: 'https://example.org/factory/provenance/v1',
    subject: input().subject, treeHash: input().treeHash, manifestDigest: input().manifestDigest,
    evidenceDigests: input().evidenceDigests.slice().sort(), sbomDigest: stableDigest(input().sbom),
  });
  const historical = { ...historicalPayload, attestationDigest: stableDigest(historicalPayload) };
  assert.deepEqual(assessReleaseProvenance(historical).gaps, [{ code: 'PROVENANCE_ATTESTATION_HISTORICAL' }]);
  const unsupportedPayload = { ...historicalPayload, predicateType: 'https://example.org/factory/provenance/unknown' };
  assert.ok(verifyAttestation({ ...unsupportedPayload, attestationDigest: stableDigest(unsupportedPayload) }).reasons.includes('unsupported-predicate'));
});
