'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const childProcess = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { canonicalJson } = require('../lib/factory/hash');
const { createEntry, verifyLedger } = require('../lib/factory/ledger');
const {
  acquireLedgerLock, appendEntry, ledgerPath, lockPath, readLedger,
  flushDirectory, releaseLedgerLock, transactLedger,
} = require('../lib/factory/ledger-store');

function temporaryRoot(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'factory-ledger-store-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

function spawnWriter(root, id) {
  const fixture = path.join(__dirname, 'fixtures', 'ledger-writer.js');
  return new Promise((resolve, reject) => {
    const child = childProcess.spawn(process.execPath, [fixture, root, id], {
      shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', code => code === 0
      ? resolve(stdout.trim())
      : reject(new Error(`writer ${id} failed (${code}): ${stderr}`)));
  });
}

test('project ledger transaction gives every concurrent process one exact sequence', async t => {
  const root = temporaryRoot(t);
  const ids = Array.from({ length: 24 }, (_, index) => `writer-${index}`);
  const results = await Promise.all(ids.map(id => spawnWriter(root, id)));
  assert.equal(new Set(results).size, ids.length);
  const entries = readLedger(root);
  assert.equal(entries.length, ids.length);
  assert.equal(verifyLedger(entries).status, 'PASS');
  assert.deepEqual(entries.map(entry => entry.sequence), ids.map((_, index) => index + 1));
  assert.deepEqual(new Set(entries.map(entry => entry.event.id)), new Set(ids));
});

test('transaction builder receives one deeply immutable snapshot and commits its exact extension', t => {
  const root = temporaryRoot(t);
  appendEntry(root, { type: 'seed', status: 'PASS' });
  const result = transactLedger(root, (entries, expected) => {
    assert.equal(Object.isFrozen(entries), true);
    assert.equal(Object.isFrozen(entries[0]), true);
    assert.equal(Object.isFrozen(entries[0].event), true);
    assert.throws(() => { entries[0].event.status = 'FAIL'; }, /read only|Cannot assign/);
    assert.deepEqual(expected, { head: entries[0].hash, sequence: 1 });
    return {
      event: { type: 'next', status: 'PASS' },
      value: 'built-from-one-head',
      afterCommit(afterEntries, entry) {
        assert.equal(fs.existsSync(lockPath(root)), true);
        assert.equal(afterEntries.at(-1).hash, entry.hash);
        assert.equal(Object.isFrozen(afterEntries), true);
        return 'post-state-under-lock';
      },
    };
  });
  assert.equal(result.value, 'built-from-one-head');
  assert.equal(result.postValue, 'post-state-under-lock');
  assert.equal(result.entry.previousHash, result.expected.head);
  assert.equal(result.afterEntries.length, 2);
  assert.equal(verifyLedger(result.afterEntries).status, 'PASS');
});

test('head and sequence CAS rejects an ungoverned change without overwriting it', t => {
  const root = temporaryRoot(t);
  const first = appendEntry(root, { type: 'seed', status: 'PASS' });
  assert.throws(() => transactLedger(root, () => {
    const foreign = createEntry(first.hash, { type: 'foreign', status: 'PASS' }, { sequence: 2 });
    fs.writeFileSync(ledgerPath(root), `${canonicalJson(first)}\n${canonicalJson(foreign)}\n`, 'utf8');
    return { event: { type: 'stale-writer', status: 'PASS' } };
  }), error => error.code === 'LEDGER_HEAD_CONFLICT');
  const visible = readLedger(root);
  assert.equal(visible.length, 2);
  assert.equal(visible[1].event.type, 'foreign');
  assert.equal(verifyLedger(visible).status, 'PASS');
});

test('final CAS runs after every pre-rename callback and preserves a foreign head', t => {
  const root = temporaryRoot(t);
  const seed = appendEntry(root, { type: 'seed', status: 'PASS' });
  assert.throws(() => appendEntry(root, { type: 'ours', status: 'PASS' }, {
    fault(stage, details) {
      if (stage !== 'before-rename') return;
      const foreign = createEntry(seed.hash, { type: 'foreign-after-hook', status: 'PASS' }, { sequence: 2 });
      fs.writeFileSync(details.file, `${canonicalJson(seed)}\n${canonicalJson(foreign)}\n`, 'utf8');
    },
  }), error => error.code === 'LEDGER_HEAD_CONFLICT');
  const visible = readLedger(root);
  assert.equal(visible.length, 2);
  assert.equal(visible.at(-1).event.type, 'foreign-after-hook');
  assert.equal(verifyLedger(visible).status, 'PASS');
});

test('fault before rename preserves the previous complete chain and cleans its temporary', t => {
  const root = temporaryRoot(t);
  const first = appendEntry(root, { type: 'seed', status: 'PASS' });
  assert.throws(() => appendEntry(root, { type: 'never-visible', status: 'PASS' }, {
    fault(stage) { if (stage === 'before-rename') throw new Error('injected pre-rename fault'); },
  }), /injected pre-rename fault/);
  assert.deepEqual(readLedger(root), [first]);
  const artifacts = fs.readdirSync(path.dirname(ledgerPath(root))).filter(name => name.endsWith('.tmp'));
  assert.deepEqual(artifacts, []);
});

test('tampered chain is never replaced', t => {
  const root = temporaryRoot(t);
  const entry = appendEntry(root, { type: 'seed', status: 'PASS' });
  const tampered = { ...entry, event: { ...entry.event, status: 'FAIL' } };
  fs.writeFileSync(ledgerPath(root), `${canonicalJson(tampered)}\n`, 'utf8');
  assert.throws(
    () => appendEntry(root, { type: 'replacement', status: 'PASS' }),
    error => error.code === 'LEDGER_CHAIN_INVALID',
  );
  assert.deepEqual(readLedger(root), [tampered]);
});

test('ledger events cross the same pre-hash secret-free boundary', t => {
  const root = temporaryRoot(t);
  const canary = 'ledger-canary-secret-value';
  const entry = appendEntry(root, {
    type: 'security-observation', status: 'PASS',
    password: canary,
    message: `token=${canary}`,
  });
  const serialized = JSON.stringify(entry);
  assert.equal(serialized.includes(canary), false);
  assert.equal(entry.event.password, '<redacted>');
  assert.equal(entry.event.message.includes('<redacted>'), true);
  assert.equal(entry.event.redactionPolicyVersion, require('../lib/factory/redaction').REDACTION_POLICY_VERSION);
  assert.equal(verifyLedger(readLedger(root)).status, 'PASS');
});

test('an event that exceeds the bounded sanitizer is rejected before persistence', t => {
  const root = temporaryRoot(t);
  const oversized = {};
  for (let index = 0; index < 11_000; index += 1) {
    oversized[`field-${String(index).padStart(5, '0')}-${'x'.repeat(96)}`] = 'value';
  }
  assert.throws(
    () => appendEntry(root, oversized),
    error => error.code === 'LEDGER_EVENT_REDACTION_FAILED',
  );
  assert.equal(readLedger(root).length, 0);
});

test('malformed JSON and non-file ledger paths fail with named diagnostics', t => {
  const malformedRoot = temporaryRoot(t);
  fs.mkdirSync(path.dirname(ledgerPath(malformedRoot)), { recursive: true });
  fs.writeFileSync(ledgerPath(malformedRoot), '{not-json}\n', 'utf8');
  assert.throws(() => readLedger(malformedRoot), error => error.code === 'LEDGER_JSON_INVALID');

  const directoryRoot = temporaryRoot(t);
  fs.mkdirSync(ledgerPath(directoryRoot), { recursive: true });
  assert.throws(() => readLedger(directoryRoot), error => error.code === 'LEDGER_PATH_UNSAFE');

  const unsafeStateRoot = temporaryRoot(t);
  fs.writeFileSync(path.join(unsafeStateRoot, '.factory'), 'not-a-directory', 'utf8');
  assert.throws(() => ledgerPath(unsafeStateRoot), error => error.code === 'LEDGER_PATH_UNSAFE');
});

test('invalid transaction proposals and temporary-open faults release the owner lock', t => {
  const root = temporaryRoot(t);
  assert.throws(() => transactLedger(root, () => null), error => error.code === 'LEDGER_TRANSACTION_INVALID');
  assert.equal(fs.existsSync(lockPath(root)), false);
  assert.throws(() => appendEntry(root, { type: 'fault', status: 'FAIL' }, {
    fault(stage) { if (stage === 'after-temporary-open') throw new Error('open fault'); },
  }), /open fault/);
  assert.equal(fs.existsSync(lockPath(root)), false);
  assert.equal(readLedger(root).length, 0);
});

test('post-rename conflict is detected and the visible valid chain remains auditable', t => {
  const root = temporaryRoot(t);
  assert.throws(() => appendEntry(root, { type: 'ours', status: 'PASS' }, {
    fault(stage, details) {
      if (stage !== 'after-rename') return;
      const ours = readLedger(root);
      const foreign = createEntry(ours[0].hash, { type: 'foreign', status: 'PASS' }, { sequence: 2 });
      fs.writeFileSync(details.file, `${canonicalJson(ours[0])}\n${canonicalJson(foreign)}\n`, 'utf8');
    },
  }), error => error.code === 'LEDGER_COMMIT_UNCONFIRMED');
  const visible = readLedger(root);
  assert.equal(visible.at(-1).event.type, 'foreign');
  assert.equal(verifyLedger(visible).status, 'PASS');
});

test('directory flush distinguishes an unsupported Windows host from a real I/O fault', () => {
  const unsupported = {
    openSync() { throw Object.assign(new Error('unsupported'), { code: 'EPERM' }); },
    fsyncSync() {}, closeSync() {},
  };
  assert.equal(flushDirectory('ignored', unsupported, 'win32'), false);
  const broken = {
    openSync() { throw Object.assign(new Error('broken'), { code: 'EIO' }); },
    fsyncSync() {}, closeSync() {},
  };
  assert.throws(() => flushDirectory('ignored', broken, 'linux'), /broken/);
});

test('owner mismatch cannot release another writer lock and orphan lock is not stolen', t => {
  const root = temporaryRoot(t);
  const owner = acquireLedgerLock(root);
  assert.equal(releaseLedgerLock({ ...owner, token: 'not-the-owner' }), false);
  assert.equal(fs.existsSync(lockPath(root)), true);
  assert.throws(
    () => appendEntry(root, { type: 'blocked', status: 'FAIL' }, { lockTimeoutMs: 20, lockRetryMs: 2 }),
    error => error.code === 'LEDGER_LOCK_TIMEOUT',
  );
  assert.equal(fs.existsSync(lockPath(root)), true);
  assert.equal(releaseLedgerLock(owner), true);
  assert.equal(fs.existsSync(lockPath(root)), false);
  assert.equal(releaseLedgerLock(null), false);
  assert.equal(releaseLedgerLock(owner), false);
});

test('malformed lock metadata is never treated as owned', t => {
  const root = temporaryRoot(t);
  const owner = acquireLedgerLock(root);
  fs.writeFileSync(lockPath(root), '{invalid-lock', 'utf8');
  assert.equal(releaseLedgerLock(owner), false);
  assert.equal(fs.existsSync(lockPath(root)), true);
  fs.unlinkSync(lockPath(root));
});

test('transaction detects lock ownership replacement before returning', t => {
  const root = temporaryRoot(t);
  assert.throws(() => appendEntry(root, { type: 'committed-before-owner-error', status: 'PASS' }, {
    fault(stage) {
      if (stage !== 'after-rename') return;
      const file = lockPath(root);
      const current = JSON.parse(fs.readFileSync(file, 'utf8'));
      fs.writeFileSync(file, `${JSON.stringify({ ...current, token: 'replacement-owner' })}\n`, 'utf8');
    },
  }), error => error.code === 'LEDGER_LOCK_OWNER_MISMATCH');
  assert.equal(readLedger(root).length, 1);
  fs.unlinkSync(lockPath(root));
});

test('unsafe symbolic ledger path fails closed where symbolic links are available', t => {
  const root = temporaryRoot(t);
  const target = path.join(root, 'target.jsonl');
  fs.mkdirSync(path.dirname(ledgerPath(root)), { recursive: true });
  fs.writeFileSync(target, '');
  try {
    fs.symlinkSync(target, ledgerPath(root), 'file');
  } catch (error) {
    if (process.platform === 'win32' && ['EPERM', 'EACCES', 'UNKNOWN'].includes(error.code)) {
      t.skip('host does not grant symbolic-link creation');
      return;
    }
    throw error;
  }
  assert.throws(() => readLedger(root), error => error.code === 'LEDGER_PATH_UNSAFE');
});
