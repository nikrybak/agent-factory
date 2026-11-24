'use strict';
/** @implements REQ-FK-011 Stable v1.1 component declarations and migration validation. */
const fs = require('node:fs');
const { normalizeRelativeRoot, resolveInside } = require('./paths');
const { stableDigest } = require('./stable-json');

const ID = /^[a-z][a-z0-9-]{1,62}$/;
const FORBIDDEN = new Set(['__proto__', 'constructor', 'prototype']);
const ROOT_KEYS = ['$schema', 'schemaVersion', 'project', 'profiles', 'sources', 'stack', 'risk', 'capabilities', 'authority', 'quality'];
const AUTHORITY_KEYS = ['destructive', 'dependencyInstall', 'schemaMigration', 'publicApiChange', 'networkWrite', 'publish', 'deploy', 'release'];
const RISK = ['low', 'medium', 'high', 'critical'];
const DATA = ['public', 'internal', 'confidential', 'restricted'];

function issue(list, path, code, message) { list.push({ path, code, message, severity: 'error' }); }
function object(value) { return value !== null && typeof value === 'object' && !Array.isArray(value); }
function strictObject(value, at, allowed, required, issues) {
  if (!object(value)) { issue(issues, at, 'type', 'must be an object'); return false; }
  for (const key of Object.keys(value)) {
    if (FORBIDDEN.has(key)) issue(issues, `${at}.${key}`, 'forbidden-key', `key '${key}' is forbidden`);
    else if (!allowed.includes(key)) issue(issues, `${at}.${key}`, 'unknown-key', `unknown key '${key}'`);
  }
  for (const key of required) if (!Object.hasOwn(value, key)) issue(issues, `${at}.${key}`, 'required', 'is required');
  return true;
}
function string(value, at, issues, { pattern, enums } = {}) {
  if (typeof value !== 'string' || value.length === 0) issue(issues, at, 'type', 'must be a non-empty string');
  else if (pattern && !pattern.test(value)) issue(issues, at, 'pattern', 'has an invalid format');
  else if (enums && !enums.includes(value)) issue(issues, at, 'enum', `must be one of: ${enums.join(', ')}`);
}
function bool(value, at, issues) { if (typeof value !== 'boolean') issue(issues, at, 'type', 'must be boolean'); }
function stringSet(value, at, issues, options = {}) {
  if (!Array.isArray(value)) { issue(issues, at, 'type', 'must be an array'); return; }
  const seen = new Set();
  value.forEach((entry, i) => {
    string(entry, `${at}[${i}]`, issues, options);
    if (seen.has(entry)) issue(issues, `${at}[${i}]`, 'duplicate', 'duplicate value');
    seen.add(entry);
  });
}
function relative(value, at, issues, rootDir) {
  string(value, at, issues);
  if (typeof value === 'string') {
    try { resolveInside(rootDir, value); } catch { issue(issues, at, 'path-escape', 'must be a root-bounded relative path'); }
  }
}

