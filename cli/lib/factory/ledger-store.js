'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { canonicalJson } = require('./hash');
const { createEntry, verifyLedger } = require('./ledger');
const {
  REDACTION_POLICY_VERSION, containsSensitiveMaterial, redactValue,
} = require('./redaction');

const DEFAULT_LOCK_TIMEOUT_MS = 10_000;
const DEFAULT_RETRY_MS = 10;

function codedError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function waitSync(durationMs) {
  const state = new Int32Array(new SharedArrayBuffer(4));
  Atomics.wait(state, 0, 0, Math.max(1, durationMs));
}

function factoryStatePath(root, name) {
  const canonicalRoot = fs.realpathSync.native(path.resolve(root));
  const directory = path.join(canonicalRoot, '.factory');
  if (fs.existsSync(directory)) {
    const stat = fs.lstatSync(directory);
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
      throw codedError('LEDGER_PATH_UNSAFE', '.factory must be a regular directory');
    }
  }
  return path.join(directory, name);
}

function ledgerPath(root) {
  return factoryStatePath(root, 'ledger.jsonl');
}

function lockPath(root) {
  return factoryStatePath(root, 'ledger.lock');
}

function assertPlainFile(file, label) {
  let stat;
  try {
    stat = fs.lstatSync(file);
  } catch (error) {
    if (error.code === 'ENOENT') return;
    throw error;
  }
  if (stat.isSymbolicLink() || !stat.isFile()) {
    throw codedError('LEDGER_PATH_UNSAFE', `${label} must be a regular file`);
  }
}

function parseLedger(text) {
  return text.split(/\r?\n/).filter(Boolean).map((line, index) => {
    try {
      const value = JSON.parse(line);
      if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('not an object');
      return value;
    } catch {
      throw codedError('LEDGER_JSON_INVALID', `invalid ledger JSON at line ${index + 1}`);
    }
  });
}

function readLedger(root) {
  const file = ledgerPath(root);
  if (!fs.existsSync(file)) return [];
  assertPlainFile(file, 'ledger');
  return parseLedger(fs.readFileSync(file, 'utf8'));
}

function freezeSnapshot(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) freezeSnapshot(child);
  return Object.freeze(value);
}

function acquireLedgerLock(root, options = {}) {
  const file = lockPath(root);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const timeoutMs = options.lockTimeoutMs ?? DEFAULT_LOCK_TIMEOUT_MS;
  const retryMs = options.lockRetryMs ?? DEFAULT_RETRY_MS;
  const deadline = Date.now() + Math.max(0, timeoutMs);
  const lock = {
    schemaVersion: '1.0.0',
    token: crypto.randomUUID(),
    pid: process.pid,
    acquiredAt: new Date().toISOString(),
  };
  while (true) {
    let descriptor;
    try {
      descriptor = fs.openSync(file, 'wx', 0o600);
      fs.writeFileSync(descriptor, `${JSON.stringify(lock)}\n`, 'utf8');
      fs.fsyncSync(descriptor);
      fs.closeSync(descriptor);
      return Object.freeze({ ...lock, file });
    } catch (error) {
      if (descriptor !== undefined) {
        try { fs.closeSync(descriptor); } catch {}
      }
      const contended = ['EACCES', 'EBUSY', 'EEXIST', 'EPERM'].includes(error.code);
      if (!contended) throw error;
      if (fs.existsSync(file)) assertPlainFile(file, 'ledger lock');
      if (Date.now() >= deadline) {
        throw codedError('LEDGER_LOCK_TIMEOUT', 'ledger writer lock is held; explicit recovery is required if its owner is gone');
      }
      waitSync(Math.min(Math.max(1, retryMs), Math.max(1, deadline - Date.now())));
    }
  }
}

