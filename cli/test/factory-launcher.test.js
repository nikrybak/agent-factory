'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const crypto = require('node:crypto');
const os = require('node:os');
const path = require('node:path');

const {
  LAUNCH_BINDING_VERSION, createLaunchBinding, resolveLaunch, validateLaunchBinding,
} = require('../lib/factory/launcher');
const { loadToolchainTrust, normalizeLogicalExecutable } = require('../lib/factory/toolchain-trust');

function trustOptions(root, logicalExecutable, executablePath, platform) {
  const digest = crypto.createHash('sha256').update(fs.readFileSync(executablePath)).digest('hex');
  const logical = normalizeLogicalExecutable(logicalExecutable);
  fs.mkdirSync(path.join(root, '.factory'), { recursive: true });
  fs.writeFileSync(path.join(root, '.factory', 'toolchain-trust.json'), JSON.stringify({
    schemaVersion: '1.0.0',
    platformFamily: platform === 'win32' ? 'win32' : 'posix',
    entries: [{ logicalExecutable: logical, sha256: [digest] }],
  }));
  return { projectRoot: root, toolchainTrust: loadToolchainTrust(root, { platform }) };
}

function runtimeFixture(layout = 'win32') {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'factory-launcher-'));
  // Windows: npm beside node.exe; POSIX: <prefix>/bin/node and <prefix>/lib/node_modules/npm.
  const posix = layout === 'posix';
  if (posix) fs.mkdirSync(path.join(root, 'bin'));
  const execPath = posix ? path.join(root, 'bin', 'node') : path.join(root, 'node.exe');
  fs.writeFileSync(execPath, 'node-runtime');
  const bin = path.join(root, ...(posix ? ['lib'] : []), 'node_modules', 'npm', 'bin');
  fs.mkdirSync(bin, { recursive: true });
  fs.writeFileSync(path.join(bin, 'npm-cli.js'), 'npm-cli');
  fs.writeFileSync(path.join(bin, 'npx-cli.js'), 'npx-cli');
  return { root, execPath };
}

function fileSystemProxy(overrides = {}) {
  return new Proxy(fs, {
    get(target, property) {
      return Object.hasOwn(overrides, property) ? overrides[property] : target[property];
    },
  });
}

test('resolved launch bindings are versioned, immutable, deterministic, and preserve argv', () => {
  const argv = ['node', '-e', ''];
  const first = createLaunchBinding(argv);
  const second = createLaunchBinding(argv);
  assert.deepEqual(first, second);
  assert.equal(first.schemaVersion, LAUNCH_BINDING_VERSION);
  assert.equal(first.kind, 'resolved-executable');
  assert.equal(first.platform, process.platform);
  assert.deepEqual(first.prefix, [process.execPath]);
  assert.match(first.executableIdentity.contentDigest, /^[a-f0-9]{64}$/);
  assert.equal(Object.isFrozen(first), true);
  assert.equal(Object.isFrozen(first.prefix), true);
  assert.deepEqual(validateLaunchBinding(first, argv), []);
  assert.deepEqual(resolveLaunch(argv, first), [process.execPath, ...argv.slice(1)]);
  const otherPlatform = process.platform === 'win32' ? 'linux' : 'win32';
  assert.throws(
    () => resolveLaunch(argv, first, { platform: otherPlatform }),
    error => error.code === 'FACTORY_LAUNCH_IDENTITY_CHANGED',
  );
});

test('default platform resolves node to the exact current process executable', () => {
  const binding = createLaunchBinding(['node', '--version']);
  assert.equal(binding.kind, 'resolved-executable');
  assert.equal(binding.platform, process.platform);
  assert.equal(binding.prefix[0], process.execPath);
  assert.deepEqual(resolveLaunch(['node', '--version'], binding), [process.execPath, '--version']);
});

test('default win32 npm binding uses the current process executable and ignores PATH', t => {
  if (process.platform !== 'win32') { t.skip('win32 only'); return; }
  const originalPath = process.env.PATH;
  process.env.PATH = 'C:\\untrusted-path';
  try {
    const binding = createLaunchBinding(['npm', '--version']);
    assert.equal(binding.prefix[0], process.execPath);
    assert.notEqual(binding.prefix[0], 'npm');
  } finally {
    process.env.PATH = originalPath;
  }
});

