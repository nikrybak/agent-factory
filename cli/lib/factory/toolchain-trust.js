'use strict';
/** @implements REQ-FK-010 Operator-enrolled physical executable trust without TOFU. */

const fs = require('node:fs');
const path = require('node:path');
const {
  FILESYSTEM_BOUNDARY_VERSION, FILESYSTEM_CAPABILITY_DIGEST, readOpenedFile,
} = require('./filesystem-boundary');
const { hashValue } = require('./hash');
const { atomicWriteJson } = require('./store');

const TOOLCHAIN_TRUST_VERSION = '1.0.0';
const TOOLCHAIN_TRUST_PATH = '.factory/toolchain-trust.json';
const RESERVED_ANCHORS = new Set(['node', 'npm', 'npx']);
const LOGICAL_EXECUTABLE = /^[a-z][a-z0-9._+-]{0,63}$/;
const SHA256 = /^[a-f0-9]{64}$/;
const MAX_ENTRIES = 256;
const MAX_DIGESTS_PER_ENTRY = 64;
const ERROR_MESSAGES = Object.freeze({
  FACTORY_TOOLCHAIN_TRUST_INVALID: 'local toolchain trust is invalid',
  FACTORY_TOOLCHAIN_UNAUTHORIZED: 'governed executable is not authorized',
  FACTORY_TOOLCHAIN_TRUST_CHANGED: 'local toolchain trust changed',
  FACTORY_TOOLCHAIN_ENROLLMENT_INVALID: 'local toolchain enrollment is invalid',
});

function trustError(code) {
  const error = new Error(ERROR_MESSAGES[code]);
  error.code = code;
  return error;
}

function fail(code) {
  throw trustError(code);
}

function isTrustError(error) {
  return error instanceof Error
    && Object.hasOwn(ERROR_MESSAGES, error.code)
    && error.message === ERROR_MESSAGES[error.code];
}

function platformFamily(platform = process.platform) {
  return platform === 'win32' ? 'win32' : 'posix';
}

function normalizeLogicalExecutable(value) {
  if (typeof value !== 'string' || !value || value.includes('\0')) {
    fail('FACTORY_TOOLCHAIN_TRUST_INVALID');
  }
  const basename = value.replaceAll('\\', '/').split('/').at(-1);
  const normalized = basename.toLowerCase().replace(/\.(?:exe|com)$/i, '');
  if (!LOGICAL_EXECUTABLE.test(normalized)) fail('FACTORY_TOOLCHAIN_TRUST_INVALID');
  return normalized;
}

function exactKeys(value, expected) {
  return value && typeof value === 'object' && !Array.isArray(value)
    && JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...expected].sort());
}

function assertNoDuplicateJsonKeys(text) {
  let cursor = 0;
  const whitespace = () => {
    while (/[\x20\x09\x0a\x0d]/.test(text[cursor] || '')) cursor += 1;
  };
  const parseString = () => {
    const start = cursor;
    if (text[cursor++] !== '"') fail('FACTORY_TOOLCHAIN_TRUST_INVALID');
    while (cursor < text.length) {
      const character = text[cursor++];
      if (character === '"') {
        try { return JSON.parse(text.slice(start, cursor)); }
        catch { return fail('FACTORY_TOOLCHAIN_TRUST_INVALID'); }
      }
      if (character === '\\') {
        if (cursor >= text.length) fail('FACTORY_TOOLCHAIN_TRUST_INVALID');
        cursor += text[cursor] === 'u' ? 5 : 1;
      } else if (character.charCodeAt(0) < 0x20) {
        fail('FACTORY_TOOLCHAIN_TRUST_INVALID');
      }
    }
    fail('FACTORY_TOOLCHAIN_TRUST_INVALID');
  };
  const parseValue = () => {
    whitespace();
    if (text[cursor] === '{') {
      cursor += 1; whitespace();
      const keys = new Set();
      if (text[cursor] === '}') { cursor += 1; return; }
      while (cursor < text.length) {
        const key = parseString();
        if (keys.has(key)) fail('FACTORY_TOOLCHAIN_TRUST_INVALID');
        keys.add(key); whitespace();
        if (text[cursor++] !== ':') fail('FACTORY_TOOLCHAIN_TRUST_INVALID');
        parseValue(); whitespace();
        if (text[cursor] === '}') { cursor += 1; return; }
        if (text[cursor++] !== ',') fail('FACTORY_TOOLCHAIN_TRUST_INVALID');
        whitespace();
      }
      fail('FACTORY_TOOLCHAIN_TRUST_INVALID');
    }
    if (text[cursor] === '[') {
      cursor += 1; whitespace();
      if (text[cursor] === ']') { cursor += 1; return; }
      while (cursor < text.length) {
        parseValue(); whitespace();
        if (text[cursor] === ']') { cursor += 1; return; }
        if (text[cursor++] !== ',') fail('FACTORY_TOOLCHAIN_TRUST_INVALID');
      }
    }
    if (text[cursor] === '"') { parseString(); return; }
    const remainder = text.slice(cursor);
    const token = remainder.match(/^(?:true|false|null|-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?)/)?.[0];
    if (!token) fail('FACTORY_TOOLCHAIN_TRUST_INVALID');
    cursor += token.length;
  };
  if (typeof text !== 'string' || !text.length || text.charCodeAt(0) === 0xfeff) {
    fail('FACTORY_TOOLCHAIN_TRUST_INVALID');
  }
  parseValue(); whitespace();
  if (cursor !== text.length) fail('FACTORY_TOOLCHAIN_TRUST_INVALID');
  return true;
}