function validateManifest(value, options = {}) {
  const issues = [];
  const projectRoot = options.projectRoot || process.cwd();
  if (!strictObject(value, '$', ROOT_KEYS, ROOT_KEYS.filter(k => k !== '$schema'), issues)) return issues;
  if (Object.hasOwn(value, '$schema')) string(value.$schema, '$.$schema', issues);
  if (!['1.0.0', '1.1.0'].includes(value.schemaVersion)) {
    issue(issues, '$.schemaVersion', 'enum', 'must equal 1.0.0 or 1.1.0');
  }
  if (strictObject(value.project, '$.project', ['id', 'name', 'intent', 'repositoryRoot'], ['id', 'name', 'intent', 'repositoryRoot'], issues)) {
    string(value.project.id, '$.project.id', issues, { pattern: ID });
    string(value.project.name, '$.project.name', issues); string(value.project.intent, '$.project.intent', issues);
    relative(value.project.repositoryRoot, '$.project.repositoryRoot', issues, projectRoot);
  }
  stringSet(value.profiles, '$.profiles', issues, { pattern: ID });
  if (!Array.isArray(value.sources)) issue(issues, '$.sources', 'type', 'must be an array');
  else {
    const ids = new Set();
    value.sources.forEach((source, i) => {
      const at = `$.sources[${i}]`;
      if (strictObject(source, at, ['id', 'kind', 'location', 'required'], ['id', 'kind', 'location', 'required'], issues)) {
        string(source.id, `${at}.id`, issues, { pattern: ID });
        if (ids.has(source.id)) issue(issues, `${at}.id`, 'duplicate', 'duplicate source id'); ids.add(source.id);
        string(source.kind, `${at}.kind`, issues, { enums: ['local', 'git', 'archive', 'remote', 'docs', 'api', 'design'] });
        string(source.location, `${at}.location`, issues); bool(source.required, `${at}.required`, issues);
        if (source.kind === 'local') relative(source.location, `${at}.location`, issues, projectRoot);
      }
    });
  }
  if (strictObject(value.stack, '$.stack', ['mode', 'declared'], ['mode', 'declared'], issues)) {
    string(value.stack.mode, '$.stack.mode', issues, { enums: ['detect', 'declared', 'mixed'] });
    if (!Array.isArray(value.stack.declared)) issue(issues, '$.stack.declared', 'type', 'must be an array');
    else {
      const declarationIds = new Set();
      const declarationIdentities = new Set();
      value.stack.declared.forEach((entry, i) => {
      const at = `$.stack.declared[${i}]`;
      const keys = value.schemaVersion === '1.1.0'
        ? ['id', 'family', 'adapterId', 'runtime', 'packageManager', 'root']
        : ['family', 'runtime', 'packageManager', 'root'];
      const required = value.schemaVersion === '1.1.0'
        ? ['id', 'family', 'adapterId', 'root']
        : ['family'];
      if (strictObject(entry, at, keys, required, issues)) {
        if (Object.hasOwn(entry, 'id')) {
          string(entry.id, `${at}.id`, issues, { pattern: ID });
          if (declarationIds.has(entry.id)) issue(issues, `${at}.id`, 'duplicate', 'duplicate stack declaration id');
          declarationIds.add(entry.id);
        }
        string(entry.family, `${at}.family`, issues, { pattern: ID });
        if (Object.hasOwn(entry, 'adapterId')) string(entry.adapterId, `${at}.adapterId`, issues, { pattern: ID });
        for (const key of ['runtime', 'packageManager']) if (Object.hasOwn(entry, key)) string(entry[key], `${at}.${key}`, issues);
        if (Object.hasOwn(entry, 'root')) relative(entry.root, `${at}.root`, issues, projectRoot);
        if (value.schemaVersion === '1.1.0'
          && typeof entry.family === 'string' && typeof entry.root === 'string') {
          const normalized = normalizeRelativeRoot(entry.root);
          const identity = `${entry.family}:${normalized}`;
          if (declarationIdentities.has(identity)) issue(issues, at, 'duplicate', `duplicate stack declaration identity ${identity}`);
          declarationIdentities.add(identity);
        }
      }
      });
    }
  }
  if (strictObject(value.risk, '$.risk', ['class', 'dataSensitivity', 'internetExposure', 'regulated'], ['class', 'dataSensitivity', 'internetExposure', 'regulated'], issues)) {
    string(value.risk.class, '$.risk.class', issues, { enums: RISK }); string(value.risk.dataSensitivity, '$.risk.dataSensitivity', issues, { enums: DATA });
    bool(value.risk.internetExposure, '$.risk.internetExposure', issues); bool(value.risk.regulated, '$.risk.regulated', issues);
  }
  if (strictObject(value.capabilities, '$.capabilities', ['required', 'optional'], ['required', 'optional'], issues)) {
    stringSet(value.capabilities.required, '$.capabilities.required', issues, { pattern: ID }); stringSet(value.capabilities.optional, '$.capabilities.optional', issues, { pattern: ID });
  }
  if (strictObject(value.authority, '$.authority', AUTHORITY_KEYS, AUTHORITY_KEYS, issues)) for (const key of AUTHORITY_KEYS) bool(value.authority[key], `$.authority.${key}`, issues);
  if (strictObject(value.quality, '$.quality', ['changedCoverage', 'requiredGates', 'additionalChecks'], ['changedCoverage', 'requiredGates', 'additionalChecks'], issues)) {
    if (typeof value.quality.changedCoverage !== 'number' || value.quality.changedCoverage < 0 || value.quality.changedCoverage > 100) issue(issues, '$.quality.changedCoverage', 'range', 'must be between 0 and 100');
    stringSet(value.quality.requiredGates, '$.quality.requiredGates', issues, { pattern: ID }); stringSet(value.quality.additionalChecks, '$.quality.additionalChecks', issues, { pattern: ID });
  }
  return issues.sort((a, b) => `${a.path}:${a.code}`.localeCompare(`${b.path}:${b.code}`));
}

function loadManifest(projectRoot, manifestPath = 'factory/project.json') {
  const absolute = resolveInside(projectRoot, manifestPath);
  let manifest;
  try { manifest = JSON.parse(fs.readFileSync(absolute, 'utf8')); } catch (error) { throw new Error(`invalid project manifest: ${error.message}`); }
  const issues = validateManifest(manifest, { projectRoot });
  if (issues.length) throw new Error(`invalid project manifest: ${issues.map(i => `${i.path} ${i.message}`).join('; ')}`);
  return { manifest, path: absolute, digest: stableDigest(manifest) };
}

module.exports = { validateManifest, loadManifest };
