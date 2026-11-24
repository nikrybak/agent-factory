'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { hashValue } = require('./hash');

const FILESYSTEM_BOUNDARY_VERSION = '1.0.0';
const DEFAULT_MAX_BYTES = 4 * 1024 * 1024;
const ERROR_MESSAGES = Object.freeze({
  FACTORY_FILESYSTEM_PATH_UNSAFE: 'governed filesystem path is unsafe',
  FACTORY_FILESYSTEM_IDENTITY_CHANGED: 'governed filesystem identity changed',
  FACTORY_FILESYSTEM_CAPABILITY_UNAVAILABLE: 'governed filesystem capability is unavailable',
});
const FILESYSTEM_CAPABILITY = Object.freeze({
  schemaVersion: FILESYSTEM_BOUNDARY_VERSION,
  provider: 'node-opened-descriptor-static-fence',
  platformFamily: ['posix', 'win32'][Number(process.platform === 'win32')],
  openedDescriptorBytes: true,
  ancestorIdentityComparison: true,
  finalIdentityComparison: true,
  staticLinkRejection: true,
  descriptorRelativeResolution: false,
  descriptorRelativeMutation: false,
  samePrincipalAbaResistance: false,
});
const FILESYSTEM_CAPABILITY_DIGEST = hashValue(FILESYSTEM_CAPABILITY);

function boundaryError(code) {
  const error = new Error(ERROR_MESSAGES[code]);
  error.code = code;
  return error;
}

function fail(code) {
  throw boundaryError(code);
}

function ensureFileSystem(fileSystem) {
  try {
    for (const method of ['lstatSync', 'openSync', 'fstatSync', 'readSync', 'closeSync']) {
      if (!fileSystem || typeof fileSystem[method] !== 'function') {
        fail('FACTORY_FILESYSTEM_CAPABILITY_UNAVAILABLE');
      }
    }
  } catch {
    fail('FACTORY_FILESYSTEM_CAPABILITY_UNAVAILABLE');
  }
}

function normalizeOptions(options) {
  if (!options || typeof options !== 'object' || Array.isArray(options)) {
    fail('FACTORY_FILESYSTEM_PATH_UNSAFE');
  }
  try {
    return {
      fileSystem: options.fileSystem === undefined ? fs : options.fileSystem,
      maxBytes: options.maxBytes,
      fault: options.fault,
    };
  } catch {
    fail('FACTORY_FILESYSTEM_PATH_UNSAFE');
  }
}

