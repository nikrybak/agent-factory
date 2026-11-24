'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  TOOLCHAIN_TRUST_PATH,
  assertToolAuthorization,
  authorizeExecutable,
  enrollToolchainExecutable,
  loadToolchainTrust,
  normalizeLogicalExecutable,
  platformFamily,
  toolchainTrustPlanIdentity,
  validateToolAuthorization,
  validateToolchainTrust,
} = require('../lib/factory/toolchain-trust');

const digest = value => crypto.createHash('sha256').update(value).digest('hex');
const currentFamily = platformFamily();

function project() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'factory-tool-trust-'));
}

function document(entries = []) {
  return { schemaVersion: '1.0.0', platformFamily: currentFamily, entries };
}

function writeDocument(root, value, raw = false) {
  const file = path.join(root, TOOLCHAIN_TRUST_PATH);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, raw ? value : JSON.stringify(value));
  return file;
}

function nativeTool(root, name = process.platform === 'win32' ? 'helper.exe' : 'helper') {
  const target = path.join(root, name);
  fs.copyFileSync(process.execPath, target);
  if (process.platform !== 'win32') fs.chmodSync(target, 0o755);
  return target;
}

test('absent trust is a deterministic path-free snapshot and plan identity', () => {
  const root = project();
  const first = loadToolchainTrust(root);
  const second = loadToolchainTrust(root);
  assert.deepEqual(first, second);
  assert.equal(first.present, false);
  assert.equal(first.contentDigest, null);
  assert.equal(first.entries.length, 0);
  assert.match(toolchainTrustPlanIdentity(first).identityDigest, /^[a-f0-9]{64}$/);
  assert.equal(platformFamily('linux'), 'posix');
});

test('strict trust document authorizes only an exact enrolled digest', () => {
  const root = project();
  const approved = digest('approved');
  writeDocument(root, document([{ logicalExecutable: 'python', sha256: [approved] }]));
  const snapshot = loadToolchainTrust(root);
  const authorization = authorizeExecutable({
    logicalExecutable: 'python.exe', executableDigest: approved, snapshot,
  });
  assert.equal(authorization.source, 'local-overlay');
  assert.equal(authorization.logicalExecutable, 'python');
  assert.equal(validateToolAuthorization(
    authorization, 'python.exe', approved, process.platform,
  ), true);
  assert.equal(assertToolAuthorization(authorization, root, {
    logicalExecutable: 'python.exe', executableDigest: approved,
  }), true);
  assert.throws(
    () => authorizeExecutable({ logicalExecutable: 'python', executableDigest: digest('other'), snapshot }),
    error => error.code === 'FACTORY_TOOLCHAIN_UNAUTHORIZED'
      && error.message === 'governed executable is not authorized'
      && !error.message.includes(root),
  );
});

test('process anchors are exact and cannot be supplied by the local overlay', () => {
  const executableDigest = digest('node');
  const authorization = authorizeExecutable({
    logicalExecutable: 'node', executableDigest,
    snapshot: { platformFamily: currentFamily }, anchor: true,
  });
  assert.equal(authorization.source, 'process-anchor');
  assert.equal(validateToolAuthorization(authorization, 'node', executableDigest, process.platform), true);
  assert.equal(assertToolAuthorization(authorization, undefined, {
    logicalExecutable: 'node', executableDigest,
  }), true);
  assert.equal(authorizeExecutable({
    logicalExecutable: 'node', executableDigest, snapshot: undefined, anchor: true,
  }).platformFamily, currentFamily);
  for (const logicalExecutable of ['Node', 'node.exe', 'xnpm']) {
    assert.throws(
      () => authorizeExecutable({
        logicalExecutable, executableDigest,
        snapshot: { platformFamily: currentFamily }, anchor: true,
      }),
      error => error.code === 'FACTORY_TOOLCHAIN_UNAUTHORIZED',
    );
  }
  assert.throws(
    () => validateToolchainTrust(document([{ logicalExecutable: 'npm', sha256: [executableDigest] }])),
    error => error.code === 'FACTORY_TOOLCHAIN_TRUST_INVALID',
  );
});

