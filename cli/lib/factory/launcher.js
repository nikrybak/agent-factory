'use strict';
/** @implements REQ-FK-010 Pre/post-spawn physical launch identity enforcement. */

const fs = require('node:fs');
const crypto = require('node:crypto');
const path = require('node:path');
const { readOpenedFile } = require('./filesystem-boundary');
const { hashValue } = require('./hash');
const {
  assertToolAuthorization, authorizeExecutable, loadToolchainTrust, platformFamily,
  validateToolAuthorization,
} = require('./toolchain-trust');

const LAUNCH_BINDING_VERSION = '1.0.0';
const NODE_CLI = Object.freeze({
  npm: 'node_modules/npm/bin/npm-cli.js',
  npx: 'node_modules/npm/bin/npx-cli.js',
});

/**
 * npm ships beside node.exe on Windows (`<dir>/node_modules/npm`) and under the install prefix on
 * POSIX (`<prefix>/bin/node`, `<prefix>/lib/node_modules/npm`); both are fixed, runtime-relative.
 */
function nodeCliRuntimeRoot(platform, executablePath) {
  const binDirectory = path.dirname(executablePath);
  return platform === 'win32' ? binDirectory : path.dirname(binDirectory);
}

function nodeCliRelativePath(platform, logicalExecutable) {
  const relativePath = NODE_CLI[logicalExecutable];
  return platform === 'win32' ? relativePath : `lib/${relativePath}`;
}
const ERROR_MESSAGES = Object.freeze({
  FACTORY_LAUNCH_BINDING_INVALID: 'governed launch binding is invalid',
  FACTORY_LAUNCH_IDENTITY_CHANGED: 'governed launch identity changed',
  FACTORY_LAUNCH_CAPABILITY_UNAVAILABLE: 'governed launch capability is unavailable',
});
const WINDOWS_BINARY_EXTENSIONS = Object.freeze(['.exe', '.com']);
const WINDOWS_SCRIPT_EXTENSIONS = new Set(['.cmd', '.bat', '.ps1']);
const CONTROL_INTERPRETERS = new Set([
  'ash', 'bash', 'busybox', 'cmd', 'command', 'cscript', 'csh', 'dash', 'doas',
  'elvish', 'env', 'fish', 'ksh', 'mshta', 'nu', 'powershell', 'pwsh', 'sh',
  'su', 'sudo', 'tcsh', 'wscript', 'xonsh', 'zsh',
]);
const ELF_PLATFORMS = new Set(['linux', 'freebsd', 'openbsd', 'netbsd']);
const MACHO_THIN_MAGICS = new Set(['feedface', 'cefaedfe', 'feedfacf', 'cffaedfe']);

function launchError(code) {
  const error = new Error(ERROR_MESSAGES[code]);
  error.code = code;
  return error;
}

function fail(code) {
  throw launchError(code);
}

function isLaunchError(error) {
  return error instanceof Error
    && Object.hasOwn(ERROR_MESSAGES, error.code)
    && error.message === ERROR_MESSAGES[error.code];
}

function validArgv(argv) {
  return Array.isArray(argv) && argv.length > 0
    && typeof argv[0] === 'string' && argv[0].length > 0
    && argv.every(value => typeof value === 'string' && !value.includes('\0'));
}

function serializeStat(stat) {
  try {
    if (!stat.isFile() || stat.isSymbolicLink() || typeof stat.dev !== 'bigint'
      || typeof stat.ino !== 'bigint' || stat.ino <= 0n || typeof stat.nlink !== 'bigint'
      || stat.nlink !== 1n || typeof stat.size !== 'bigint' || stat.size < 1n) {
      fail('FACTORY_LAUNCH_CAPABILITY_UNAVAILABLE');
    }
    return Object.freeze({
      dev: stat.dev.toString(10),
      ino: stat.ino.toString(10),
      nlink: stat.nlink.toString(10),
      size: stat.size.toString(10),
    });
  } catch (error) {
    if (isLaunchError(error)) throw error;
    fail('FACTORY_LAUNCH_CAPABILITY_UNAVAILABLE');
  }
}

