const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { fork } = require('node:child_process');

const { FactoryStore, resolveWithinRoot } = require('../lib/factory/store');

test('resolveWithinRoot rejects traversal and the root itself for writes', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'factory-store-'));
  assert.throws(() => new FactoryStore(path.join(root, 'missing')), /not a directory/);
  const fileRoot = path.join(root, 'file-root');
  fs.writeFileSync(fileRoot, 'not a directory');
  assert.throws(() => new FactoryStore(fileRoot), /not a directory/);
  assert.throws(() => resolveWithinRoot(root, null), /safe relative string/);
  assert.throws(() => resolveWithinRoot(root, 'bad\0path'), /safe relative string/);
  assert.throws(() => resolveWithinRoot(root, '../outside.json'), /outside project root/);
  assert.throws(() => resolveWithinRoot(root, path.parse(root).root), /absolute path/);
  assert.throws(() => resolveWithinRoot(root, '.'), /project root itself/);
  assert.equal(resolveWithinRoot(root, '.', { allowRoot: true }), fs.realpathSync.native(root));
});

test('FactoryStore writes JSON atomically inside .factory and reads it back', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'factory-store-'));
  const store = new FactoryStore(root);
  store.writeCheckpoint({ runId: 'run-1', running: null });
  assert.deepEqual(store.readCheckpoint(), { runId: 'run-1', running: null });
  store.writeCheckpoint({ runId: 'run-1', running: { stepId: 'tests' } });
  assert.deepEqual(store.readCheckpoint().running, { stepId: 'tests' });
  assert.equal(fs.readdirSync(path.join(root, '.factory')).some(n => n.includes('.tmp-')), false);
  assert.equal(store.readPlan('missing-run'), null);
  assert.deepEqual(store.listEvidence('missing-run'), []);
  store.writePlan('run-1', { steps: [] });
  assert.deepEqual(store.readPlan('run-1'), { steps: [] });
  store.writeCheckpoint('run-1', { running: null });
  assert.deepEqual(store.readCheckpoint('run-1'), { running: null });
});

test('FactoryStore preserves evidence attempts and returns them in order', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'factory-store-'));
  const store = new FactoryStore(root);
  store.writeEvidence('run-1', { stepId: 'tests', attempt: 2, status: 'PASS' });
  store.writeEvidence('run-1', { stepId: 'tests', attempt: 1, status: 'FAIL' });
  assert.deepEqual(store.listEvidence('run-1').map(e => e.attempt), [1, 2]);
  assert.throws(
    () => store.writeEvidence('../escape', { stepId: 'tests', attempt: 1, status: 'PASS' }),
    /safe identifier/
  );
  assert.throws(
    () => store.writeEvidence('run-1', { stepId: 'tests', attempt: 0, status: 'PASS' }),
    /positive integer/
  );
});

test('resolveWithinRoot rejects an existing symlink escape', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'factory-store-'));
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'factory-outside-'));
  const link = path.join(root, 'escape');
  try {
    fs.symlinkSync(outside, link, 'junction');
  } catch (error) {
    t.skip(`symlinks unavailable: ${error.code}`);
    return;
  }
  assert.throws(() => resolveWithinRoot(root, 'escape/file.json'), /symlink outside project root/);
});

test('FactoryStore run lock is owner-safe and never steals an expired lease', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'factory-lock-'));
  const store = new FactoryStore(root);
  const first = store.acquireRunLock('run-1', 'tests', { now: 1000, ttlMs: 1000 });
  assert.throws(
    () => store.acquireRunLock('run-1', 'tests', { now: 1500 }),
    error => error.code === 'RUN_LOCK_HELD'
  );
  assert.throws(
    () => store.releaseRunLock('run-1', crypto.randomUUID()),
    error => error.code === 'RUN_LOCK_OWNER_MISMATCH'
  );
  assert.equal(fs.existsSync(path.join(root, '.factory', 'runs', 'run-1', 'lock.json')), true);
  assert.equal(store.releaseRunLock('run-1', first.token), true);
  assert.throws(() => store.acquireRunLock(null, 'tests'), /safe identifier/);

  const expired = store.acquireRunLock('run-1', 'tests', { now: 2000, ttlMs: 100 });
  assert.throws(
    () => store.acquireRunLock('run-1', 'tests', { now: 2200, ttlMs: 100 }),
    error => error.code === 'RUN_LOCK_HELD'
  );
  assert.equal(store.releaseRunLock('run-1', expired.token), true);
  const successor = store.acquireRunLock('run-1', 'tests', { now: 2300, ttlMs: 100 });
  assert.equal(typeof successor.token, 'string');
  assert.notEqual(successor.token, expired.token);
  assert.equal(store.releaseRunLock('run-1', successor.token), true);
});