test('win32 npm and npx bind only to the fixed process runtime siblings', () => {
  const { root, execPath } = runtimeFixture();
  for (const logicalExecutable of ['npm', 'npx']) {
    const argv = [logicalExecutable, 'run', 'test', '--', ''];
    const binding = createLaunchBinding(argv, { platform: 'win32', execPath });
    assert.equal(binding.kind, 'node-cli');
    assert.equal(binding.platform, 'win32');
    assert.equal(binding.prefix[0], execPath);
    assert.equal(
      binding.prefix[1],
      path.join(root, 'node_modules', 'npm', 'bin', `${logicalExecutable}-cli.js`),
    );
    assert.match(binding.cliIdentity.contentDigest, /^[a-f0-9]{64}$/);
    assert.match(binding.executableIdentity.contentDigest, /^[a-f0-9]{64}$/);
    assert.deepEqual(validateLaunchBinding(binding, argv), []);
    assert.deepEqual(
      resolveLaunch(argv, binding, { platform: 'win32', execPath }),
      [...binding.prefix, ...argv.slice(1)],
    );
  }
});

test('POSIX npm binds to the sealed Node executable and fixed CLI bytes without a shebang hop', () => {
  const { root, execPath } = runtimeFixture('posix');
  fs.writeFileSync(execPath, Buffer.from([0x7f, 0x45, 0x4c, 0x46, 1]));
  const argv = ['npm', 'test'];
  const binding = createLaunchBinding(argv, { platform: 'linux', execPath });
  assert.equal(binding.kind, 'node-cli');
  assert.equal(binding.platform, 'linux');
  assert.equal(binding.cliIdentity.relativePath, 'lib/node_modules/npm/bin/npm-cli.js');
  assert.equal(binding.prefix[1], path.join(root, 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js'));
  assert.deepEqual(validateLaunchBinding(binding, argv), []);
  // The Windows sibling layout is not accepted for a POSIX runtime.
  const siblingLayout = runtimeFixture();
  fs.writeFileSync(siblingLayout.execPath, Buffer.from([0x7f, 0x45, 0x4c, 0x46, 1]));
  assert.throws(
    () => createLaunchBinding(argv, { platform: 'linux', execPath: siblingLayout.execPath }),
    error => error.code === 'FACTORY_FILESYSTEM_PATH_UNSAFE' && !error.message.includes(siblingLayout.root),
  );
  assert.deepEqual(
    resolveLaunch(argv, binding, { platform: 'linux', execPath }),
    [...binding.prefix, 'test'],
  );
});

test('win32 rejects script wrappers and does not treat npm lookalikes as npm', () => {
  for (const executable of ['npm.cmd', 'tool.bat', 'unsafe.ps1']) {
    assert.throws(
      () => createLaunchBinding([executable], { platform: 'win32' }),
      error => error.code === 'FACTORY_LAUNCH_CAPABILITY_UNAVAILABLE',
    );
  }
  for (const executable of ['NPM', 'xnpm']) {
    assert.throws(
      () => createLaunchBinding([executable], { platform: 'win32', env: { Path: 'C:\\missing' } }),
      error => error.code === 'FACTORY_LAUNCH_CAPABILITY_UNAVAILABLE',
    );
  }
});

test('shell and control interpreters are rejected cross-platform before resolution', () => {
  for (const platform of ['win32', 'linux']) {
    for (const executable of [
      'cmd.exe', 'powershell.exe', 'pwsh', '/bin/sh', '/usr/bin/bash', 'dash', 'zsh',
      'fish', 'ksh', 'busybox', '/usr/bin/env', 'sudo',
    ]) {
      assert.throws(
        () => createLaunchBinding([executable, '-c', 'unsafe'], { platform }),
        error => error.code === 'FACTORY_LAUNCH_CAPABILITY_UNAVAILABLE',
      );
    }
  }
});

/** A direct executable in the host's native form: a Windows .exe, or a POSIX ELF file with X_OK. */
function hostExecutable(directory, name, marker) {
  if (process.platform === 'win32') {
    const file = path.join(directory, `${name}.exe`);
    fs.writeFileSync(file, marker);
    return { platform: 'win32', file, env: entry => ({ Path: entry, PATHEXT: '.CMD;.EXE;.COM' }) };
  }
  const file = path.join(directory, name);
  fs.writeFileSync(file, Buffer.concat([Buffer.from([0x7f, 0x45, 0x4c, 0x46, 1]), Buffer.from(marker)]));
  fs.chmodSync(file, 0o755);
  return { platform: process.platform, file, env: entry => ({ PATH: entry }) };
}

test('sealed direct executable ignores plan and runtime PATH substitution', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'factory-launch-path-'));
  const good = path.join(root, 'good');
  const bad = path.join(root, 'bad');
  fs.mkdirSync(good); fs.mkdirSync(bad);
  const helper = hostExecutable(good, 'helper', 'good-binary');
  hostExecutable(bad, 'helper', 'evil-binary');
  const { platform } = helper;
  const argv = ['helper', 'value && echo unsafe'];
  const trusted = trustOptions(root, argv[0], helper.file, platform);
  const binding = createLaunchBinding(argv, { platform, env: helper.env(good), ...trusted });
  assert.equal(binding.kind, 'resolved-executable');
  assert.equal(binding.prefix[0], helper.file);
  assert.deepEqual(
    resolveLaunch(argv, binding, { platform, projectRoot: root, env: helper.env(bad) }),
    [helper.file, argv[1]],
  );
  if (platform === 'win32') {
    // Windows environment names are case-insensitive: PATH works where Path is absent.
    const pathFallback = createLaunchBinding(argv, {
      platform, env: { PATH: good, PATHEXT: '.EXE' }, ...trusted,
    });
    assert.equal(pathFallback.prefix[0], helper.file);
  }
});