function sameIdentity(left, right) {
  return left.dev === right.dev && left.ino === right.ino
    && left.nlink === right.nlink && left.size === right.size;
}

function isAbsolutePath(value) {
  return typeof value === 'string' && path.isAbsolute(value);
}

function isSha256(value) {
  return typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
}

function executableBasename(value) {
  if (typeof value !== 'string') return '';
  const basename = value.replaceAll('\\', '/').split('/').at(-1).toLowerCase();
  return basename.replace(/\.(?:exe|com)$/i, '');
}

function isControlInterpreter(value) {
  return CONTROL_INTERPRETERS.has(executableBasename(value));
}

function isNativeMagic(header, platform) {
  const magic = header.toString('hex');
  if (ELF_PLATFORMS.has(platform)) return magic === '7f454c46';
  if (platform === 'darwin') return MACHO_THIN_MAGICS.has(magic);
  return false;
}

function isExecutableIdentity(value) {
  return value && typeof value === 'object'
    && isAbsolutePath(value.canonicalPath)
    && ['dev', 'ino', 'nlink', 'size'].every(field => /^[0-9]+$/.test(value[field] || ''))
    && value.nlink === '1' && value.size !== '0' && isSha256(value.contentDigest);
}

function openedExecutableIdentity(execPath, fileSystem, options = {}) {
  if (typeof execPath !== 'string' || !path.isAbsolute(execPath) || execPath.includes('\0')) {
    fail('FACTORY_LAUNCH_CAPABILITY_UNAVAILABLE');
  }
  let canonicalPath;
  let descriptor;
  let result;
  let failure;
  try {
    canonicalPath = fileSystem.realpathSync.native(path.resolve(execPath));
    const before = serializeStat(fileSystem.lstatSync(canonicalPath, { bigint: true }));
    descriptor = fileSystem.openSync(canonicalPath, 'r');
    const opened = serializeStat(fileSystem.fstatSync(descriptor, { bigint: true }));
    const digest = crypto.createHash('sha256');
    const storage = Buffer.allocUnsafe(64 * 1024);
    const header = Buffer.alloc(4);
    let headerLength = 0;
    while (true) {
      const count = fileSystem.readSync(descriptor, storage, 0, storage.length, null);
      if (!Number.isSafeInteger(count) || count < 0 || count > storage.length) {
        fail('FACTORY_LAUNCH_CAPABILITY_UNAVAILABLE');
      }
      if (count === 0) break;
      if (headerLength < header.length) {
        headerLength += storage.copy(header, headerLength, 0, Math.min(count, header.length - headerLength));
      }
      digest.update(storage.subarray(0, count));
    }
    if (options.nativePlatform
      && (headerLength < header.length || !isNativeMagic(header, options.nativePlatform))) {
      fail('FACTORY_LAUNCH_CAPABILITY_UNAVAILABLE');
    }
    const openedAfterRead = serializeStat(fileSystem.fstatSync(descriptor, { bigint: true }));
    const after = serializeStat(fileSystem.lstatSync(canonicalPath, { bigint: true }));
    if (!sameIdentity(before, opened) || !sameIdentity(opened, openedAfterRead)
      || !sameIdentity(openedAfterRead, after)) {
      fail('FACTORY_LAUNCH_IDENTITY_CHANGED');
    }
    result = Object.freeze({ canonicalPath, ...opened, contentDigest: digest.digest('hex') });
  } catch (error) {
    failure = error;
  }
  if (descriptor !== undefined) {
    try {
      fileSystem.closeSync(descriptor);
    } catch {
      fail('FACTORY_LAUNCH_CAPABILITY_UNAVAILABLE');
    }
  }
  if (failure !== undefined) {
    if (isLaunchError(failure)) throw failure;
    fail('FACTORY_LAUNCH_CAPABILITY_UNAVAILABLE');
  }
  return result;
}