function validateToolchainTrust(value, options = {}) {
  try {
    const family = platformFamily(options.platform);
    if (!exactKeys(value, ['schemaVersion', 'platformFamily', 'entries'])
      || value.schemaVersion !== TOOLCHAIN_TRUST_VERSION
      || value.platformFamily !== family
      || !Array.isArray(value.entries) || value.entries.length > MAX_ENTRIES) {
      fail('FACTORY_TOOLCHAIN_TRUST_INVALID');
    }
    const logicalNames = new Set();
    const entries = value.entries.map(entry => {
      if (!exactKeys(entry, ['logicalExecutable', 'sha256'])
        || typeof entry.logicalExecutable !== 'string'
        || normalizeLogicalExecutable(entry.logicalExecutable) !== entry.logicalExecutable
        || RESERVED_ANCHORS.has(entry.logicalExecutable)
        || logicalNames.has(entry.logicalExecutable)
        || !Array.isArray(entry.sha256) || entry.sha256.length < 1
        || entry.sha256.length > MAX_DIGESTS_PER_ENTRY
        || entry.sha256.some(digest => !SHA256.test(digest))
        || new Set(entry.sha256).size !== entry.sha256.length
        || JSON.stringify(entry.sha256) !== JSON.stringify([...entry.sha256].sort())) {
        fail('FACTORY_TOOLCHAIN_TRUST_INVALID');
      }
      logicalNames.add(entry.logicalExecutable);
      return Object.freeze({
        logicalExecutable: entry.logicalExecutable,
        sha256: Object.freeze([...entry.sha256]),
      });
    });
    if (JSON.stringify(entries.map(entry => entry.logicalExecutable))
      !== JSON.stringify(entries.map(entry => entry.logicalExecutable).sort())) {
      fail('FACTORY_TOOLCHAIN_TRUST_INVALID');
    }
    return Object.freeze({
      schemaVersion: TOOLCHAIN_TRUST_VERSION,
      platformFamily: family,
      entries: Object.freeze(entries),
    });
  } catch (error) {
    if (isTrustError(error)) throw error;
    fail('FACTORY_TOOLCHAIN_TRUST_INVALID');
  }
}

function serializeOpenedIdentity(identity) {
  return Object.freeze({
    root: `${identity.root.dev}:${identity.root.ino}:${identity.root.type}`,
    ancestors: Object.freeze(identity.ancestors.map(
      item => `${item.dev}:${item.ino}:${item.type}`,
    )),
    final: `${identity.final.dev}:${identity.final.ino}:${identity.final.type}:${identity.final.nlink}`,
  });
}

function absentSnapshot(platform) {
  return Object.freeze({
    schemaVersion: TOOLCHAIN_TRUST_VERSION,
    platformFamily: platformFamily(platform),
    present: false,
    contentDigest: null,
    openedPathIdentity: null,
    filesystemBoundaryVersion: FILESYSTEM_BOUNDARY_VERSION,
    filesystemCapabilityDigest: FILESYSTEM_CAPABILITY_DIGEST,
    entries: Object.freeze([]),
  });
}

function loadToolchainTrust(root, options = {}) {
  const fileSystem = options.fileSystem || fs;
  const platform = options.platform || process.platform;
  let exists;
  try {
    if (typeof root !== 'string' || !root || typeof fileSystem.lstatSync !== 'function') {
      fail('FACTORY_TOOLCHAIN_TRUST_INVALID');
    }
    fileSystem.lstatSync(path.resolve(root, TOOLCHAIN_TRUST_PATH), { bigint: true });
    exists = true;
  } catch (error) {
    if (isTrustError(error)) throw error;
    if (error && ['ENOENT', 'ENOTDIR'].includes(error.code)) exists = false;
    else fail('FACTORY_TOOLCHAIN_TRUST_INVALID');
  }
  if (!exists) return absentSnapshot(platform);
  try {
    const opened = readOpenedFile(root, TOOLCHAIN_TRUST_PATH, {
      fileSystem, maxBytes: 1024 * 1024, fault: options.fault,
    });
    const text = opened.buffer.toString('utf8');
    assertNoDuplicateJsonKeys(text);
    const document = validateToolchainTrust(JSON.parse(text), { platform });
    return Object.freeze({
      ...document,
      present: true,
      contentDigest: opened.contentDigest,
      openedPathIdentity: serializeOpenedIdentity(opened.identity),
      filesystemBoundaryVersion: FILESYSTEM_BOUNDARY_VERSION,
      filesystemCapabilityDigest: FILESYSTEM_CAPABILITY_DIGEST,
    });
  } catch (error) {
    if (isTrustError(error)) throw error;
    fail('FACTORY_TOOLCHAIN_TRUST_INVALID');
  }
}