test('direct executables require an enrolled digest and runtime overlay parity', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'factory-launch-authorization-'));
  const bin = path.join(root, 'bin');
  fs.mkdirSync(bin);
  const helper = hostExecutable(bin, 'helper', 'approved-binary');
  const lookup = { platform: helper.platform, env: helper.env(bin), projectRoot: root };
  assert.throws(
    () => createLaunchBinding(['helper'], lookup),
    error => error.code === 'FACTORY_TOOLCHAIN_UNAUTHORIZED' && !error.message.includes(root),
  );
  const trusted = trustOptions(root, 'helper', helper.file, helper.platform);
  const binding = createLaunchBinding(['helper'], { ...lookup, ...trusted });
  fs.appendFileSync(path.join(root, '.factory', 'toolchain-trust.json'), os.EOL);
  assert.throws(
    () => resolveLaunch(['helper'], binding, { platform: helper.platform, projectRoot: root }),
    error => error.code === 'FACTORY_TOOLCHAIN_TRUST_CHANGED' && !error.message.includes(root),
  );
});

test('absolute aliases canonicalize and Windows direct bindings accept only binary forms', () => {
  const { root } = runtimeFixture();
  const helper = path.join(root, 'helper.exe');
  fs.writeFileSync(helper, 'helper-binary');
  const alias = path.join(root, '.', 'helper.exe');
  const binding = createLaunchBinding([alias], {
    platform: 'win32', ...trustOptions(root, alias, helper, 'win32'),
  });
  assert.equal(binding.prefix[0], helper);
  assert.throws(
    () => createLaunchBinding([path.join(root, 'tool.txt')], { platform: 'win32' }),
    error => error.code === 'FACTORY_LAUNCH_CAPABILITY_UNAVAILABLE',
  );
  assert.throws(
    () => createLaunchBinding(['node'], { platform: 'win32', execPath: path.join(root, 'node.cmd') }),
    error => error.code === 'FACTORY_LAUNCH_CAPABILITY_UNAVAILABLE',
  );
  assert.throws(
    () => createLaunchBinding(['npm'], { platform: 'win32', execPath: path.join(root, 'node.cmd') }),
    error => error.code === 'FACTORY_LAUNCH_CAPABILITY_UNAVAILABLE',
  );
});

