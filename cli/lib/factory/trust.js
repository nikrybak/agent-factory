'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const RISKS = ['low', 'medium', 'high', 'critical'];
const NETWORK_MODES = new Set(['none', 'allowlist']);
const SAFE_KEYS = new Set(['schemaVersion', 'defaultDecision', 'allowedRoots', 'provenance', 'tiers']);
const TIER_KEYS = new Set(['executables', 'authorities', 'network', 'maximumRisk']);
const NETWORK_KEYS = new Set(['mode', 'hosts']);
const PROVENANCE_KEYS = new Set(['schemaVersion', 'algorithm', 'trustedKeys']);
const TRUSTED_KEY_KEYS = new Set(['keyId', 'publicKeySpkiBase64', 'fingerprintSha256']);
const DIGEST = /^[a-f0-9]{64}$/;
const KEY_ID = /^[a-z][a-z0-9-]{0,62}$/;

function hasDuplicates(values) { return new Set(values).size !== values.length; }

function validateProvenancePolicy(provenance) {
  const errors = [];
  if (provenance === undefined) return errors;
  if (!provenance || typeof provenance !== 'object' || Array.isArray(provenance)) return ['provenance must be an object'];
  for (const key of Object.keys(provenance)) if (!PROVENANCE_KEYS.has(key)) errors.push(`unknown provenance key: ${key}`);
  if (provenance.schemaVersion !== '1.0.0') errors.push('provenance.schemaVersion must be 1.0.0');
  if (provenance.algorithm !== 'Ed25519') errors.push('provenance.algorithm must be Ed25519');
  if (!Array.isArray(provenance.trustedKeys)) return [...errors, 'provenance.trustedKeys must be an array'];
  const identities = []; const fingerprints = []; const keys = [];
  for (const [index, entry] of provenance.trustedKeys.entries()) {
    const label = `provenance.trustedKeys[${index}]`;
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      errors.push(`${label} must be an object`);
      continue;
    }
    for (const key of Object.keys(entry)) if (!TRUSTED_KEY_KEYS.has(key)) errors.push(`unknown ${label} key: ${key}`);
    if (!KEY_ID.test(entry.keyId || '')) errors.push(`${label}.keyId is invalid`);
    if (typeof entry.publicKeySpkiBase64 !== 'string' || entry.publicKeySpkiBase64 === '' || /\s/.test(entry.publicKeySpkiBase64)) {
      errors.push(`${label}.publicKeySpkiBase64 is invalid`);
      continue;
    }
    if (!DIGEST.test(entry.fingerprintSha256 || '')) errors.push(`${label}.fingerprintSha256 is invalid`);
    identities.push(entry.keyId); fingerprints.push(entry.fingerprintSha256); keys.push(entry.publicKeySpkiBase64);
    try {
      const der = Buffer.from(entry.publicKeySpkiBase64, 'base64');
      if (der.length === 0 || der.toString('base64') !== entry.publicKeySpkiBase64) throw new Error('non-canonical base64');
      const publicKey = crypto.createPublicKey({ key: der, type: 'spki', format: 'der' });
      const canonical = publicKey.export({ type: 'spki', format: 'der' });
      const fingerprint = crypto.createHash('sha256').update(canonical).digest('hex');
      if (publicKey.asymmetricKeyType !== 'ed25519' || !canonical.equals(der)) throw new Error('not canonical Ed25519 SPKI');
      if (fingerprint !== entry.fingerprintSha256) errors.push(`${label}.fingerprintSha256 does not match public key`);
    } catch {
      errors.push(`${label}.publicKeySpkiBase64 is not canonical Ed25519 SPKI`);
    }
  }
  if (hasDuplicates(identities)) errors.push('provenance keyId values must be unique');
  if (hasDuplicates(fingerprints)) errors.push('provenance fingerprints must be unique');
  if (hasDuplicates(keys)) errors.push('provenance public keys must be unique');
  return errors;
}

