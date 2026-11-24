'use strict';

const crypto = require('node:crypto');
const { canonicalize, stableDigest, stableStringify } = require('./stable-json');
const { validateProvenancePolicy } = require('./trust');

const DIGEST = /^[a-f0-9]{64}$/;
const PROVENANCE_V1 = 'https://example.org/factory/provenance/v1';
const PROVENANCE_V2 = 'https://example.org/factory/provenance/v2';
const RELEASE_DOMAIN = 'factory.release-provenance/v1';
const SAFE_RUN_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const RELEASE_SIGNATURE_FIELDS = new Set([
  'schemaVersion', 'algorithm', 'keyId', 'keyFingerprintSha256', 'provenancePolicyDigest', 'value',
]);
const LEGACY_SIGNATURE_FIELDS = new Set(['algorithm', 'keyId', 'value']);

function isCanonicalDigestList(value, options = {}) {
  if (!Array.isArray(value) || value.some(item => !DIGEST.test(item))) return false;
  if (options.nonempty && value.length === 0) return false;
  return value.every((item, index) => index === 0 || value[index - 1] < item);
}

function provenanceVersion(predicateType) {
  if (predicateType === PROVENANCE_V1) return 'v1';
  if (predicateType === PROVENANCE_V2) return 'v2';
  return null;
}

function payloadOf(attestation) {
  if (!attestation || typeof attestation !== 'object' || Array.isArray(attestation)) return null;
  const { attestationDigest, signature, ...payload } = attestation;
  return payload;
}

function createAttestation(input) {
  if (!input || !DIGEST.test(input.treeHash || '') || !DIGEST.test(input.manifestDigest || '')
    || !DIGEST.test(input.certificationIdentityDigest || '') || !DIGEST.test(input.layoutInputDigest || '')
    || !Array.isArray(input.evidenceDigests) || input.evidenceDigests.length === 0
    || input.evidenceDigests.some(item => !DIGEST.test(item))) throw new Error('invalid provenance input');
  if (!input.sbom || typeof input.sbom !== 'object') throw new Error('SBOM is required');
  const releaseBindingPresent = input.workflowRunId !== undefined || input.planHash !== undefined;
  if (releaseBindingPresent && (!SAFE_RUN_ID.test(input.workflowRunId || '') || !DIGEST.test(input.planHash || ''))) {
    throw new Error('invalid release provenance binding');
  }
  const payload = canonicalize({
    predicateType: PROVENANCE_V2,
    subject: Array.isArray(input.subject) ? input.subject : [],
    treeHash: input.treeHash,
    manifestDigest: input.manifestDigest,
    certificationIdentityDigest: input.certificationIdentityDigest,
    layoutInputDigest: input.layoutInputDigest,
    evidenceDigests: [...new Set(input.evidenceDigests)].sort(),
    sbomDigest: stableDigest(input.sbom),
    ...(releaseBindingPresent ? { workflowRunId: input.workflowRunId, planHash: input.planHash } : {}),
  });
  return { ...payload, attestationDigest: stableDigest(payload) };
}

function normalizePrivateKey(privateKey) {
  const key = privateKey && privateKey.type === 'private' ? privateKey : crypto.createPrivateKey(privateKey);
  if (key.asymmetricKeyType !== 'ed25519') throw new Error('private key must be Ed25519');
  return key;
}

function signAttestation(attestation, privateKey, options = {}) {
  const checked = verifyAttestation(attestation);
  if (!checked.valid) throw new Error(`cannot sign invalid attestation: ${checked.reasons.join(', ')}`);
  const key = normalizePrivateKey(privateKey);
  const signature = crypto.sign(null, Buffer.from(attestation.attestationDigest, 'utf8'), key).toString('base64');
  return { ...attestation, signature: { algorithm: 'Ed25519', keyId: options.keyId || null, value: signature } };
}