test('POSIX explicit and PATH executables resolve physically and require X_OK', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'factory-launch-posix-'));
  const executable = path.join(root, 'helper');
  fs.writeFileSync(executable, Buffer.from([0x7f, 0x45, 0x4c, 0x46, 1]));
  fs.chmodSync(executable, 0o755);
  const trusted = trustOptions(root, executable, executable, 'linux');
  const explicit = createLaunchBinding([executable], { platform: 'linux', ...trusted });
  assert.equal(explicit.prefix[0], executable);
  const fromPath = createLaunchBinding(['helper'], {
    platform: 'linux', cwd: root, env: { PATH: '.' }, ...trusted,
  });
  assert.equal(fromPath.prefix[0], executable);
  const denied = fileSystemProxy({ accessSync: () => { throw new Error('denied'); } });
  assert.throws(
    () => createLaunchBinding([executable], { platform: 'linux', fileSystem: denied }),
    error => error.code === 'FACTORY_LAUNCH_CAPABILITY_UNAVAILABLE',
  );
});

test('POSIX shebang executables fail closed instead of creating an unsealed interpreter chain', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'factory-launch-shebang-'));
  for (const [name, content] of [
    ['script-one', '#!/bin/sh\necho unsafe\n'],
    ['script-env', '#!/usr/bin/env node\nconsole.log("unsafe")\n'],
  ]) {
    const script = path.join(root, name);
    fs.writeFileSync(script, content);
    fs.chmodSync(script, 0o755);
    assert.throws(
      () => createLaunchBinding([script], { platform: 'linux' }),
      error => error.code === 'FACTORY_LAUNCH_CAPABILITY_UNAVAILABLE'
        && !error.message.includes(root),
    );
  }
  const plain = path.join(root, 'plain-text');
  fs.writeFileSync(plain, 'echo unsafe\n');
  fs.chmodSync(plain, 0o755);
  assert.throws(
    () => createLaunchBinding([plain], { platform: 'linux' }),
    error => error.code === 'FACTORY_LAUNCH_CAPABILITY_UNAVAILABLE',
  );
  const javaClass = path.join(root, 'java-class');
  fs.writeFileSync(javaClass, Buffer.from([0xca, 0xfe, 0xba, 0xbe, 0, 0, 0, 61]));
  fs.chmodSync(javaClass, 0o755);
  assert.throws(
    () => createLaunchBinding([javaClass], { platform: 'linux' }),
    error => error.code === 'FACTORY_LAUNCH_CAPABILITY_UNAVAILABLE',
  );
});

test('native magic is bound to the declared POSIX platform', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'factory-launch-native-platform-'));
  const macho = path.join(root, 'macho');
  fs.writeFileSync(macho, Buffer.from([0xfe, 0xed, 0xfa, 0xcf, 1]));
  fs.chmodSync(macho, 0o755);
  assert.equal(createLaunchBinding([macho], {
    platform: 'darwin', ...trustOptions(root, macho, macho, 'darwin'),
  }).prefix[0], macho);
  assert.throws(
    () => createLaunchBinding([macho], { platform: 'linux' }),
    error => error.code === 'FACTORY_LAUNCH_CAPABILITY_UNAVAILABLE',
  );
  const elf = path.join(root, 'elf');
  fs.writeFileSync(elf, Buffer.from([0x7f, 0x45, 0x4c, 0x46, 1]));
  fs.chmodSync(elf, 0o755);
  assert.throws(
    () => createLaunchBinding([elf], { platform: 'unknown-posix' }),
    error => error.code === 'FACTORY_LAUNCH_CAPABILITY_UNAVAILABLE',
  );
});

test('resolver rejects unexpected lookup failures and empty executable search policy', () => {
  const { execPath } = runtimeFixture();
  const denied = fileSystemProxy({
    lstatSync: () => { const error = new Error('denied'); error.code = 'EACCES'; throw error; },
  });
  assert.throws(
    () => createLaunchBinding(['node'], { platform: 'linux', execPath, fileSystem: denied }),
    error => error.code === 'FACTORY_LAUNCH_CAPABILITY_UNAVAILABLE',
  );
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'factory-launch-alias-shell-'));
  const helper = path.join(root, 'helper.exe');
  const shell = path.join(root, 'bash.exe');
  fs.writeFileSync(helper, 'alias');
  fs.writeFileSync(shell, 'shell-binary');
  const canonicalShell = () => {};
  canonicalShell.native = value => value === helper ? shell : fs.realpathSync.native(value);
  const aliasFileSystem = fileSystemProxy({ realpathSync: canonicalShell });
  assert.throws(
    () => createLaunchBinding(['helper'], {
      platform: 'win32', env: { Path: root, PATHEXT: '.EXE' }, fileSystem: aliasFileSystem,
    }),
    error => error.code === 'FACTORY_LAUNCH_CAPABILITY_UNAVAILABLE',
  );
  assert.throws(
    () => createLaunchBinding(['missing'], { platform: 'win32', env: { Path: 'C:\\none', PATHEXT: '.CMD' } }),
    error => error.code === 'FACTORY_LAUNCH_CAPABILITY_UNAVAILABLE',
  );
  assert.throws(
    () => createLaunchBinding(['missing'], { platform: 'linux', env: { PATH: '' } }),
    error => error.code === 'FACTORY_LAUNCH_CAPABILITY_UNAVAILABLE',
  );
});