function validateTrustPolicy(policy) {
  const errors = [];
  if (!policy || typeof policy !== 'object' || Array.isArray(policy)) return { valid: false, errors: ['policy must be an object'] };
  for (const key of Object.keys(policy)) if (!SAFE_KEYS.has(key)) errors.push(`unknown policy key: ${key}`);
  if (policy.schemaVersion !== '1.0.0') errors.push('schemaVersion must be 1.0.0');
  if (policy.defaultDecision !== 'deny') errors.push('defaultDecision must be deny');
  if (!Array.isArray(policy.allowedRoots) || policy.allowedRoots.length === 0 || policy.allowedRoots.some(root => typeof root !== 'string' || root === '' || path.isAbsolute(root) || path.normalize(root).split(path.sep).includes('..'))) {
    errors.push('allowedRoots must be a non-empty array of relative paths');
  } else if (hasDuplicates(policy.allowedRoots)) errors.push('allowedRoots must be unique');
  errors.push(...validateProvenancePolicy(policy.provenance));
  if (!policy.tiers || typeof policy.tiers !== 'object' || Array.isArray(policy.tiers) || Object.keys(policy.tiers).length === 0) errors.push('tiers must be a non-empty object');
  else for (const [name, tier] of Object.entries(policy.tiers)) {
    if (!/^[a-z][a-z0-9-]*$/.test(name) || !tier || typeof tier !== 'object' || Array.isArray(tier)) {
      errors.push(`invalid tier: ${name}`);
      continue;
    }
    for (const key of Object.keys(tier)) if (!TIER_KEYS.has(key)) errors.push(`unknown tier key: ${name}.${key}`);
    for (const field of ['executables', 'authorities']) {
      if (!Array.isArray(tier[field]) || tier[field].some(value => typeof value !== 'string' || value === '')) errors.push(`${name}.${field} must be a string array`);
      else if (hasDuplicates(tier[field])) errors.push(`${name}.${field} must be unique`);
    }
    if (!tier.network || !NETWORK_MODES.has(tier.network.mode) || !Array.isArray(tier.network.hosts) || tier.network.hosts.some(host => typeof host !== 'string' || host === '')) errors.push(`${name}.network is invalid`);
    else {
      for (const key of Object.keys(tier.network)) if (!NETWORK_KEYS.has(key)) errors.push(`unknown network key: ${name}.network.${key}`);
      if (hasDuplicates(tier.network.hosts) || (tier.network.mode === 'none' && tier.network.hosts.length)) errors.push(`${name}.network hosts are invalid`);
    }
    if (!RISKS.includes(tier.maximumRisk)) errors.push(`${name}.maximumRisk is invalid`);
  }
  return { valid: errors.length === 0, errors };
}

function isInside(parent, child) {
  const relative = path.relative(parent, child);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

function realExisting(candidate) {
  if (!fs.existsSync(candidate)) return null;
  return fs.realpathSync.native(candidate);
}

function pathAllowed(projectRoot, allowedRoots, candidate) {
  if (typeof candidate !== 'string' || path.isAbsolute(candidate)) return false;
  const root = realExisting(path.resolve(projectRoot));
  if (!root) return false;
  const target = realExisting(path.resolve(root, candidate));
  if (!target || !isInside(root, target)) return false;
  return allowedRoots.some(item => {
    const allowed = realExisting(path.resolve(root, item));
    return allowed && isInside(root, allowed) && isInside(allowed, target);
  });
}

function deny(reasons, tier = null) { return { decision: 'deny', tier, reasons: [...new Set(reasons)] }; }

function evaluateTrust({ descriptor, policy, projectRoot }) {
  const validation = validateTrustPolicy(policy);
  if (!validation.valid) return deny(['invalid-policy', ...validation.errors]);
  if (!descriptor || typeof descriptor !== 'object' || Array.isArray(descriptor)) return deny(['invalid-descriptor']);
  const tier = policy.tiers[descriptor.tier];
  if (!tier) return deny(['unknown-tier'], descriptor.tier || null);
  const reasons = [];
  const executable = descriptor.executable || descriptor.tool;
  if (typeof executable !== 'string' || !tier.executables.includes(executable)) reasons.push('executable-not-allowed');
  if (!Array.isArray(descriptor.authority) || descriptor.authority.some(item => !tier.authorities.includes(item))) reasons.push('authority-not-allowed');
  if (!RISKS.includes(descriptor.risk)) reasons.push('unknown-risk');
  else if (RISKS.indexOf(descriptor.risk) > RISKS.indexOf(tier.maximumRisk)) reasons.push('risk-exceeds-tier');
  if (!pathAllowed(projectRoot, policy.allowedRoots, descriptor.cwd)) reasons.push('path-not-allowed');
  if (descriptor.paths !== undefined) {
    if (!Array.isArray(descriptor.paths) || descriptor.paths.some(item => !pathAllowed(projectRoot, policy.allowedRoots, item))) reasons.push('path-not-allowed');
  }
  const network = descriptor.network;
  if (!network || typeof network !== 'object') reasons.push('network-intent-required');
  else if (network.mode === 'none') {
    if (Array.isArray(network.hosts) && network.hosts.length) reasons.push('network-hosts-without-egress');
  } else if (network.mode === 'egress') {
    if (tier.network.mode !== 'allowlist' || !Array.isArray(network.hosts) || network.hosts.length === 0 || network.hosts.some(host => !tier.network.hosts.includes(host))) reasons.push('egress-not-allowed');
  } else reasons.push('unknown-network-mode');
  return reasons.length ? deny(reasons, descriptor.tier) : { decision: 'allow', tier: descriptor.tier, reasons: [] };
}

module.exports = { evaluateTrust, pathAllowed, validateProvenancePolicy, validateTrustPolicy };