test('schema rejects unknown fields, malformed names, collisions, and digest ordering', () => {
  const a = 'a'.repeat(64); const b = 'b'.repeat(64);
  const invalid = [
    { ...document(), extra: true },
    { schemaVersion: '2.0.0', platformFamily: currentFamily, entries: [] },
    { schemaVersion: '1.0.0', platformFamily: currentFamily === 'win32' ? 'posix' : 'win32', entries: [] },
    document([{ logicalExecutable: 'python', sha256: [a], path: '/bin/python' }]),
    document([{ logicalExecutable: 'Python', sha256: [a] }]),
    document([{ logicalExecutable: '../python', sha256: [a] }]),
    document([{ logicalExecutable: `a${'b'.repeat(64)}`, sha256: [a] }]),
    document([{ logicalExecutable: 'python', sha256: [] }]),
    document([{ logicalExecutable: 'python', sha256: [a.toUpperCase()] }]),
    document([{ logicalExecutable: 'python', sha256: [b, a] }]),
    document([{ logicalExecutable: 'python', sha256: [a, a] }]),
    document([
      { logicalExecutable: 'python', sha256: [a] },
      { logicalExecutable: 'python', sha256: [b] },
    ]),
    document([
      { logicalExecutable: 'zeta', sha256: [a] },
      { logicalExecutable: 'alpha', sha256: [b] },
    ]),
  ];
  for (const value of invalid) {
    assert.throws(
      () => validateToolchainTrust(value),
      error => error.code === 'FACTORY_TOOLCHAIN_TRUST_INVALID',
    );
  }
  assert.throws(() => normalizeLogicalExecutable('bad\u2028name'), /local toolchain trust is invalid/);
  assert.throws(() => normalizeLogicalExecutable(''), /local toolchain trust is invalid/);
});

test('opened-byte loader rejects duplicate JSON keys, BOM, trailing bytes, and prototype keys', () => {
  const root = project();
  const raws = [
    '{"schemaVersion":"1.0.0","schemaVersion":"1.0.0","platformFamily":"win32","entries":[]}',
    '\ufeff{"schemaVersion":"1.0.0","platformFamily":"win32","entries":[]}',
    '{"schemaVersion":"1.0.0","platformFamily":"win32","entries":[]} trailing',
    '{"schemaVersion":"1.0.0","platformFamily":"win32","entries":[],"__proto__":{}}',
    '{"schemaVersion":"1.0.0","platformFamily":"win32","entries":[{"logicalExecutable":"x","logicalExecutable":"x","sha256":["aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"]}]}',
  ];
  for (const raw of raws) {
    writeDocument(root, raw.replaceAll('"win32"', JSON.stringify(currentFamily)), true);
    assert.throws(
      () => loadToolchainTrust(root),
      error => error.code === 'FACTORY_TOOLCHAIN_TRUST_INVALID'
        && !error.message.includes(root),
    );
  }
});

test('strict JSON scanner rejects every malformed lexical boundary', () => {
  const root = project();
  const family = JSON.stringify(currentFamily);
  for (const raw of [
    '',
    'true',
    '@',
    '{',
    '{"schemaVersion"}',
    '{"schemaVersion":true "entries":[]}',
    '{"schemaVersion":',
    '[true false]',
    '[true',
    '{"schemaVersion":"unterminated}',
    '{"schemaVersion":"trailing\\',
    `{"schemaVersion":"bad${String.fromCharCode(1)}value"}`,
    '{"schemaVersion":"bad\\x"}',
    '{true:false}',
    `{"schemaVersion":"1.0.0","platformFamily":${family},"entries":[true,false,null,-1.5e+2]}`,
  ]) {
    writeDocument(root, raw, true);
    assert.throws(() => loadToolchainTrust(root), /local toolchain trust is invalid/);
  }
  const escaped = `{"\\u0073chemaVersion":"1.0.0","platformFamily":${family},"entries":[]}`;
  writeDocument(root, escaped, true);
  assert.equal(loadToolchainTrust(root).schemaVersion, '1.0.0');
});