test('missing or tampered sealed direct executable fails with path-free identity errors', () => {
  const { root } = runtimeFixture();
  const execPath = path.join(root, 'helper.exe');
  fs.writeFileSync(execPath, 'node-runtime');
  const argv = [execPath, '--version'];
  const binding = createLaunchBinding(argv, {
    platform: 'win32', ...trustOptions(root, argv[0], execPath, 'win32'),
  });
  fs.writeFileSync(execPath, 'other-runtim');
  assert.throws(
    () => resolveLaunch(argv, binding, { platform: 'win32', projectRoot: root, env: { Path: root } }),
    error => error.code === 'FACTORY_LAUNCH_IDENTITY_CHANGED' && !error.message.includes(root),
  );
  fs.unlinkSync(execPath);
  assert.throws(
    () => resolveLaunch(argv, binding, { platform: 'win32', projectRoot: root }),
    error => error.code === 'FACTORY_LAUNCH_IDENTITY_CHANGED' && !error.message.includes(root),
  );
});

test('runtime rejects launch binding tampering and opened-byte drift with path-free errors', () => {
  const { root, execPath } = runtimeFixture();
  const argv = ['npm', 'test'];
  const binding = createLaunchBinding(argv, { platform: 'win32', execPath });
  const forged = { ...binding, prefix: ['npm.cmd'] };
  assert.throws(
    () => resolveLaunch(argv, forged, { platform: 'win32', execPath }),
    error => error.code === 'FACTORY_LAUNCH_BINDING_INVALID'
      && error.message === 'governed launch binding is invalid'
      && !error.message.includes(root),
  );

  fs.writeFileSync(path.join(root, 'node_modules', 'npm', 'bin', 'npm-cli.js'), 'changed-cli');
  assert.throws(
    () => resolveLaunch(argv, binding, { platform: 'win32', execPath }),
    error => error.code === 'FACTORY_LAUNCH_IDENTITY_CHANGED'
      && error.message === 'governed launch identity changed'
      && !error.message.includes(root),
  );
});

test('legacy, malformed, and unavailable bindings fail closed without leaking paths', () => {
  assert.ok(validateLaunchBinding(undefined, ['node']).includes('launch binding is required'));
  assert.ok(validateLaunchBinding({ schemaVersion: '1.0.0' }, ['node']).length > 0);
  assert.throws(
    () => createLaunchBinding([], { platform: 'linux' }),
    error => error.code === 'FACTORY_LAUNCH_BINDING_INVALID',
  );
  const { root, execPath } = runtimeFixture();
  fs.unlinkSync(path.join(root, 'node_modules', 'npm', 'bin', 'npm-cli.js'));
  assert.throws(
    () => createLaunchBinding(['npm', 'test'], { platform: 'win32', execPath }),
    error => !error.message.includes(root),
  );
  assert.throws(
    () => createLaunchBinding(['npm'], { platform: 'win32', execPath: 'relative-node.exe' }),
    error => error.code === 'FACTORY_LAUNCH_CAPABILITY_UNAVAILABLE',
  );
});