function toolchainTrustPlanIdentity(snapshot) {
  try {
    const identity = {
      schemaVersion: snapshot.schemaVersion,
      platformFamily: snapshot.platformFamily,
      present: snapshot.present,
      contentDigest: snapshot.contentDigest,
      openedPathIdentity: snapshot.openedPathIdentity,
      filesystemBoundaryVersion: snapshot.filesystemBoundaryVersion,
      filesystemCapabilityDigest: snapshot.filesystemCapabilityDigest,
    };
    if (snapshot.schemaVersion !== TOOLCHAIN_TRUST_VERSION
      || !['win32', 'posix'].includes(snapshot.platformFamily)
      || typeof snapshot.present !== 'boolean'
      || (snapshot.present ? !SHA256.test(snapshot.contentDigest || '') : snapshot.contentDigest !== null)
      || (snapshot.present ? !snapshot.openedPathIdentity : snapshot.openedPathIdentity !== null)
      || snapshot.filesystemBoundaryVersion !== FILESYSTEM_BOUNDARY_VERSION
      || snapshot.filesystemCapabilityDigest !== FILESYSTEM_CAPABILITY_DIGEST) {
      fail('FACTORY_TOOLCHAIN_TRUST_INVALID');
    }
    identity.identityDigest = hashValue(identity);
    return Object.freeze(identity);
  } catch (error) {
    if (isTrustError(error)) throw error;
    fail('FACTORY_TOOLCHAIN_TRUST_INVALID');
  }
}

function authorizationPayload(fields) {
  const authorization = {
    schemaVersion: TOOLCHAIN_TRUST_VERSION,
    platformFamily: fields.platformFamily,
    source: fields.source,
    logicalExecutable: fields.logicalExecutable,
    executableContentDigest: fields.executableContentDigest,
    trustDocument: fields.trustDocument,
  };
  authorization.authorizationDigest = hashValue(authorization);
  return Object.freeze(authorization);
}

function authorizeExecutable(input) {
  try {
    const { logicalExecutable, executableDigest, snapshot, anchor = false } = input;
    const normalized = normalizeLogicalExecutable(logicalExecutable);
    if (!SHA256.test(executableDigest || '')) fail('FACTORY_TOOLCHAIN_UNAUTHORIZED');
    if (anchor) {
      if (!RESERVED_ANCHORS.has(logicalExecutable) || normalized !== logicalExecutable) {
        fail('FACTORY_TOOLCHAIN_UNAUTHORIZED');
      }
      return authorizationPayload({
        platformFamily: snapshot?.platformFamily || platformFamily(),
        source: 'process-anchor', logicalExecutable: normalized,
        executableContentDigest: executableDigest, trustDocument: null,
      });
    }
    const identity = toolchainTrustPlanIdentity(snapshot);
    const entry = snapshot.entries.find(item => item.logicalExecutable === normalized);
    if (!snapshot.present || !entry || !entry.sha256.includes(executableDigest)) {
      fail('FACTORY_TOOLCHAIN_UNAUTHORIZED');
    }
    return authorizationPayload({
      platformFamily: snapshot.platformFamily,
      source: 'local-overlay', logicalExecutable: normalized,
      executableContentDigest: executableDigest,
      trustDocument: identity,
    });
  } catch (error) {
    if (isTrustError(error)) throw error;
    fail('FACTORY_TOOLCHAIN_UNAUTHORIZED');
  }
}