function normalizePublicKey(publicKey) {
  const key = publicKey && publicKey.type === 'public' ? publicKey : crypto.createPublicKey(publicKey);
  if (key.asymmetricKeyType !== 'ed25519') throw new Error('public key must be Ed25519');
  return key;
}

function publicKeyIdentity(publicKey) {
  const key = normalizePublicKey(publicKey);
  const der = key.export({ type: 'spki', format: 'der' });
  return {
    key,
    publicKeySpkiBase64: der.toString('base64'),
    fingerprintSha256: crypto.createHash('sha256').update(der).digest('hex'),
  };
}

function provenancePolicyDigest(policy) {
  const provenance = policy?.provenance;
  if (!provenance || !Array.isArray(provenance.trustedKeys) || provenance.trustedKeys.length === 0) return null;
  if (validateProvenancePolicy(provenance).length) return null;
  return stableDigest(canonicalize(provenance));
}

function releaseSignaturePayload(attestationDigest, signature) {
  return canonicalize({
    domain: RELEASE_DOMAIN,
    attestationDigest,
    algorithm: 'Ed25519',
    keyId: signature.keyId,
    keyFingerprintSha256: signature.keyFingerprintSha256,
    provenancePolicyDigest: signature.provenancePolicyDigest,
  });
}

function strictReleaseSignature(signature) {
  if (!signature || typeof signature !== 'object' || Array.isArray(signature)) return false;
  if (Object.keys(signature).some(key => !RELEASE_SIGNATURE_FIELDS.has(key))
    || RELEASE_SIGNATURE_FIELDS.size !== Object.keys(signature).length) return false;
  return signature.schemaVersion === '1.0.0'
    && signature.algorithm === 'Ed25519'
    && /^[a-z][a-z0-9-]{0,62}$/.test(signature.keyId || '')
    && DIGEST.test(signature.keyFingerprintSha256 || '')
    && DIGEST.test(signature.provenancePolicyDigest || '')
    && typeof signature.value === 'string'
    && signature.value !== ''
    && !/\s/.test(signature.value)
    && Buffer.from(signature.value, 'base64').toString('base64') === signature.value;
}

function strictLegacySignature(signature) {
  if (!signature || typeof signature !== 'object' || Array.isArray(signature)) return false;
  const keys = Object.keys(signature);
  if (keys.length !== LEGACY_SIGNATURE_FIELDS.size
    || keys.some(key => !LEGACY_SIGNATURE_FIELDS.has(key))) return false;
  return signature.algorithm === 'Ed25519'
    && (signature.keyId === null || typeof signature.keyId === 'string')
    && typeof signature.value === 'string' && signature.value !== ''
    && !/\s/.test(signature.value)
    && Buffer.from(signature.value, 'base64').toString('base64') === signature.value;
}

function signReleaseAttestation(attestation, privateKey, policy) {
  const structural = verifyAttestation(attestation);
  const payload = payloadOf(attestation);
  if (!structural.valid || !structural.current || !SAFE_RUN_ID.test(payload?.workflowRunId || '')
    || !DIGEST.test(payload?.planHash || '')) throw new Error('release signing requires current run-bound provenance');
  const policyErrors = validateProvenancePolicy(policy?.provenance);
  const policyDigest = provenancePolicyDigest(policy);
  if (policyErrors.length || !policyDigest) throw new Error('governed provenance policy is unavailable');
  const privateKeyObject = normalizePrivateKey(privateKey);
  const identity = publicKeyIdentity(crypto.createPublicKey(privateKeyObject));
  const matches = policy.provenance.trustedKeys.filter(entry => (
    entry.fingerprintSha256 === identity.fingerprintSha256
    && entry.publicKeySpkiBase64 === identity.publicKeySpkiBase64
  ));
  if (matches.length !== 1) throw new Error('signing key is not uniquely governed');
  const signature = {
    schemaVersion: '1.0.0',
    algorithm: 'Ed25519',
    keyId: matches[0].keyId,
    keyFingerprintSha256: identity.fingerprintSha256,
    provenancePolicyDigest: policyDigest,
    value: '',
  };
  signature.value = crypto.sign(
    null,
    Buffer.from(stableStringify(releaseSignaturePayload(attestation.attestationDigest, signature)), 'utf8'),
    privateKeyObject,
  ).toString('base64');
  return { ...attestation, signature };
}