function serializeOpenedIdentity(identity) {
  return Object.freeze({
    root: `${identity.root.dev}:${identity.root.ino}:${identity.root.type}`,
    ancestors: Object.freeze(identity.ancestors.map(item => `${item.dev}:${item.ino}:${item.type}`)),
    final: `${identity.final.dev}:${identity.final.ino}:${identity.final.type}:${identity.final.nlink}`,
  });
}

function withoutDigest(binding) {
  const copy = { ...binding };
  delete copy.launchDigest;
  return copy;
}

function seal(fields) {
  const binding = {
    schemaVersion: LAUNCH_BINDING_VERSION,
    ...fields,
    prefix: Object.freeze([...fields.prefix]),
  };
  binding.launchDigest = hashValue(binding);
  return Object.freeze(binding);
}

function executableExists(fileSystem, candidate) {
  try {
    fileSystem.lstatSync(candidate, { bigint: true });
    return true;
  } catch (error) {
    if (error && ['ENOENT', 'ENOTDIR'].includes(error.code)) return false;
    fail('FACTORY_LAUNCH_CAPABILITY_UNAVAILABLE');
  }
}

function assertPosixExecutable(fileSystem, candidate) {
  try {
    fileSystem.accessSync(candidate, fs.constants.X_OK);
  } catch {
    fail('FACTORY_LAUNCH_CAPABILITY_UNAVAILABLE');
  }
}

function windowsCandidates(logicalExecutable, env) {
  const extension = path.win32.extname(logicalExecutable).toLowerCase();
  if (WINDOWS_SCRIPT_EXTENSIONS.has(extension)) fail('FACTORY_LAUNCH_CAPABILITY_UNAVAILABLE');
  if (extension && !WINDOWS_BINARY_EXTENSIONS.includes(extension)) {
    fail('FACTORY_LAUNCH_CAPABILITY_UNAVAILABLE');
  }
  const requestedExtensions = extension ? [''] : String(env.PATHEXT || env.Pathext || '.EXE;.COM')
    .split(';').map(value => value.trim().toLowerCase())
    .filter(value => WINDOWS_BINARY_EXTENSIONS.includes(value));
  const extensions = [...new Set(requestedExtensions)];
  if (!extensions.length) fail('FACTORY_LAUNCH_CAPABILITY_UNAVAILABLE');
  return extensions;
}

function isWindowsBinaryPath(value) {
  return typeof value === 'string'
    && WINDOWS_BINARY_EXTENSIONS.includes(path.win32.extname(value).toLowerCase());
}

function pathEntries(platform, env) {
  const value = platform === 'win32' ? (env.Path || env.PATH) : env.PATH;
  if (typeof value !== 'string' || !value) fail('FACTORY_LAUNCH_CAPABILITY_UNAVAILABLE');
  const delimiter = platform === 'win32' ? ';' : ':';
  return value.split(delimiter).map(entry => entry.trim().replace(/^"|"$/g, '')).filter(Boolean);
}

/**
 * The Node process anchor is never reached through a symbolic link: Node reports the physical
 * executable as `process.execPath`, so a linked anchor is a substitution, not an install layout.
 * Lookup failures are left to the opened identity checks.
 */
function assertUnlinkedAnchor(fileSystem, execPath) {
  let linked = false;
  try {
    linked = fileSystem.lstatSync(path.resolve(execPath)).isSymbolicLink() === true;
  } catch {
    linked = false;
  }
  if (linked) fail('FACTORY_LAUNCH_CAPABILITY_UNAVAILABLE');
}