test('trust byte or physical identity drift is rejected before reuse', t => {
  const root = project();
  const approved = digest('approved');
  const file = writeDocument(root, document([{ logicalExecutable: 'helper', sha256: [approved] }]));
  const snapshot = loadToolchainTrust(root);
  const authorization = authorizeExecutable({
    logicalExecutable: 'helper', executableDigest: approved, snapshot,
  });
  fs.appendFileSync(file, os.EOL);
  assert.throws(
    () => assertToolAuthorization(authorization, root, {
      logicalExecutable: 'helper', executableDigest: approved,
    }),
    error => error.code === 'FACTORY_TOOLCHAIN_TRUST_CHANGED' && !error.message.includes(root),
  );

  const linkedRoot = project();
  const linkedFile = writeDocument(linkedRoot, document([{ logicalExecutable: 'helper', sha256: [approved] }]));
  const hardlink = path.join(linkedRoot, '.factory', 'copy.json');
  fs.linkSync(linkedFile, hardlink);
  assert.throws(() => loadToolchainTrust(linkedRoot), /local toolchain trust is invalid/);
  try {
    const symlinkRoot = project();
    fs.mkdirSync(path.join(symlinkRoot, '.factory'));
    fs.symlinkSync(linkedFile, path.join(symlinkRoot, TOOLCHAIN_TRUST_PATH), 'file');
    assert.throws(() => loadToolchainTrust(symlinkRoot), /local toolchain trust is invalid/);
  } catch { t.diagnostic('symlink unavailable'); }
});

test('explicit enrollment never searches PATH and atomically writes sorted local state', () => {
  const root = project();
  const executablePath = nativeTool(root);
  const confirmedSha256 = digest(fs.readFileSync(executablePath));
  const previousPath = process.env.PATH;
  process.env.PATH = path.join(root, 'poison');
  try {
    const written = enrollToolchainExecutable({
      root, logicalExecutable: 'helper', executablePath, confirmedSha256,
      expectedTrustDigest: null,
    });
    assert.equal(written.entries[0].logicalExecutable, 'helper');
    assert.deepEqual(written.entries[0].sha256, [confirmedSha256]);
    assert.equal(fs.existsSync(path.join(root, TOOLCHAIN_TRUST_PATH)), true);
    assert.deepEqual(Object.keys(JSON.parse(fs.readFileSync(
      path.join(root, TOOLCHAIN_TRUST_PATH), 'utf8',
    ))).sort(), ['entries', 'platformFamily', 'schemaVersion']);
    const secondTool = nativeTool(root, process.platform === 'win32' ? 'zeta.exe' : 'zeta');
    const secondDigest = digest(fs.readFileSync(secondTool));
    const second = enrollToolchainExecutable({
      root, logicalExecutable: 'zeta', executablePath: secondTool,
      confirmedSha256: secondDigest, expectedTrustDigest: written.contentDigest,
    });
    const repeated = enrollToolchainExecutable({
      root, logicalExecutable: 'helper', executablePath,
      confirmedSha256, expectedTrustDigest: second.contentDigest,
    });
    assert.deepEqual(repeated.entries.map(entry => entry.logicalExecutable), ['helper', 'zeta']);
  } finally {
    process.env.PATH = previousPath;
  }
});

test('enrollment requires an owner-confirmed digest, absolute path, CAS, and non-shell name', () => {
  const root = project();
  const executablePath = nativeTool(root);
  const confirmedSha256 = digest(fs.readFileSync(executablePath));
  const base = { root, logicalExecutable: 'helper', executablePath, confirmedSha256, expectedTrustDigest: null };
  for (const change of [
    { executablePath: path.basename(executablePath) },
    { confirmedSha256: 'f'.repeat(64) },
    { expectedTrustDigest: 'e'.repeat(64) },
    { logicalExecutable: 'node' },
    { logicalExecutable: 'bash' },
  ]) {
    assert.throws(
      () => enrollToolchainExecutable({ ...base, ...change }),
      error => error.code === 'FACTORY_TOOLCHAIN_ENROLLMENT_INVALID'
        && error.message === 'local toolchain enrollment is invalid'
        && !error.message.includes(root),
    );
  }
});