test('executable links, invalid reads, identity swaps, and close failures fail closed', t => {
  {
    const { root, execPath } = runtimeFixture();
    const linked = path.join(root, 'linked-node.exe');
    fs.linkSync(execPath, linked);
    assert.throws(
      () => createLaunchBinding(['npm'], { platform: 'win32', execPath }),
      error => error.code === 'FACTORY_LAUNCH_CAPABILITY_UNAVAILABLE',
    );
  }
  {
    const { execPath } = runtimeFixture();
    const invalidStat = fileSystemProxy({
      lstatSync: () => ({ isFile() { throw new Error('stat'); } }),
    });
    assert.throws(
      () => createLaunchBinding(['npm'], { platform: 'win32', execPath, fileSystem: invalidStat }),
      error => error.code === 'FACTORY_LAUNCH_CAPABILITY_UNAVAILABLE',
    );
  }
  {
    const { execPath } = runtimeFixture();
    const differentRealpath = () => {};
    differentRealpath.native = value => `${value}.different`;
    const changedCanonicalPath = fileSystemProxy({ realpathSync: differentRealpath });
    assert.throws(
      () => createLaunchBinding(['npm'], { platform: 'win32', execPath, fileSystem: changedCanonicalPath }),
      error => error.code === 'FACTORY_LAUNCH_CAPABILITY_UNAVAILABLE',
    );
  }
  {
    const { execPath } = runtimeFixture();
    const nullRealpath = () => {};
    nullRealpath.native = () => { throw null; };
    const invalidFileSystem = fileSystemProxy({ realpathSync: nullRealpath });
    assert.throws(
      () => createLaunchBinding(['npm'], { platform: 'win32', execPath, fileSystem: invalidFileSystem }),
      error => error.code === 'FACTORY_LAUNCH_CAPABILITY_UNAVAILABLE',
    );
  }
  {
    const { execPath } = runtimeFixture();
    const unavailableRealpath = () => {};
    unavailableRealpath.native = () => { throw new Error('realpath'); };
    const invalidFileSystem = fileSystemProxy({ realpathSync: unavailableRealpath });
    assert.throws(
      () => createLaunchBinding(['npm'], { platform: 'win32', execPath, fileSystem: invalidFileSystem }),
      error => error.code === 'FACTORY_LAUNCH_CAPABILITY_UNAVAILABLE',
    );
  }
  {
    const { root, execPath } = runtimeFixture();
    const codedRealpath = () => {};
    codedRealpath.native = () => {
      const error = new Error(`ENOENT at ${root}`);
      error.code = 'ENOENT';
      throw error;
    };
    const nativeFailure = fileSystemProxy({ realpathSync: codedRealpath });
    assert.throws(
      () => createLaunchBinding(['npm'], { platform: 'win32', execPath, fileSystem: nativeFailure }),
      error => error.code === 'FACTORY_LAUNCH_CAPABILITY_UNAVAILABLE'
        && error.message === 'governed launch capability is unavailable'
        && !error.message.includes(root),
    );
  }
  {
    const { execPath } = runtimeFixture();
    const invalidRead = fileSystemProxy({ readSync: () => Number.NaN });
    assert.throws(
      () => createLaunchBinding(['npm'], { platform: 'win32', execPath, fileSystem: invalidRead }),
      error => error.code === 'FACTORY_LAUNCH_CAPABILITY_UNAVAILABLE',
    );
  }
  {
    const { execPath } = runtimeFixture();
    let count = 0;
    const identitySwap = fileSystemProxy({
      fstatSync(descriptor, options) {
        const stat = fs.fstatSync(descriptor, options);
        count += 1;
        if (count !== 2) return stat;
        return {
          ...stat, ino: stat.ino + 1n,
          isFile: () => true, isSymbolicLink: () => false,
        };
      },
    });
    assert.throws(
      () => createLaunchBinding(['npm'], { platform: 'win32', execPath, fileSystem: identitySwap }),
      error => error.code === 'FACTORY_LAUNCH_IDENTITY_CHANGED',
    );
  }
  {
    const { execPath } = runtimeFixture();
    const closeFailure = fileSystemProxy({ closeSync: () => { throw new Error('close'); } });
    assert.throws(
      () => createLaunchBinding(['npm'], { platform: 'win32', execPath, fileSystem: closeFailure }),
      error => error.code === 'FACTORY_LAUNCH_CAPABILITY_UNAVAILABLE',
    );
  }
  {
    const { root, execPath } = runtimeFixture();
    const linked = path.join(root, 'symlink-node.exe');
    try { fs.symlinkSync(execPath, linked, 'file'); } catch { t.diagnostic('symlink unavailable'); return; }
    assert.throws(
      () => createLaunchBinding(['npm'], { platform: 'win32', execPath: linked }),
      error => error.code === 'FACTORY_LAUNCH_CAPABILITY_UNAVAILABLE',
    );
  }
});