function verifyAttestation(attestation, options = {}) {
  const reasons = [];
  const payload = payloadOf(attestation);
  if (!payload || !DIGEST.test(attestation.attestationDigest || '')) return { valid: false, current: false, version: null, reasons: ['invalid-attestation'] };
  const version = provenanceVersion(payload.predicateType);
  if (!version) reasons.push('unsupported-predicate');
  const commonBindingValid = DIGEST.test(payload.treeHash || '') && DIGEST.test(payload.manifestDigest || '')
    && DIGEST.test(payload.sbomDigest || '') && Array.isArray(payload.evidenceDigests)
    && payload.evidenceDigests.every(item => DIGEST.test(item));
  const currentBindingValid = version !== 'v2' || (
    DIGEST.test(payload.certificationIdentityDigest || '')
    && DIGEST.test(payload.layoutInputDigest || '')
    && isCanonicalDigestList(payload.evidenceDigests, { nonempty: true })
  );
  if (!commonBindingValid || !currentBindingValid) reasons.push('invalid-binding');
  if (stableDigest(payload) !== attestation.attestationDigest) reasons.push('digest-mismatch');
  if (attestation.signature) {
    if (attestation.signature.algorithm !== 'Ed25519' || typeof attestation.signature.value !== 'string') reasons.push('invalid-signature-record');
    else if (!options.publicKey) reasons.push('public-key-required');
    else try {
      const key = normalizePublicKey(options.publicKey);
      const signedBytes = strictReleaseSignature(attestation.signature)
        ? Buffer.from(stableStringify(releaseSignaturePayload(attestation.attestationDigest, attestation.signature)), 'utf8')
        : Buffer.from(attestation.attestationDigest, 'utf8');
      if (!crypto.verify(null, signedBytes, key, Buffer.from(attestation.signature.value, 'base64'))) reasons.push('signature-mismatch');
    } catch { reasons.push('signature-mismatch'); }
  }
  const valid = reasons.length === 0;
  return { valid, current: valid && version === 'v2', version, reasons };
}

function sameList(left, right) {
  return Array.isArray(left) && Array.isArray(right)
    && left.length === right.length && left.every((item, index) => item === right[index]);
}

function matchesExpectedBinding(payload, expected) {
  const expectedValid = expected && SAFE_RUN_ID.test(expected.workflowRunId || '')
    && DIGEST.test(expected.planHash || '') && DIGEST.test(expected.treeHash || '')
    && DIGEST.test(expected.manifestDigest || '') && DIGEST.test(expected.certificationIdentityDigest || '')
    && DIGEST.test(expected.layoutInputDigest || '') && DIGEST.test(expected.sbomDigest || '')
    && isCanonicalDigestList(expected.evidenceDigests, { nonempty: true });
  return expectedValid && payload.workflowRunId === expected.workflowRunId
    && payload.planHash === expected.planHash && payload.treeHash === expected.treeHash
    && payload.manifestDigest === expected.manifestDigest
    && payload.certificationIdentityDigest === expected.certificationIdentityDigest
    && payload.layoutInputDigest === expected.layoutInputDigest
    && payload.sbomDigest === expected.sbomDigest
    && sameList(payload.evidenceDigests, expected.evidenceDigests);
}

function releaseAssessment(status, payload, signature, policyDigest, gaps) {
  const releaseGrade = status === 'PASS';
  return {
    schemaVersion: '1.0.0', status, releaseGrade, advisory: status === 'ADVISORY',
    workflowRunId: typeof payload?.workflowRunId === 'string' ? payload.workflowRunId : null,
    keyId: typeof signature?.keyId === 'string' ? signature.keyId : null,
    keyFingerprintSha256: typeof signature?.keyFingerprintSha256 === 'string'
      ? signature.keyFingerprintSha256 : null,
    provenancePolicyDigest: policyDigest || null,
    gaps: [...new Set(gaps)].map(code => ({ code })),
  };
}