function resolveBounded(root, relativePath) {
  if (typeof root !== 'string' || !root || typeof relativePath !== 'string'
    || !relativePath || relativePath.includes('\0') || path.isAbsolute(relativePath)) {
    fail('FACTORY_FILESYSTEM_PATH_UNSAFE');
  }
  const canonicalRoot = path.resolve(root);
  const target = path.resolve(canonicalRoot, relativePath);
  const relative = path.relative(canonicalRoot, target);
  if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`)) {
    fail('FACTORY_FILESYSTEM_PATH_UNSAFE');
  }
  return { canonicalRoot, target, relative };
}

function statType(stat) {
  try {
    if (stat.isSymbolicLink()) return 'link';
    if (stat.isDirectory()) return 'directory';
    if (stat.isFile()) return 'regular';
    return 'other';
  } catch {
    fail('FACTORY_FILESYSTEM_CAPABILITY_UNAVAILABLE');
  }
}

function usableIdentity(stat, withLinkCount) {
  const type = statType(stat);
  if (typeof stat.dev !== 'bigint' || stat.dev < 0n
    || typeof stat.ino !== 'bigint' || stat.ino <= 0n) {
    fail('FACTORY_FILESYSTEM_CAPABILITY_UNAVAILABLE');
  }
  const identity = { dev: stat.dev, ino: stat.ino, type };
  if (withLinkCount) {
    if (typeof stat.nlink !== 'bigint' || stat.nlink < 1n) {
      fail('FACTORY_FILESYSTEM_CAPABILITY_UNAVAILABLE');
    }
    identity.nlink = stat.nlink;
  }
  return Object.freeze(identity);
}

function lstat(fileSystem, absolutePath, changed) {
  try {
    return fileSystem.lstatSync(absolutePath, { bigint: true });
  } catch {
    fail(changed ? 'FACTORY_FILESYSTEM_IDENTITY_CHANGED' : 'FACTORY_FILESYSTEM_PATH_UNSAFE');
  }
}

function ancestorIdentity(fileSystem, absolutePath, changed) {
  const identity = usableIdentity(lstat(fileSystem, absolutePath, changed), false);
  if (identity.type !== 'directory') {
    fail(changed ? 'FACTORY_FILESYSTEM_IDENTITY_CHANGED' : 'FACTORY_FILESYSTEM_PATH_UNSAFE');
  }
  return identity;
}

function finalIdentityFromStat(stat, changed) {
  const identity = usableIdentity(stat, true);
  if (identity.type !== 'regular' || identity.nlink !== 1n) {
    fail(changed ? 'FACTORY_FILESYSTEM_IDENTITY_CHANGED' : 'FACTORY_FILESYSTEM_PATH_UNSAFE');
  }
  return identity;
}

function finalPathIdentity(fileSystem, absolutePath, changed) {
  return finalIdentityFromStat(lstat(fileSystem, absolutePath, changed), changed);
}

function capturePathIdentity(fileSystem, resolved, changed = false) {
  const parentParts = resolved.relative.split(path.sep).slice(0, -1);
  const ancestors = [ancestorIdentity(fileSystem, resolved.canonicalRoot, changed)];
  let cursor = resolved.canonicalRoot;
  for (const part of parentParts) {
    cursor = path.join(cursor, part);
    ancestors.push(ancestorIdentity(fileSystem, cursor, changed));
  }
  const frozenAncestors = Object.freeze(ancestors);
  return Object.freeze({
    root: frozenAncestors[0],
    ancestors: frozenAncestors,
    final: finalPathIdentity(fileSystem, resolved.target, changed),
  });
}

function tupleEqual(left, right, withLinkCount) {
  try {
    return left && right
      && left.dev === right.dev
      && left.ino === right.ino
      && left.type === right.type
      && (!withLinkCount || left.nlink === right.nlink);
  } catch {
    return false;
  }
}

function identityEqual(left, right) {
  try {
    if (!left || !right || !tupleEqual(left.root, right.root, false)
      || !Array.isArray(left.ancestors) || !Array.isArray(right.ancestors)
      || left.ancestors.length !== right.ancestors.length
      || !tupleEqual(left.final, right.final, true)) return false;
    return left.ancestors.every((item, index) => tupleEqual(item, right.ancestors[index], false));
  } catch {
    return false;
  }
}

function invokeFault(options, point) {
  if (typeof options.fault !== 'function') return;
  try {
    options.fault(point);
  } catch {
    fail('FACTORY_FILESYSTEM_IDENTITY_CHANGED');
  }
}

function readDescriptor(fileSystem, descriptor, maxBytes) {
  const storage = Buffer.alloc(maxBytes + 1);
  let offset = 0;
  try {
    while (offset < storage.length) {
      const count = fileSystem.readSync(descriptor, storage, offset, storage.length - offset, null);
      if (!Number.isSafeInteger(count) || count < 0 || count > storage.length - offset) {
        return fail('FACTORY_FILESYSTEM_CAPABILITY_UNAVAILABLE');
      }
      if (count === 0) break;
      offset += count;
    }
  } catch {
    fail('FACTORY_FILESYSTEM_CAPABILITY_UNAVAILABLE');
  }
  if (offset > maxBytes) fail('FACTORY_FILESYSTEM_PATH_UNSAFE');
  return storage.subarray(0, offset);
}

function openedIdentity(fileSystem, descriptor, changed = true) {
  let stat;
  try {
    stat = fileSystem.fstatSync(descriptor, { bigint: true });
  } catch {
    fail('FACTORY_FILESYSTEM_CAPABILITY_UNAVAILABLE');
  }
  return finalIdentityFromStat(stat, changed);
}

function recheckPath(fileSystem, resolved, expected) {
  const current = capturePathIdentity(fileSystem, resolved, true);
  if (!identityEqual(expected, current)) fail('FACTORY_FILESYSTEM_IDENTITY_CHANGED');
  return current;
}

function boundedMaxBytes(value) {
  const maxBytes = value === undefined ? DEFAULT_MAX_BYTES : value;
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > DEFAULT_MAX_BYTES) {
    fail('FACTORY_FILESYSTEM_PATH_UNSAFE');
  }
  return maxBytes;
}

function readOpenedFile(root, relativePath, options = {}) {
  const settings = normalizeOptions(options);
  const fileSystem = settings.fileSystem;
  ensureFileSystem(fileSystem);
  const maxBytes = boundedMaxBytes(settings.maxBytes);
  const resolved = resolveBounded(root, relativePath);
  const before = capturePathIdentity(fileSystem, resolved);
  invokeFault(settings, 'after-ancestor-capture');

  let descriptor;
  try {
    try {
      descriptor = fileSystem.openSync(resolved.target, 'r');
    } catch {
      fail('FACTORY_FILESYSTEM_IDENTITY_CHANGED');
    }
    invokeFault(settings, 'after-open');
    const opened = openedIdentity(fileSystem, descriptor);
    if (!tupleEqual(before.final, opened, true)) fail('FACTORY_FILESYSTEM_IDENTITY_CHANGED');
    recheckPath(fileSystem, resolved, before);
    const buffer = readDescriptor(fileSystem, descriptor, maxBytes);
    invokeFault(settings, 'after-read');
    const openedAfterRead = openedIdentity(fileSystem, descriptor);
    if (!tupleEqual(opened, openedAfterRead, true)) fail('FACTORY_FILESYSTEM_IDENTITY_CHANGED');
    const identity = recheckPath(fileSystem, resolved, before);
    const contentDigest = crypto.createHash('sha256').update(buffer).digest('hex');
    return Object.freeze({ buffer, contentDigest, identity });
  } finally {
    if (descriptor !== undefined) {
      try {
        fileSystem.closeSync(descriptor);
      } catch {
        fail('FACTORY_FILESYSTEM_CAPABILITY_UNAVAILABLE');
      }
    }
  }
}

function assertPathIdentity(root, relativePath, expectedIdentity, options = {}) {
  const settings = normalizeOptions(options);
  const fileSystem = settings.fileSystem;
  ensureFileSystem(fileSystem);
  const resolved = resolveBounded(root, relativePath);
  const current = capturePathIdentity(fileSystem, resolved, true);
  if (!identityEqual(expectedIdentity, current)) fail('FACTORY_FILESYSTEM_IDENTITY_CHANGED');
  invokeFault(settings, 'after-ancestor-capture');
  recheckPath(fileSystem, resolved, current);
  return true;
}

module.exports = {
  FILESYSTEM_BOUNDARY_VERSION,
  FILESYSTEM_CAPABILITY,
  FILESYSTEM_CAPABILITY_DIGEST,
  assertPathIdentity,
  readOpenedFile,
};