function resolveExecutable(logicalExecutable, options, platform, fileSystem) {
  const env = options.env || process.env;
  const cwd = path.resolve(options.cwd || process.cwd());
  const explicit = path.isAbsolute(logicalExecutable)
    || logicalExecutable.includes('/') || logicalExecutable.includes('\\');
  let candidates;
  if (logicalExecutable === 'node') {
    if (platform === 'win32' && !isWindowsBinaryPath(options.execPath || process.execPath)) {
      fail('FACTORY_LAUNCH_CAPABILITY_UNAVAILABLE');
    }
    assertUnlinkedAnchor(fileSystem, options.execPath || process.execPath);
    candidates = [options.execPath || process.execPath];
  } else if (platform === 'win32') {
    const extensions = windowsCandidates(logicalExecutable, env);
    if (explicit) {
      const absolute = path.resolve(cwd, logicalExecutable);
      candidates = extensions.map(extension => `${absolute}${extension}`);
    } else {
      candidates = pathEntries(platform, env).flatMap(entry => extensions.map(
        extension => path.win32.join(entry, `${logicalExecutable}${extension}`),
      ));
    }
  } else if (explicit) {
    candidates = [path.resolve(cwd, logicalExecutable)];
  } else {
    candidates = pathEntries(platform, env).map(entry => path.resolve(cwd, entry, logicalExecutable));
  }
  for (const candidate of candidates) {
    if (!executableExists(fileSystem, candidate)) continue;
    if (platform !== 'win32') assertPosixExecutable(fileSystem, candidate);
    const identity = openedExecutableIdentity(candidate, fileSystem, {
      nativePlatform: platform === 'win32' ? null : platform,
    });
    if (isControlInterpreter(identity.canonicalPath)) fail('FACTORY_LAUNCH_CAPABILITY_UNAVAILABLE');
    return identity;
  }
  fail('FACTORY_LAUNCH_CAPABILITY_UNAVAILABLE');
}

function inspectExecutableForEnrollment(executablePath, options = {}) {
  const platform = options.platform || process.platform;
  const fileSystem = options.fileSystem || fs;
  if (typeof executablePath !== 'string' || !path.isAbsolute(executablePath)
    || executablePath.includes('\0') || isControlInterpreter(executablePath)) {
    fail('FACTORY_LAUNCH_CAPABILITY_UNAVAILABLE');
  }
  if (platform === 'win32' && !isWindowsBinaryPath(executablePath)) {
    fail('FACTORY_LAUNCH_CAPABILITY_UNAVAILABLE');
  }
  if (platform !== 'win32') assertPosixExecutable(fileSystem, executablePath);
  return openedExecutableIdentity(executablePath, fileSystem, {
    nativePlatform: platform === 'win32' ? null : platform,
  });
}

function trustSnapshot(options, platform, fileSystem) {
  if (options.toolchainTrust) return options.toolchainTrust;
  if (typeof options.projectRoot !== 'string' || !options.projectRoot) {
    const error = new Error('governed executable is not authorized');
    error.code = 'FACTORY_TOOLCHAIN_UNAUTHORIZED';
    throw error;
  }
  return loadToolchainTrust(options.projectRoot, { platform, fileSystem });
}