function assessReleaseProvenance(attestation, { policy, expected, workflowComplete = false } = {}) {
  const payload = payloadOf(attestation);
  const signature = attestation?.signature;
  if (!payload || !DIGEST.test(attestation?.attestationDigest || '')) {
    return releaseAssessment('FAIL', payload, signature, null, ['PROVENANCE_ATTESTATION_INVALID']);
  }
  const unsigned = { ...attestation }; delete unsigned.signature;
  const structural = verifyAttestation(unsigned);
  if (!structural.valid) {
    return releaseAssessment('FAIL', payload, signature, null, ['PROVENANCE_ATTESTATION_INVALID']);
  }
  if (!structural.current) {
    return releaseAssessment('ADVISORY', payload, signature, null, ['PROVENANCE_ATTESTATION_HISTORICAL']);
  }
  if (expected !== undefined && !matchesExpectedBinding(payload, expected)) {
    return releaseAssessment('FAIL', payload, signature, provenancePolicyDigest(policy), ['PROVENANCE_FINAL_BINDING_MISMATCH']);
  }
  if (!signature) {
    return releaseAssessment('ADVISORY', payload, null, provenancePolicyDigest(policy), ['PROVENANCE_SIGNATURE_MISSING']);
  }
  if (!strictReleaseSignature(signature)) {
    return strictLegacySignature(signature)
      ? releaseAssessment('ADVISORY', payload, signature, provenancePolicyDigest(policy), ['PROVENANCE_SIGNATURE_LEGACY'])
      : releaseAssessment('FAIL', payload, signature, provenancePolicyDigest(policy), ['PROVENANCE_SIGNATURE_INVALID']);
  }
  const policyErrors = validateProvenancePolicy(policy?.provenance);
  const policyDigest = provenancePolicyDigest(policy);
  if (policyErrors.length) return releaseAssessment('FAIL', payload, signature, null, ['PROVENANCE_POLICY_INVALID']);
  if (!policyDigest) return releaseAssessment('ADVISORY', payload, signature, null, ['PROVENANCE_POLICY_UNAVAILABLE']);
  if (signature.provenancePolicyDigest !== policyDigest) {
    return releaseAssessment('FAIL', payload, signature, policyDigest, ['PROVENANCE_POLICY_MISMATCH']);
  }
  const matches = policy.provenance.trustedKeys.filter(entry => (
    entry.keyId === signature.keyId && entry.fingerprintSha256 === signature.keyFingerprintSha256
  ));
  if (matches.length !== 1) return releaseAssessment('FAIL', payload, signature, policyDigest, ['PROVENANCE_KEY_UNTRUSTED']);
  const key = normalizePublicKey({
    key: Buffer.from(matches[0].publicKeySpkiBase64, 'base64'), type: 'spki', format: 'der',
  });
  if (!verifyAttestation(attestation, { publicKey: key }).valid) {
    return releaseAssessment('FAIL', payload, signature, policyDigest, ['PROVENANCE_SIGNATURE_INVALID']);
  }
  if (!workflowComplete) return releaseAssessment('FAIL', payload, signature, policyDigest, ['PROVENANCE_WORKFLOW_INCOMPLETE']);
  if (expected === undefined) {
    return releaseAssessment('FAIL', payload, signature, policyDigest, ['PROVENANCE_FINAL_BINDING_MISMATCH']);
  }
  return releaseAssessment('PASS', payload, signature, policyDigest, []);
}

module.exports = {
  PROVENANCE_V1,
  PROVENANCE_V2,
  createAttestation,
  assessReleaseProvenance,
  payloadOf,
  provenancePolicyDigest,
  provenanceVersion,
  publicKeyIdentity,
  signAttestation,
  signReleaseAttestation,
  verifyAttestation,
};
