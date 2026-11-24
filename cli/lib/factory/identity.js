'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { hashTree, hashValue } = require('./hash');
const { findBaseRoot, readRegistry, resolveProject, scanProjects } = require('../project');

const IDENTITY_SCHEMA_VERSION = '1.0.0';

function normalizeFinding(value) {
  if (Array.isArray(value)) return value.map(normalizeFinding);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, normalizeFinding(item)]));
  }
  return typeof value === 'string' ? value.replace(/\\/g, '/') : value;
}

/**
 * Build the machine-neutral resolver input used by contextual certification.
 * Absolute roots are useful diagnostics, but are intentionally kept outside
 * this value and therefore outside every identity digest.
 */
function layoutIdentityInput({ scope, key, registry, registryEntry, findings }) {
  if (scope === 'standalone') return { schemaVersion: IDENTITY_SCHEMA_VERSION, scope, findings: [] };
  if (scope === 'child' && registryEntry) {
    return {
      schemaVersion: IDENTITY_SCHEMA_VERSION,
      scope,
      key,
      registryEntry,
      findings,
    };
  }
  return {
    schemaVersion: IDENTITY_SCHEMA_VERSION,
    scope,
    registry,
    findings,
  };
}

/**
 * Evaluate only the registry/layout slice owned by the resolved project.
 * Registered children ignore sibling findings, while a base owns the entire
 * registry. Standalone repositories have no City Fabric layout dependency.
 */
function evaluateProjectLayout(rootDir) {
  const root = fs.realpathSync.native(path.resolve(rootDir));
  const discoveredBase = findBaseRoot(root);
  if (!discoveredBase) {
    const identityInput = layoutIdentityInput({ scope: 'standalone', findings: [] });
    return {
      status: 'PASS',
      gaps: [],
      findings: [],
      baseRoot: root,
      scope: 'standalone',
      key: null,
      inputDigest: hashValue(identityInput),
    };
  }

  const baseRoot = fs.realpathSync.native(path.resolve(discoveredBase));
  const context = resolveProject(root);
  const registry = readRegistry(baseRoot);
  const allFindings = scanProjects(baseRoot);
  const registryEntry = context.scope === 'child' && context.inRegistry
    ? registry.projects.find(entry => entry.key === context.key) ?? null
    : null;
  const findings = (registryEntry
    ? allFindings.filter(finding => finding.key === context.key)
    : allFindings).map(normalizeFinding);
  const scope = context.scope === 'child' ? 'child' : 'base';
  const key = registryEntry ? context.key : null;
  const identityInput = layoutIdentityInput({
    scope,
    key,
    registry,
    registryEntry,
    findings,
  });

  return {
    status: findings.length ? 'FAIL' : 'PASS',
    gaps: findings.map(finding => ({ code: 'PROJECT_LAYOUT_DRIFT', ...finding })),
    findings,
    baseRoot,
    scope,
    key,
    inputDigest: hashValue(identityInput),
  };
}

/**
 * Return the source-only tree hash and its separate resolver-context identity.
 * Keeping the two values distinct preserves the established treeHash contract.
 */
function computeCertificationIdentity(rootDir) {
  const root = fs.realpathSync.native(path.resolve(rootDir));
  const sourceTreeHash = hashTree(root);
  const layout = evaluateProjectLayout(root);
  const identityInput = {
    schemaVersion: IDENTITY_SCHEMA_VERSION,
    scope: layout.scope,
    key: layout.key,
    sourceTreeHash,
    layoutInputDigest: layout.inputDigest,
  };
  return {
    schemaVersion: IDENTITY_SCHEMA_VERSION,
    scope: layout.scope,
    key: layout.key,
    sourceTreeHash,
    layoutInputDigest: layout.inputDigest,
    certificationIdentityDigest: hashValue(identityInput),
  };
}

module.exports = {
  IDENTITY_SCHEMA_VERSION,
  computeCertificationIdentity,
  evaluateProjectLayout,
};