test('same-size executable mutation and runtime capability loss are detected', () => {
  const { root, execPath } = runtimeFixture();
  const argv = ['npm', 'test'];
  const binding = createLaunchBinding(argv, { platform: 'win32', execPath });
  fs.writeFileSync(execPath, 'other-runtim');
  assert.equal(fs.statSync(execPath).size, Buffer.byteLength('node-runtime'));
  assert.throws(
    () => resolveLaunch(argv, binding, { platform: 'win32', execPath }),
    error => error.code === 'FACTORY_LAUNCH_IDENTITY_CHANGED',
  );

  fs.writeFileSync(execPath, 'node-runtime');
  const fresh = createLaunchBinding(argv, { platform: 'win32', execPath });
  fs.unlinkSync(path.join(root, 'node_modules', 'npm', 'bin', 'npm-cli.js'));
  assert.throws(
    () => resolveLaunch(argv, fresh, { platform: 'win32', execPath }),
    error => error.code === 'FACTORY_LAUNCH_IDENTITY_CHANGED',
  );
});

test('validator reports every malformed binding boundary and tolerates hostile getters', () => {
  const direct = createLaunchBinding(['node']);
  const malformedDirect = {
    ...direct,
    schemaVersion: '0.0.0', kind: 'resolved-executable', platform: '', logicalExecutable: 'other',
    prefix: ['', '\0'], executableIdentity: {}, cliIdentity: {}, launchDigest: 'bad',
  };
  const directIssues = validateLaunchBinding(malformedDirect, [42]);
  for (const fragment of [
    'version', 'platform', 'logical executable', 'prefix', 'resolved executable launch prefix',
    'resolved executable identity', 'resolved executable CLI identity', 'launch digest',
  ]) assert.ok(directIssues.some(issue => issue.includes(fragment)), fragment);
  const invalidWindowsForms = [
    { ...direct, platform: 'win32', logicalExecutable: 'tool', prefix: ['C:\\tool.cmd'] },
    { ...direct, platform: 'win32', logicalExecutable: 'tool.cmd', prefix: [process.execPath] },
  ];
  for (const invalid of invalidWindowsForms) {
    assert.ok(validateLaunchBinding(invalid, [invalid.logicalExecutable])
      .includes('resolved Windows executable form is invalid'));
  }
  const forgedShell = {
    ...direct, logicalExecutable: 'bash', prefix: [process.execPath],
  };
  assert.ok(validateLaunchBinding(forgedShell, ['bash'])
    .includes('control interpreter launch is invalid'));
  const missingIdentityFields = {
    ...direct, executableIdentity: { canonicalPath: process.execPath },
  };
  assert.ok(validateLaunchBinding(missingIdentityFields, ['node'])
    .includes('resolved executable identity is invalid'));
  assert.ok(validateLaunchBinding({ ...direct, platform: 'linux', logicalExecutable: 42 }, ['node']).length > 0);

  const malformedNodeCli = {
    schemaVersion: LAUNCH_BINDING_VERSION, kind: 'node-cli', platform: 'linux',
    logicalExecutable: 'other', prefix: ['relative'], executableIdentity: { canonicalPath: 'elsewhere' },
    cliIdentity: { relativePath: 'wrong', contentDigest: 'bad' }, launchDigest: 'bad',
  };
  const nodeIssues = validateLaunchBinding(malformedNodeCli, ['other']);
  for (const fragment of [
    'node CLI launch identity', 'node CLI launch prefix', 'node executable identity',
    'node executable content', 'node CLI opened-byte',
  ]) assert.ok(nodeIssues.some(issue => issue.includes(fragment)), fragment);

  const missingNodeFields = {
    schemaVersion: LAUNCH_BINDING_VERSION, kind: 'node-cli', platform: 'win32',
    logicalExecutable: 'npm', prefix: [], executableIdentity: null, cliIdentity: null,
    launchDigest: 'bad',
  };
  assert.ok(validateLaunchBinding(missingNodeFields, ['npm']).length > 0);

  assert.deepEqual(
    validateLaunchBinding(new Proxy({}, { get() { throw new Error('hostile'); } }), ['node']),
    ['launch binding is invalid'],
  );
});