function readLock(file) {
  assertPlainFile(file, 'ledger lock');
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

function releaseLedgerLock(lock) {
  if (!lock || typeof lock.file !== 'string' || typeof lock.token !== 'string') return false;
  if (!fs.existsSync(lock.file)) return false;
  const current = readLock(lock.file);
  if (!current || current.token !== lock.token) return false;
  fs.unlinkSync(lock.file);
  return true;
}

function verifySnapshot(entries) {
  const verification = verifyLedger(entries);
  if (verification.status !== 'PASS') {
    throw codedError('LEDGER_CHAIN_INVALID', 'cannot write a tampered ledger');
  }
  return verification;
}

function assertExpectedHead(root, expected) {
  const visible = readLedger(root);
  const verification = verifySnapshot(visible);
  if (verification.head !== expected.head || visible.length !== expected.sequence) {
    throw codedError('LEDGER_HEAD_CONFLICT', 'ledger head or sequence changed before commit');
  }
  return visible;
}

function flushDirectory(directory, fileSystem = fs, platform = process.platform) {
  let descriptor;
  try {
    descriptor = fileSystem.openSync(directory, 'r');
    fileSystem.fsyncSync(descriptor);
    return true;
  } catch (error) {
    if (platform === 'win32' && ['EACCES', 'EINVAL', 'EISDIR', 'EPERM'].includes(error.code)) return false;
    throw error;
  } finally {
    if (descriptor !== undefined) fileSystem.closeSync(descriptor);
  }
}

function replaceLedger(root, entries, expected, options = {}) {
  const file = ledgerPath(root);
  const directory = path.dirname(file);
  fs.mkdirSync(directory, { recursive: true });
  assertPlainFile(file, 'ledger');
  const temporary = path.join(directory, `.ledger.${process.pid}.${crypto.randomUUID()}.tmp`);
  let descriptor;
  try {
    descriptor = fs.openSync(temporary, 'wx', 0o600);
    options.fault?.('after-temporary-open', { temporary, file });
    const content = entries.map(item => canonicalJson(item)).join('\n') + '\n';
    fs.writeFileSync(descriptor, content, 'utf8');
    fs.fsyncSync(descriptor);
    fs.closeSync(descriptor);
    descriptor = undefined;
    options.fault?.('after-temporary-flush', { temporary, file });
    options.fault?.('before-rename', { temporary, file });
    assertExpectedHead(root, expected);
    fs.renameSync(temporary, file);
    const directoryFlushed = flushDirectory(directory);
    options.fault?.('after-rename', { file, directoryFlushed });
    return { file, directoryFlushed };
  } finally {
    if (descriptor !== undefined) {
      try { fs.closeSync(descriptor); } catch {}
    }
    try { fs.rmSync(temporary, { force: true }); } catch {}
  }
}

function transactLedger(root, build, options = {}) {
  if (typeof build !== 'function') throw new TypeError('ledger transaction builder must be a function');
  const lock = acquireLedgerLock(root, options);
  try {
    const beforeEntries = readLedger(root);
    const verified = verifySnapshot(beforeEntries);
    const snapshot = freezeSnapshot(JSON.parse(JSON.stringify(beforeEntries)));
    const expected = Object.freeze({ head: verified.head, sequence: snapshot.length });
    const proposal = build(snapshot, expected);
    if (!proposal || typeof proposal !== 'object' || !proposal.event) {
      throw codedError('LEDGER_TRANSACTION_INVALID', 'ledger transaction must return an event');
    }
    options.fault?.('after-build', { expected });
    const event = redactValue({
      ...proposal.event,
      redactionPolicyVersion: REDACTION_POLICY_VERSION,
    });
    if (!event || typeof event !== 'object' || Array.isArray(event)
      || containsSensitiveMaterial(event)) {
      throw codedError('LEDGER_EVENT_REDACTION_FAILED', 'ledger event failed the secret-free persistence boundary');
    }
    const entry = createEntry(expected.head, event, {
      now: options.now,
      sequence: expected.sequence + 1,
    });
    const next = [...snapshot, entry];
    const persistence = replaceLedger(root, next, expected, options);
    const afterEntries = readLedger(root);
    const committed = verifySnapshot(afterEntries);
    if (committed.head !== entry.hash || afterEntries.length !== expected.sequence + 1) {
      throw codedError('LEDGER_COMMIT_UNCONFIRMED', 'ledger commit could not be confirmed');
    }
    const frozenAfterEntries = freezeSnapshot(afterEntries);
    const postValue = typeof proposal.afterCommit === 'function'
      ? proposal.afterCommit(frozenAfterEntries, entry)
      : undefined;
    return {
      entry,
      beforeEntries: snapshot,
      afterEntries: frozenAfterEntries,
      expected,
      persistence,
      value: proposal.value,
      postValue,
    };
  } finally {
    if (!releaseLedgerLock(lock)) {
      throw codedError('LEDGER_LOCK_OWNER_MISMATCH', 'ledger lock ownership changed before release');
    }
  }
}

function appendEntry(root, event, options = {}) {
  return transactLedger(root, () => ({ event }), options).entry;
}

module.exports = {
  acquireLedgerLock,
  appendEntry,
  flushDirectory,
  ledgerPath,
  lockPath,
  readLedger,
  releaseLedgerLock,
  transactLedger,
};