function validateToolAuthorization(authorization, logicalExecutable, executableDigest, platform) {
  try {
    if (!exactKeys(authorization, [
      'schemaVersion', 'platformFamily', 'source', 'logicalExecutable',
      'executableContentDigest', 'trustDocument', 'authorizationDigest',
    ]) || authorization.schemaVersion !== TOOLCHAIN_TRUST_VERSION
      || authorization.platformFamily !== platformFamily(platform)
      || !['process-anchor', 'local-overlay'].includes(authorization.source)
      || authorization.logicalExecutable !== normalizeLogicalExecutable(logicalExecutable)
      || authorization.executableContentDigest !== executableDigest
      || !SHA256.test(authorization.authorizationDigest || '')) return false;
    const copy = { ...authorization };
    delete copy.authorizationDigest;
    if (authorization.authorizationDigest !== hashValue(copy)) return false;
    if (authorization.source === 'process-anchor') {
      return RESERVED_ANCHORS.has(logicalExecutable)
        && logicalExecutable === authorization.logicalExecutable
        && authorization.trustDocument === null;
    }
    toolchainTrustPlanIdentity(authorization.trustDocument);
    return authorization.trustDocument.present === true;
  } catch {
    return false;
  }
}

function assertToolAuthorization(authorization, root, options = {}) {
  if (!validateToolAuthorization(
    authorization, options.logicalExecutable, options.executableDigest, options.platform,
  )) fail('FACTORY_TOOLCHAIN_TRUST_CHANGED');
  if (authorization.source === 'process-anchor') return true;
  try {
    const current = loadToolchainTrust(root, options);
    if (hashValue(toolchainTrustPlanIdentity(current))
      !== hashValue(authorization.trustDocument)) fail('FACTORY_TOOLCHAIN_TRUST_CHANGED');
    return true;
  } catch (error) {
    if (error?.code === 'FACTORY_TOOLCHAIN_TRUST_CHANGED') throw error;
    fail('FACTORY_TOOLCHAIN_TRUST_CHANGED');
  }
}

function enrollToolchainExecutable(input, options = {}) {
  try {
    if (!input || typeof input !== 'object' || Array.isArray(input)
      || !exactKeys(input, [
        'root', 'logicalExecutable', 'executablePath', 'confirmedSha256', 'expectedTrustDigest',
      ]) || typeof input.root !== 'string' || !input.root
      || typeof input.executablePath !== 'string' || !path.isAbsolute(input.executablePath)
      || !SHA256.test(input.confirmedSha256 || '')
      || !(input.expectedTrustDigest === null || SHA256.test(input.expectedTrustDigest || ''))) {
      fail('FACTORY_TOOLCHAIN_ENROLLMENT_INVALID');
    }
    const logicalExecutable = normalizeLogicalExecutable(input.logicalExecutable);
    if (logicalExecutable !== input.logicalExecutable || RESERVED_ANCHORS.has(logicalExecutable)) {
      fail('FACTORY_TOOLCHAIN_ENROLLMENT_INVALID');
    }
    if (options.fileSystem !== undefined && options.fileSystem !== fs) {
      fail('FACTORY_TOOLCHAIN_ENROLLMENT_INVALID');
    }
    const platform = options.platform || process.platform;
    const { inspectExecutableForEnrollment, isControlInterpreter } = require('./launcher');
    if (isControlInterpreter(logicalExecutable)) fail('FACTORY_TOOLCHAIN_ENROLLMENT_INVALID');
    const identity = inspectExecutableForEnrollment(input.executablePath, { platform });
    if (identity.contentDigest !== input.confirmedSha256) {
      fail('FACTORY_TOOLCHAIN_ENROLLMENT_INVALID');
    }
    const current = loadToolchainTrust(input.root, { platform });
    if (current.contentDigest !== input.expectedTrustDigest) {
      fail('FACTORY_TOOLCHAIN_ENROLLMENT_INVALID');
    }
    const entries = current.entries.map(entry => ({
      logicalExecutable: entry.logicalExecutable, sha256: [...entry.sha256],
    }));
    const existing = entries.find(entry => entry.logicalExecutable === logicalExecutable);
    if (existing) existing.sha256 = [...new Set([...existing.sha256, identity.contentDigest])].sort();
    else entries.push({ logicalExecutable, sha256: [identity.contentDigest] });
    entries.sort((left, right) => left.logicalExecutable.localeCompare(right.logicalExecutable));
    const document = validateToolchainTrust({
      schemaVersion: TOOLCHAIN_TRUST_VERSION,
      platformFamily: platformFamily(platform),
      entries,
    }, { platform });
    atomicWriteJson(input.root, TOOLCHAIN_TRUST_PATH, document);
    return loadToolchainTrust(input.root, { platform });
  } catch (error) {
    if (error?.code === 'FACTORY_TOOLCHAIN_ENROLLMENT_INVALID') throw error;
    fail('FACTORY_TOOLCHAIN_ENROLLMENT_INVALID');
  }
}

module.exports = {
  TOOLCHAIN_TRUST_PATH,
  TOOLCHAIN_TRUST_VERSION,
  assertToolAuthorization,
  authorizeExecutable,
  enrollToolchainExecutable,
  loadToolchainTrust,
  normalizeLogicalExecutable,
  platformFamily,
  toolchainTrustPlanIdentity,
  validateToolAuthorization,
  validateToolchainTrust,
};