function createLaunchBinding(argv, options = {}) {
  if (!validArgv(argv)) fail('FACTORY_LAUNCH_BINDING_INVALID');
  const platform = options.platform || process.platform;
  if (isControlInterpreter(argv[0])) fail('FACTORY_LAUNCH_CAPABILITY_UNAVAILABLE');
  const fileSystem = options.fileSystem || fs;
  if (!Object.hasOwn(NODE_CLI, argv[0])) {
    const executableIdentity = resolveExecutable(argv[0], options, platform, fileSystem);
    const anchor = argv[0] === 'node';
    const toolAuthorization = authorizeExecutable({
      logicalExecutable: argv[0],
      executableDigest: executableIdentity.contentDigest,
      snapshot: anchor ? { platformFamily: platformFamily(platform) }
        : trustSnapshot(options, platform, fileSystem),
      anchor,
    });
    return seal({
      kind: 'resolved-executable', logicalExecutable: argv[0], platform,
      prefix: [executableIdentity.canonicalPath], executableIdentity, toolAuthorization,
    });
  }
  const execPath = options.execPath || process.execPath;
  if (platform === 'win32' && !isWindowsBinaryPath(execPath)) {
    fail('FACTORY_LAUNCH_CAPABILITY_UNAVAILABLE');
  }
  assertUnlinkedAnchor(fileSystem, execPath);
  const cliRelativePath = nodeCliRelativePath(platform, argv[0]);
  const executableIdentity = openedExecutableIdentity(execPath, fileSystem, {
    nativePlatform: platform === 'win32' ? null : platform,
  });
  const runtimeRoot = nodeCliRuntimeRoot(platform, executableIdentity.canonicalPath);
  const openedCli = readOpenedFile(runtimeRoot, cliRelativePath, { fileSystem, maxBytes: 1024 * 1024 });
  const cliPath = path.resolve(runtimeRoot, cliRelativePath);
  const toolAuthorization = authorizeExecutable({
    logicalExecutable: argv[0],
    executableDigest: executableIdentity.contentDigest,
    snapshot: { platformFamily: platformFamily(platform) },
    anchor: true,
  });
  return seal({
    kind: 'node-cli',
    logicalExecutable: argv[0],
    platform,
    prefix: [executableIdentity.canonicalPath, cliPath],
    executableIdentity,
    toolAuthorization,
    cliIdentity: {
      relativePath: cliRelativePath,
      contentDigest: openedCli.contentDigest,
      openedPathIdentity: serializeOpenedIdentity(openedCli.identity),
    },
  });
}

function validateLaunchBinding(binding, argv) {
  const issues = [];
  try {
    if (!binding || typeof binding !== 'object' || Array.isArray(binding)) {
      return ['launch binding is required'];
    }
    if (binding.schemaVersion !== LAUNCH_BINDING_VERSION) issues.push('launch binding version mismatch');
    if (!['resolved-executable', 'node-cli'].includes(binding.kind)) issues.push('launch binding kind is invalid');
    if (typeof binding.platform !== 'string' || !binding.platform) issues.push('launch platform is invalid');
    if (!validArgv(argv) || binding.logicalExecutable !== argv?.[0]) issues.push('launch logical executable mismatch');
    if (!Array.isArray(binding.prefix) || !binding.prefix.length
      || binding.prefix.some(value => typeof value !== 'string' || !value || value.includes('\0'))) {
      issues.push('launch prefix is invalid');
    }
    if (binding.kind === 'resolved-executable') {
      if (binding.prefix?.length !== 1 || !isAbsolutePath(binding.prefix?.[0])) {
        issues.push('resolved executable launch prefix is invalid');
      }
      if (!isExecutableIdentity(binding.executableIdentity)
        || binding.executableIdentity?.canonicalPath !== binding.prefix?.[0]) {
        issues.push('resolved executable identity is invalid');
      }
      if (binding.platform === 'win32' && (!isWindowsBinaryPath(binding.prefix?.[0])
        || WINDOWS_SCRIPT_EXTENSIONS.has(path.win32.extname(binding.logicalExecutable).toLowerCase()))) {
        issues.push('resolved Windows executable form is invalid');
      }
      if (isControlInterpreter(binding.logicalExecutable) || isControlInterpreter(binding.prefix?.[0])) {
        issues.push('control interpreter launch is invalid');
      }
      if (binding.cliIdentity !== undefined) issues.push('resolved executable CLI identity is invalid');
    }
    if (binding.kind === 'node-cli') {
      if (!Object.hasOwn(NODE_CLI, binding.logicalExecutable)) {
        issues.push('node CLI launch identity is invalid');
      }
      if (binding.platform === 'win32' && !isWindowsBinaryPath(binding.prefix?.[0])) {
        issues.push('node executable form is invalid');
      }
      if (binding.prefix?.length !== 2 || !isAbsolutePath(binding.prefix?.[0])
        || !isAbsolutePath(binding.prefix?.[1])) issues.push('node CLI launch prefix is invalid');
      if (!isExecutableIdentity(binding.executableIdentity)
        || binding.executableIdentity.canonicalPath !== binding.prefix?.[0]) {
        issues.push('node executable identity is invalid');
      }
      if (!isSha256(binding.executableIdentity?.contentDigest)) {
        issues.push('node executable content digest is invalid');
      }
      if (!binding.cliIdentity
        || binding.cliIdentity.relativePath !== nodeCliRelativePath(binding.platform, binding.logicalExecutable)
        || !isSha256(binding.cliIdentity.contentDigest)) {
        issues.push('node CLI opened-byte identity is invalid');
      }
    }
    if (!validateToolAuthorization(
      binding.toolAuthorization, binding.logicalExecutable,
      binding.executableIdentity?.contentDigest, binding.platform,
    )) issues.push('tool authorization is invalid');
    if (binding.launchDigest !== hashValue(withoutDigest(binding))) issues.push('launch digest mismatch');
  } catch {
    return ['launch binding is invalid'];
  }
  return issues;
}

