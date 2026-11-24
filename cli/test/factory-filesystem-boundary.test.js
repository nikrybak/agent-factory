'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { hashValue } = require('../lib/factory/hash');
const {
  FILESYSTEM_BOUNDARY_VERSION, FILESYSTEM_CAPABILITY, FILESYSTEM_CAPABILITY_DIGEST,
  assertPathIdentity, readOpenedFile,
} = require('../lib/factory/filesystem-boundary');

function temporaryRoot(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'factory-fs-boundary-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

function write(root, relative, content) {
  const file = path.join(root, relative);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
  return file;
}

function wrappedFs(overrides = {}) {
  return {
    lstatSync: (...args) => fs.lstatSync(...args),
    openSync: (...args) => fs.openSync(...args),
    fstatSync: (...args) => fs.fstatSync(...args),
    readSync: (...args) => fs.readSync(...args),
    closeSync: (...args) => fs.closeSync(...args),
    ...overrides,
  };
}

function statView(stat, overrides = {}) {
  return {
    dev: stat.dev, ino: stat.ino, nlink: stat.nlink,
    isSymbolicLink: () => stat.isSymbolicLink(),
    isDirectory: () => stat.isDirectory(),
    isFile: () => stat.isFile(),
    ...overrides,
  };
}

function expectCode(fn, code, secret = '') {
  assert.throws(fn, error => {
    assert.equal(error.code, code);
    assert.equal(error.message, {
      FACTORY_FILESYSTEM_PATH_UNSAFE: 'governed filesystem path is unsafe',
      FACTORY_FILESYSTEM_IDENTITY_CHANGED: 'governed filesystem identity changed',
      FACTORY_FILESYSTEM_CAPABILITY_UNAVAILABLE: 'governed filesystem capability is unavailable',
    }[code]);
    if (secret) assert.equal(error.message.includes(secret), false);
    return true;
  });
}

test('capability and regular opened-byte identity are exact and deterministic', t => {
  assert.equal(FILESYSTEM_BOUNDARY_VERSION, '1.0.0');
  assert.deepEqual(FILESYSTEM_CAPABILITY, {
    schemaVersion: '1.0.0',
    provider: 'node-opened-descriptor-static-fence',
    platformFamily: process.platform === 'win32' ? 'win32' : 'posix',
    openedDescriptorBytes: true,
    ancestorIdentityComparison: true,
    finalIdentityComparison: true,
    staticLinkRejection: true,
    descriptorRelativeResolution: false,
    descriptorRelativeMutation: false,
    samePrincipalAbaResistance: false,
  });
  assert.equal(Object.isFrozen(FILESYSTEM_CAPABILITY), true);
  assert.equal(FILESYSTEM_CAPABILITY_DIGEST, hashValue(FILESYSTEM_CAPABILITY));
  assert.match(FILESYSTEM_CAPABILITY_DIGEST, /^[a-f0-9]{64}$/);

  const root = temporaryRoot(t);
  const bytes = Buffer.from('{"governed":true}\n', 'utf8');
  write(root, 'factory/catalog/example.json', bytes);
  const hooks = [];
  const opened = readOpenedFile(root, 'factory/catalog/example.json', {
    fault(point) { hooks.push(point); },
  });
  assert.deepEqual(opened.buffer, bytes);
  assert.equal(opened.contentDigest, crypto.createHash('sha256').update(bytes).digest('hex'));
  assert.match(opened.contentDigest, /^[a-f0-9]{64}$/);
  assert.deepEqual(hooks, ['after-ancestor-capture', 'after-open', 'after-read']);
  assert.equal(Object.isFrozen(opened), true);
  assert.equal(Object.isFrozen(opened.identity), true);
  assert.equal(Object.isFrozen(opened.identity.ancestors), true);
  assert.equal(opened.identity.root, opened.identity.ancestors[0]);
  assert.equal(opened.identity.ancestors.length, 3);
  for (const ancestor of opened.identity.ancestors) {
    assert.deepEqual(Object.keys(ancestor), ['dev', 'ino', 'type']);
    assert.equal(ancestor.type, 'directory');
    assert.equal(typeof ancestor.dev, 'bigint');
    assert.ok(ancestor.ino > 0n);
  }
  assert.deepEqual(Object.keys(opened.identity.final), ['dev', 'ino', 'type', 'nlink']);
  assert.equal(opened.identity.final.type, 'regular');
  assert.equal(opened.identity.final.nlink, 1n);
  assert.equal(assertPathIdentity(root, 'factory/catalog/example.json', opened.identity), true);
});

test('lexical, static link, type, hardlink, and size violations are fixed and path-free', t => {
  const root = temporaryRoot(t);
  const secret = 'unsafe-path-secret';
  write(root, 'regular.json', '{}');
  for (const candidate of ['', '.', '..', `../${secret}`, path.resolve(root, 'regular.json'), `bad\0${secret}`, null]) {
    expectCode(() => readOpenedFile(root, candidate), 'FACTORY_FILESYSTEM_PATH_UNSAFE', secret);
  }
  expectCode(() => readOpenedFile(null, 'regular.json'), 'FACTORY_FILESYSTEM_PATH_UNSAFE');
  expectCode(() => readOpenedFile('', 'regular.json'), 'FACTORY_FILESYSTEM_PATH_UNSAFE');
  expectCode(() => readOpenedFile(root, 'regular.json', null), 'FACTORY_FILESYSTEM_PATH_UNSAFE');
  expectCode(() => readOpenedFile(root, 'regular.json', []), 'FACTORY_FILESYSTEM_PATH_UNSAFE');
  expectCode(() => readOpenedFile(root, 'regular.json', new Proxy({}, {
    get() { throw new Error(secret); },
  })), 'FACTORY_FILESYSTEM_PATH_UNSAFE', secret);
  expectCode(() => readOpenedFile(root, 'missing.json'), 'FACTORY_FILESYSTEM_PATH_UNSAFE');
  expectCode(() => readOpenedFile(path.join(root, 'missing-root'), 'x.json'), 'FACTORY_FILESYSTEM_PATH_UNSAFE');
  expectCode(() => readOpenedFile(root, 'regular.json', { maxBytes: 0 }), 'FACTORY_FILESYSTEM_PATH_UNSAFE');
  expectCode(() => readOpenedFile(root, 'regular.json', { maxBytes: 1.5 }), 'FACTORY_FILESYSTEM_PATH_UNSAFE');
  expectCode(() => readOpenedFile(root, 'regular.json', { maxBytes: Number.MAX_SAFE_INTEGER }), 'FACTORY_FILESYSTEM_PATH_UNSAFE');
  fs.mkdirSync(path.join(root, 'directory.json'));
  expectCode(() => readOpenedFile(root, 'directory.json'), 'FACTORY_FILESYSTEM_PATH_UNSAFE');
  write(root, 'not-directory', 'x');
  expectCode(() => readOpenedFile(root, 'not-directory/leaf.json'), 'FACTORY_FILESYSTEM_PATH_UNSAFE');
  write(root, 'large.json', '12345');
  expectCode(() => readOpenedFile(root, 'large.json', { maxBytes: 4 }), 'FACTORY_FILESYSTEM_PATH_UNSAFE');

  const hardlink = path.join(root, 'hardlink.json');
  fs.linkSync(path.join(root, 'regular.json'), hardlink);
  expectCode(() => readOpenedFile(root, 'hardlink.json'), 'FACTORY_FILESYSTEM_PATH_UNSAFE');

  const linkedAncestorFs = wrappedFs({
    lstatSync(absolute, options) {
      const stat = fs.lstatSync(absolute, options);
      return absolute === root ? statView(stat, { isSymbolicLink: () => true }) : stat;
    },
  });
  expectCode(
    () => readOpenedFile(root, 'regular.json', { fileSystem: linkedAncestorFs }),
    'FACTORY_FILESYSTEM_PATH_UNSAFE',
  );

  const outside = temporaryRoot(t);
  write(outside, 'outside.json', '{}');
  try {
    fs.symlinkSync(path.join(outside, 'outside.json'), path.join(root, 'leaf-link.json'), 'file');
    expectCode(() => readOpenedFile(root, 'leaf-link.json'), 'FACTORY_FILESYSTEM_PATH_UNSAFE');
    fs.symlinkSync(outside, path.join(root, 'ancestor-link'), process.platform === 'win32' ? 'junction' : 'dir');
    expectCode(() => readOpenedFile(root, 'ancestor-link/outside.json'), 'FACTORY_FILESYSTEM_PATH_UNSAFE');
    fs.symlinkSync(root, path.join(outside, 'root-link'), process.platform === 'win32' ? 'junction' : 'dir');
    expectCode(() => readOpenedFile(path.join(outside, 'root-link'), 'regular.json'), 'FACTORY_FILESYSTEM_PATH_UNSAFE');
  } catch (error) {
    if (!['EPERM', 'EACCES', 'UNKNOWN'].includes(error.code)) throw error;
  }
});

test('opened, ancestor, final, and asserted identities fail closed on every fault boundary', t => {
  const root = temporaryRoot(t);
  const file = write(root, 'catalog/item.json', '{}');
  const baseline = readOpenedFile(root, 'catalog/item.json');
  const originalLstat = fs.lstatSync(file, { bigint: true });

  let changed = false;
  const changedPathFs = wrappedFs({
    lstatSync(absolute, options) {
      const stat = fs.lstatSync(absolute, options);
      return changed && absolute === file ? statView(stat, { ino: stat.ino + 1n }) : stat;
    },
  });
  expectCode(() => readOpenedFile(root, 'catalog/item.json', {
    fileSystem: changedPathFs,
    fault(point) { if (point === 'after-open') changed = true; },
  }), 'FACTORY_FILESYSTEM_IDENTITY_CHANGED');

  changed = false;
  expectCode(() => readOpenedFile(root, 'catalog/item.json', {
    fileSystem: changedPathFs,
    fault(point) { if (point === 'after-ancestor-capture') changed = true; },
  }), 'FACTORY_FILESYSTEM_IDENTITY_CHANGED');

  changed = false;
  const changedDescriptorFs = wrappedFs({
    fstatSync(descriptor, options) {
      const stat = fs.fstatSync(descriptor, options);
      return changed ? statView(stat, { ino: stat.ino + 1n }) : stat;
    },
  });
  expectCode(() => readOpenedFile(root, 'catalog/item.json', {
    fileSystem: changedDescriptorFs,
    fault(point) { if (point === 'after-read') changed = true; },
  }), 'FACTORY_FILESYSTEM_IDENTITY_CHANGED');

  changed = false;
  const missingPathFs = wrappedFs({
    lstatSync(absolute, options) {
      if (changed && absolute === file) throw new Error('removed after capture');
      return fs.lstatSync(absolute, options);
    },
  });
  expectCode(() => readOpenedFile(root, 'catalog/item.json', {
    fileSystem: missingPathFs,
    fault(point) { if (point === 'after-open') changed = true; },
  }), 'FACTORY_FILESYSTEM_IDENTITY_CHANGED');

  changed = false;
  const changedAncestorFs = wrappedFs({
    lstatSync(absolute, options) {
      const stat = fs.lstatSync(absolute, options);
      return changed && absolute === root ? statView(stat, { ino: stat.ino + 1n }) : stat;
    },
  });
  expectCode(() => readOpenedFile(root, 'catalog/item.json', {
    fileSystem: changedAncestorFs,
    fault(point) { if (point === 'after-read') changed = true; },
  }), 'FACTORY_FILESYSTEM_IDENTITY_CHANGED');

  changed = false;
  const invalidAncestorFs = wrappedFs({
    lstatSync(absolute, options) {
      const stat = fs.lstatSync(absolute, options);
      return changed && absolute === root ? statView(stat, {
        isDirectory: () => false, isFile: () => true,
      }) : stat;
    },
  });
  expectCode(() => readOpenedFile(root, 'catalog/item.json', {
    fileSystem: invalidAncestorFs,
    fault(point) { if (point === 'after-open') changed = true; },
  }), 'FACTORY_FILESYSTEM_IDENTITY_CHANGED');

  expectCode(() => readOpenedFile(root, 'catalog/item.json', {
    fault(point) { if (point === 'after-ancestor-capture') throw new Error('hostile hook'); },
  }), 'FACTORY_FILESYSTEM_IDENTITY_CHANGED');

  changed = false;
  expectCode(() => assertPathIdentity(root, 'catalog/item.json', baseline.identity, {
    fileSystem: changedPathFs,
    fault(point) { if (point === 'after-ancestor-capture') changed = true; },
  }), 'FACTORY_FILESYSTEM_IDENTITY_CHANGED');

  const identity = baseline.identity;
  const finalWith = values => ({ ...identity, final: { ...identity.final, ...values } });
  const ancestorsWith = ancestors => ({ ...identity, ancestors });
  for (const malformed of [
    null,
    {},
    { ...identity, root: { get dev() { throw new Error('getter'); } } },
    new Proxy(identity, { get(target, property) {
      if (property === 'root') throw new Error('proxy');
      return target[property];
    } }),
    ancestorsWith(null),
    ancestorsWith(identity.ancestors.slice(1)),
    ancestorsWith(identity.ancestors.map((item, index) => index === 1
      ? { ...item, ino: item.ino + 1n } : item)),
    finalWith({ type: 'other' }),
    finalWith({ nlink: 2n }),
  ]) {
    expectCode(
      () => assertPathIdentity(root, 'catalog/item.json', malformed),
      'FACTORY_FILESYSTEM_IDENTITY_CHANGED',
    );
  }

  // Swap the file while the original still exists: an unlinked inode may be reused at once on Linux.
  fs.renameSync(file, `${file}.replaced`);
  write(root, 'catalog/item.json', '{"replacement":true}');
  expectCode(
    () => assertPathIdentity(root, 'catalog/item.json', baseline.identity),
    'FACTORY_FILESYSTEM_IDENTITY_CHANGED',
  );
  assert.ok(originalLstat.ino > 0n);
});

test('missing primitives and unusable identities report capability without native details', t => {
  const root = temporaryRoot(t);
  const file = write(root, 'item.json', '{}');
  expectCode(
    () => readOpenedFile(root, 'item.json', { fileSystem: {} }),
    'FACTORY_FILESYSTEM_CAPABILITY_UNAVAILABLE',
  );
  expectCode(
    () => readOpenedFile(root, 'item.json', { fileSystem: new Proxy({}, {
      get() { throw new Error('hostile filesystem'); },
    }) }),
    'FACTORY_FILESYSTEM_CAPABILITY_UNAVAILABLE',
  );

  const real = fs.lstatSync(root, { bigint: true });
  for (const override of [
    { dev: 1 }, { dev: -1n }, { ino: 1 }, { ino: 0n },
  ]) {
    const fileSystem = wrappedFs({ lstatSync: () => statView(real, override) });
    expectCode(
      () => readOpenedFile(root, 'item.json', { fileSystem }),
      'FACTORY_FILESYSTEM_CAPABILITY_UNAVAILABLE',
    );
  }
  const methodFailure = wrappedFs({
    lstatSync: () => statView(real, { isSymbolicLink: () => { throw new Error('native detail'); } }),
  });
  expectCode(
    () => readOpenedFile(root, 'item.json', { fileSystem: methodFailure }),
    'FACTORY_FILESYSTEM_CAPABILITY_UNAVAILABLE',
    file,
  );

  const finalStat = fs.lstatSync(file, { bigint: true });
  for (const override of [{ nlink: 1 }, { nlink: 0n }]) {
    const fileSystem = wrappedFs({
      lstatSync(absolute, options) {
        const stat = fs.lstatSync(absolute, options);
        return absolute === file ? statView(stat, override) : stat;
      },
    });
    expectCode(
      () => readOpenedFile(root, 'item.json', { fileSystem }),
      'FACTORY_FILESYSTEM_CAPABILITY_UNAVAILABLE',
    );
  }
  const otherType = wrappedFs({
    lstatSync(absolute, options) {
      const stat = fs.lstatSync(absolute, options);
      return absolute === file ? statView(stat, {
        isSymbolicLink: () => false, isDirectory: () => false, isFile: () => false,
      }) : stat;
    },
  });
  expectCode(
    () => readOpenedFile(root, 'item.json', { fileSystem: otherType }),
    'FACTORY_FILESYSTEM_PATH_UNSAFE',
  );
  const linkedType = wrappedFs({
    lstatSync(absolute, options) {
      const stat = fs.lstatSync(absolute, options);
      return absolute === file ? statView(stat, { isSymbolicLink: () => true }) : stat;
    },
  });
  expectCode(
    () => readOpenedFile(root, 'item.json', { fileSystem: linkedType }),
    'FACTORY_FILESYSTEM_PATH_UNSAFE',
  );
  assert.equal(finalStat.type, undefined);
});

test('open, stat, read, and close failures remain fixed while descriptors close', t => {
  const root = temporaryRoot(t);
  write(root, 'item.json', '{}');
  expectCode(() => readOpenedFile(root, 'item.json', {
    fileSystem: wrappedFs({ openSync() { throw new Error('native open path'); } }),
  }), 'FACTORY_FILESYSTEM_IDENTITY_CHANGED');
  expectCode(() => readOpenedFile(root, 'item.json', {
    fileSystem: wrappedFs({ fstatSync() { throw new Error('native stat path'); } }),
  }), 'FACTORY_FILESYSTEM_CAPABILITY_UNAVAILABLE');
  expectCode(() => readOpenedFile(root, 'item.json', {
    fileSystem: wrappedFs({
      fstatSync(descriptor, options) {
        return statView(fs.fstatSync(descriptor, options), { dev: 1 });
      },
    }),
  }), 'FACTORY_FILESYSTEM_CAPABILITY_UNAVAILABLE');
  expectCode(() => readOpenedFile(root, 'item.json', {
    fileSystem: wrappedFs({
      fstatSync(descriptor, options) {
        return statView(fs.fstatSync(descriptor, options), { nlink: 2n });
      },
    }),
  }), 'FACTORY_FILESYSTEM_IDENTITY_CHANGED');
  expectCode(() => readOpenedFile(root, 'item.json', {
    fileSystem: wrappedFs({
      fstatSync(descriptor, options) {
        const stat = fs.fstatSync(descriptor, options);
        return statView(stat, { ino: stat.ino + 1n });
      },
    }),
  }), 'FACTORY_FILESYSTEM_IDENTITY_CHANGED');
  expectCode(() => readOpenedFile(root, 'item.json', {
    fileSystem: wrappedFs({ readSync() { throw new Error('native read bytes'); } }),
  }), 'FACTORY_FILESYSTEM_CAPABILITY_UNAVAILABLE');
  expectCode(() => readOpenedFile(root, 'item.json', {
    fileSystem: wrappedFs({ readSync() { return -1; } }),
  }), 'FACTORY_FILESYSTEM_CAPABILITY_UNAVAILABLE');
  expectCode(() => readOpenedFile(root, 'item.json', {
    fileSystem: wrappedFs({ readSync() { return 1.5; } }),
  }), 'FACTORY_FILESYSTEM_CAPABILITY_UNAVAILABLE');
  expectCode(() => readOpenedFile(root, 'item.json', {
    fileSystem: wrappedFs({ readSync(_descriptor, _buffer, _offset, length) { return length + 1; } }),
  }), 'FACTORY_FILESYSTEM_CAPABILITY_UNAVAILABLE');
  expectCode(() => readOpenedFile(root, 'item.json', {
    fileSystem: wrappedFs({ closeSync() { throw new Error('native close path'); } }),
  }), 'FACTORY_FILESYSTEM_CAPABILITY_UNAVAILABLE');
});