test('FactoryStore preserves malformed or replaced run locks and fails closed', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'factory-lock-adversarial-'));
  const store = new FactoryStore(root);
  const lock = store.acquireRunLock('run-1', 'tests');
  const file = path.join(root, '.factory', 'runs', 'run-1', 'lock.json');
  const malformed = [
    '{malformed',
    JSON.stringify(null),
    JSON.stringify([]),
    JSON.stringify({ ...lock, extra: true }),
    JSON.stringify(Object.fromEntries(Object.entries(lock).filter(([key]) => key !== 'stepId'))),
    JSON.stringify({ ...lock, schemaVersion: '2.0.0' }),
    JSON.stringify({ ...lock, runId: 'run-2' }),
    JSON.stringify({ ...lock, stepId: { unsafe: true } }),
    JSON.stringify({ ...lock, stepId: '' }),
    JSON.stringify({ ...lock, token: 'not-a-uuid' }),
    JSON.stringify({ ...lock, acquiredAt: 'not-a-date' }),
    JSON.stringify({ ...lock, acquiredAt: '1970-01-01T00:00:00Z' }),
    JSON.stringify({ ...lock, expiresAt: null }),
    JSON.stringify({ ...lock, expiresAt: lock.acquiredAt }),
    JSON.stringify({ ...lock, expiresAt: new Date(Date.parse(lock.acquiredAt) - 1).toISOString() }),
  ];
  for (const serialized of malformed) {
    fs.writeFileSync(file, serialized, 'utf8');
    const candidate = serialized.includes('not-a-uuid') ? 'not-a-uuid' : lock.token;
    assert.throws(
      () => store.releaseRunLock('run-1', candidate),
      error => error.code === 'RUN_LOCK_OWNER_MISMATCH'
    );
    assert.equal(fs.readFileSync(file, 'utf8'), serialized);
  }

  fs.rmSync(file);
  const current = store.acquireRunLock('run-1', 'tests');
  const replacement = { ...current, token: 'replacement-owner-token' };
  assert.throws(
    () => store.releaseRunLock('run-1', current.token, {
      beforeUnlink() {
        fs.renameSync(file, `${file}.old`);
        fs.writeFileSync(file, `${JSON.stringify(replacement)}\n`, 'utf8');
      },
    }),
    error => error.code === 'RUN_LOCK_OWNER_MISMATCH'
  );
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).token, replacement.token);
});

test('FactoryStore refuses a multiply-linked run lock without deleting it', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'factory-lock-link-'));
  const store = new FactoryStore(root);
  const directory = path.join(root, '.factory', 'runs', 'run-1');
  fs.mkdirSync(directory, { recursive: true });
  const source = path.join(root, 'foreign-lock.json');
  const target = path.join(directory, 'lock.json');
  const value = {
    schemaVersion: '1.0.0', runId: 'run-1', stepId: 'tests', token: 'foreign-owner',
    acquiredAt: new Date(0).toISOString(), expiresAt: new Date(1).toISOString(),
  };
  fs.writeFileSync(source, `${JSON.stringify(value)}\n`, 'utf8');
  try {
    fs.linkSync(source, target);
  } catch (error) {
    t.skip(`hard links unavailable: ${error.code}`);
    return;
  }
  assert.throws(
    () => store.releaseRunLock('run-1', value.token),
    error => error.code === 'RUN_LOCK_OWNER_MISMATCH'
  );
  assert.equal(fs.existsSync(target), true);
  assert.equal(fs.existsSync(source), true);
});

test('FactoryStore treats an unsafe run-lock ancestor as held', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'factory-lock-unsafe-'));
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'factory-lock-unsafe-outside-'));
  const runs = path.join(root, '.factory', 'runs');
  fs.mkdirSync(path.dirname(runs), { recursive: true });
  try {
    fs.symlinkSync(outside, runs, 'junction');
  } catch (error) {
    t.skip(`junctions unavailable: ${error.code}`);
    return;
  }
  assert.equal(new FactoryStore(root).hasRunLock('run-1'), true);
});

// Generous deadlock guards, not performance assertions: a forked Node process can take many seconds to start
// on a host saturated by queued builds (ADR-0021), and a 3 s limit made this test fail under load.
const CHILD_DEADLINE_MS = 60_000;

test('FactoryStore blocks a second process after the informational expiry until the owner releases', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'factory-lock-process-'));
  const fixture = path.join(__dirname, 'fixtures', 'run-lock-holder.js');
  const child = fork(fixture, [root, 'run-1'], { stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
  t.after(() => { if (child.exitCode === null) child.kill(); });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('lock holder did not become ready')), CHILD_DEADLINE_MS);
    child.once('error', reject);
    child.on('message', message => {
      if (message?.type === 'ready') { clearTimeout(timer); resolve(); }
    });
  });
  await new Promise(resolve => setTimeout(resolve, 75));
  const store = new FactoryStore(root);
  assert.throws(
    () => store.acquireRunLock('run-1', 'tests'),
    error => error.code === 'RUN_LOCK_HELD'
  );
  child.send({ type: 'release' });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('lock holder did not exit')), CHILD_DEADLINE_MS);
    child.once('error', reject);
    child.once('exit', code => {
      clearTimeout(timer);
      code === 0 ? resolve() : reject(new Error(`lock holder exited with ${code}`));
    });
  });
  const successor = store.acquireRunLock('run-1', 'tests');
  assert.equal(store.releaseRunLock('run-1', successor.token), true);
});