test('hostile filesystem and malformed authorization fail closed with fixed errors', () => {
  const root = project();
  const denied = new Proxy(fs, {
    get(target, property) {
      if (property === 'lstatSync') return () => { throw new Error(`denied ${root}`); };
      return target[property];
    },
  });
  assert.throws(
    () => loadToolchainTrust(root, { fileSystem: denied }),
    error => error.code === 'FACTORY_TOOLCHAIN_TRUST_INVALID'
      && !error.message.includes(root),
  );
  assert.equal(validateToolAuthorization({}, 'helper', 'f'.repeat(64), process.platform), false);
  assert.throws(
    () => assertToolAuthorization({}, root, {
      logicalExecutable: 'helper', executableDigest: 'f'.repeat(64),
    }),
    error => error.code === 'FACTORY_TOOLCHAIN_TRUST_CHANGED',
  );
  assert.throws(() => loadToolchainTrust('', {}), /local toolchain trust is invalid/);
  assert.throws(
    () => validateToolchainTrust({
      get schemaVersion() { throw new Error('hostile'); },
      platformFamily: currentFamily, entries: [],
    }),
    /local toolchain trust is invalid/,
  );
  assert.throws(
    () => toolchainTrustPlanIdentity({ schemaVersion: 'bad' }),
    /local toolchain trust is invalid/,
  );
  assert.throws(() => toolchainTrustPlanIdentity({
    schemaVersion: '1.0.0', platformFamily: currentFamily, present: true,
    contentDigest: '', openedPathIdentity: {},
    filesystemBoundaryVersion: require('../lib/factory/filesystem-boundary').FILESYSTEM_BOUNDARY_VERSION,
    filesystemCapabilityDigest: require('../lib/factory/filesystem-boundary').FILESYSTEM_CAPABILITY_DIGEST,
  }), /local toolchain trust is invalid/);
  assert.throws(
    () => toolchainTrustPlanIdentity(new Proxy({}, { get() { throw new Error('hostile'); } })),
    /local toolchain trust is invalid/,
  );
  assert.throws(
    () => authorizeExecutable(undefined),
    error => error.code === 'FACTORY_TOOLCHAIN_UNAUTHORIZED',
  );
  assert.throws(
    () => authorizeExecutable({
      logicalExecutable: 'helper', executableDigest: undefined, snapshot: loadToolchainTrust(root),
    }),
    error => error.code === 'FACTORY_TOOLCHAIN_UNAUTHORIZED',
  );
  const shapedAuthorization = {
    schemaVersion: '1.0.0', platformFamily: currentFamily, source: 'process-anchor',
    logicalExecutable: 'node', executableContentDigest: 'f'.repeat(64),
    trustDocument: null, authorizationDigest: undefined,
  };
  assert.equal(validateToolAuthorization(
    shapedAuthorization, 'node', 'f'.repeat(64), process.platform,
  ), false);
  assert.equal(validateToolAuthorization(
    { ...shapedAuthorization, authorizationDigest: 'f'.repeat(64) },
    'node', 'f'.repeat(64), process.platform,
  ), false);
  assert.equal(validateToolAuthorization(
    {
      get schemaVersion() { throw new Error('hostile'); },
      platformFamily: currentFamily, source: 'local-overlay', logicalExecutable: 'helper',
      executableContentDigest: 'f'.repeat(64), trustDocument: {},
      authorizationDigest: 'f'.repeat(64),
    },
    'helper', 'f'.repeat(64), process.platform,
  ), false);
  const approved = digest('approved');
  writeDocument(root, document([{ logicalExecutable: 'helper', sha256: [approved] }]));
  const authorization = authorizeExecutable({
    logicalExecutable: 'helper', executableDigest: approved,
    snapshot: loadToolchainTrust(root),
  });
  writeDocument(root, '{', true);
  assert.throws(
    () => assertToolAuthorization(authorization, root, {
      logicalExecutable: 'helper', executableDigest: approved,
    }),
    error => error.code === 'FACTORY_TOOLCHAIN_TRUST_CHANGED',
  );
  const executablePath = nativeTool(project());
  assert.throws(
    () => enrollToolchainExecutable({
      root: project(), logicalExecutable: 'helper', executablePath,
      confirmedSha256: digest(fs.readFileSync(executablePath)), expectedTrustDigest: null,
    }, { fileSystem: {} }),
    /local toolchain enrollment is invalid/,
  );
  assert.throws(
    () => enrollToolchainExecutable({
      root: project(), logicalExecutable: 'helper', executablePath: path.resolve(root, 'missing.exe'),
      confirmedSha256: 'f'.repeat(64), expectedTrustDigest: null,
    }),
    /local toolchain enrollment is invalid/,
  );
  const exactEnrollment = {
    root: project(), logicalExecutable: 'helper', executablePath,
    confirmedSha256: undefined, expectedTrustDigest: null,
  };
  assert.throws(() => enrollToolchainExecutable(exactEnrollment), /local toolchain enrollment is invalid/);
  assert.throws(() => enrollToolchainExecutable({
    ...exactEnrollment, confirmedSha256: 'f'.repeat(64), expectedTrustDigest: undefined,
  }), /local toolchain enrollment is invalid/);
});