function resolveLaunch(argv, binding, options = {}) {
  if (validateLaunchBinding(binding, argv).length) fail('FACTORY_LAUNCH_BINDING_INVALID');
  const platform = options.platform || process.platform;
  if (binding.platform !== platform) fail('FACTORY_LAUNCH_IDENTITY_CHANGED');
  const fileSystem = options.fileSystem || fs;
  let executableIdentity;
  try {
    executableIdentity = openedExecutableIdentity(binding.prefix[0], fileSystem, {
      nativePlatform: binding.platform === 'win32' ? null : binding.platform,
    });
  } catch {
    fail('FACTORY_LAUNCH_IDENTITY_CHANGED');
  }
  if (hashValue(executableIdentity) !== hashValue(binding.executableIdentity)) {
    fail('FACTORY_LAUNCH_IDENTITY_CHANGED');
  }
  if (binding.toolAuthorization.source === 'process-anchor') {
    let anchorIdentity;
    try {
      anchorIdentity = openedExecutableIdentity(options.execPath || process.execPath, fileSystem, {
        nativePlatform: binding.platform === 'win32' ? null : binding.platform,
      });
    } catch {
      fail('FACTORY_LAUNCH_IDENTITY_CHANGED');
    }
    if (hashValue(anchorIdentity) !== hashValue(binding.executableIdentity)) {
      fail('FACTORY_LAUNCH_IDENTITY_CHANGED');
    }
  }
  assertToolAuthorization(binding.toolAuthorization, options.projectRoot, {
    platform: binding.platform,
    fileSystem,
    logicalExecutable: binding.logicalExecutable,
    executableDigest: executableIdentity.contentDigest,
  });
  if (binding.kind === 'node-cli') {
    try {
      const runtimeRoot = nodeCliRuntimeRoot(binding.platform, binding.prefix[0]);
      const openedCli = readOpenedFile(runtimeRoot, binding.cliIdentity.relativePath, {
        fileSystem, maxBytes: 1024 * 1024,
      });
      const expectedCliPath = path.resolve(runtimeRoot, binding.cliIdentity.relativePath);
      if (binding.prefix[1] !== expectedCliPath
        || openedCli.contentDigest !== binding.cliIdentity.contentDigest
        || hashValue(serializeOpenedIdentity(openedCli.identity))
          !== hashValue(binding.cliIdentity.openedPathIdentity)) {
        fail('FACTORY_LAUNCH_IDENTITY_CHANGED');
      }
    } catch {
      fail('FACTORY_LAUNCH_IDENTITY_CHANGED');
    }
  }
  return [...binding.prefix, ...argv.slice(1)];
}

module.exports = {
  LAUNCH_BINDING_VERSION,
  createLaunchBinding,
  inspectExecutableForEnrollment,
  isControlInterpreter,
  resolveLaunch,
  validateLaunchBinding,
};
