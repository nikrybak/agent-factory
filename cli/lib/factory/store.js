'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { assertPathIdentity, readOpenedFile } = require('./filesystem-boundary');

function codedError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function projectRoot(root) {
  const resolved = path.resolve(root);
  if (!fs.existsSync(resolved) || !fs.statSync(resolved).isDirectory()) {
    throw new Error(`project root is not a directory: ${resolved}`);
  }
  return fs.realpathSync.native(resolved);
}

function resolveWithinRoot(root, relativePath, options = {}) {
  const canonicalRoot = projectRoot(root);
  if (typeof relativePath !== 'string' || relativePath.includes('\0')) {
    throw new Error('path must be a safe relative string');
  }
  if (path.isAbsolute(relativePath)) throw new Error('absolute path is not allowed');
  const target = path.resolve(canonicalRoot, relativePath);
  const relative = path.relative(canonicalRoot, target);
  if (relative === '' && !options.allowRoot) throw new Error('operation on project root itself is not allowed');
  if (relative.startsWith(`..${path.sep}`) || relative === '..' || path.isAbsolute(relative)) {
    throw new Error(`path resolves outside project root: ${relativePath}`);
  }

  // Existing symlinks (or an existing ancestor) must also remain under the root.
  let ancestor = target;
  while (!fs.existsSync(ancestor)) {
    const parent = path.dirname(ancestor);
    if (parent === ancestor) break;
    ancestor = parent;
  }
  const realAncestor = fs.realpathSync.native(ancestor);
  const realRelative = path.relative(canonicalRoot, realAncestor);
  if (realRelative.startsWith(`..${path.sep}`) || realRelative === '..' || path.isAbsolute(realRelative)) {
    throw new Error(`path crosses a symlink outside project root: ${relativePath}`);
  }
  return target;
}

function atomicWriteJson(root, relativePath, value) {
  const destination = resolveWithinRoot(root, relativePath);
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  const temporary = path.join(
    path.dirname(destination),
    `.${path.basename(destination)}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`
  );
  try {
    fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}${os.EOL}`, { encoding: 'utf8', flag: 'wx' });
    fs.renameSync(temporary, destination);
  } finally {
    fs.rmSync(temporary, { force: true });
  }
  return destination;
}

function readJson(root, relativePath, fallback = null) {
  const file = resolveWithinRoot(root, relativePath);
  if (!fs.existsSync(file)) return fallback;
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function safeId(value, label) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value)) {
    throw new Error(`${label} must be a safe identifier`);
  }
  return value;
}

function canonicalTimestamp(value) {
  if (typeof value !== 'string') return false;
  const epoch = Date.parse(value);
  return Number.isFinite(epoch) && new Date(epoch).toISOString() === value;
}

function validRunLock(value, runId, token) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const keys = Object.keys(value).sort();
  const expectedKeys = ['acquiredAt', 'expiresAt', 'runId', 'schemaVersion', 'stepId', 'token'];
  if (JSON.stringify(keys) !== JSON.stringify(expectedKeys)
    || value.schemaVersion !== '1.0.0'
    || value.runId !== runId
    || typeof value.stepId !== 'string'
    || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value.stepId)
    || typeof value.token !== 'string'
    || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value.token)
    || value.token !== token
    || !canonicalTimestamp(value.acquiredAt)
    || !canonicalTimestamp(value.expiresAt)
    || Date.parse(value.expiresAt) <= Date.parse(value.acquiredAt)) return false;
  return true;
}

class FactoryStore {
  constructor(root) {
    this.root = projectRoot(root);
  }

  writePlan(runId, plan) {
    safeId(runId, 'runId');
    return atomicWriteJson(this.root, `.factory/runs/${runId}/plan.json`, plan);
  }

  readPlan(runId) {
    safeId(runId, 'runId');
    return readJson(this.root, `.factory/runs/${runId}/plan.json`);
  }

  writeCheckpoint(runId, checkpoint) {
    if (checkpoint === undefined) {
      checkpoint = runId;
      return atomicWriteJson(this.root, '.factory/checkpoint.json', checkpoint);
    }
    safeId(runId, 'runId');
    return atomicWriteJson(this.root, `.factory/runs/${runId}/checkpoint.json`, checkpoint);
  }

  readCheckpoint(runId) {
    if (runId === undefined) return readJson(this.root, '.factory/checkpoint.json');
    safeId(runId, 'runId');
    return readJson(this.root, `.factory/runs/${runId}/checkpoint.json`);
  }

  writeEvidence(runId, evidence) {
    safeId(runId, 'runId');
    safeId(evidence.stepId, 'stepId');
    if (!Number.isSafeInteger(evidence.attempt) || evidence.attempt < 1) {
      throw new Error('attempt must be a positive integer');
    }
    const attempt = String(evidence.attempt).padStart(6, '0');
    return atomicWriteJson(
      this.root,
      `.factory/runs/${runId}/evidence/${evidence.stepId}/${attempt}.json`,
      evidence
    );
  }

  listEvidence(runId) {
    safeId(runId, 'runId');
    const root = resolveWithinRoot(this.root, `.factory/runs/${runId}/evidence`);
    if (!fs.existsSync(root)) return [];
    const evidence = [];
    for (const step of fs.readdirSync(root, { withFileTypes: true })) {
      if (!step.isDirectory()) continue;
      for (const entry of fs.readdirSync(path.join(root, step.name), { withFileTypes: true })) {
        if (entry.isFile() && entry.name.endsWith('.json')) {
          evidence.push(JSON.parse(fs.readFileSync(path.join(root, step.name, entry.name), 'utf8')));
        }
      }
    }
    return evidence.sort((a, b) => a.attempt - b.attempt || a.stepId.localeCompare(b.stepId));
  }

  acquireRunLock(runId, stepId, options = {}) {
    safeId(runId, 'runId');
    safeId(stepId, 'stepId');
    const now = options.now ?? Date.now();
    const ttlMs = options.ttlMs || 10 * 60 * 1000;
    const relative = `.factory/runs/${runId}/lock.json`;
    const file = resolveWithinRoot(this.root, relative);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const lock = {
      schemaVersion: '1.0.0', runId, stepId,
      token: crypto.randomUUID(),
      acquiredAt: new Date(now).toISOString(),
      expiresAt: new Date(now + ttlMs).toISOString(),
    };
    let descriptor;
    try {
      descriptor = fs.openSync(file, 'wx', 0o600);
      fs.writeFileSync(descriptor, `${JSON.stringify(lock, null, 2)}${os.EOL}`, 'utf8');
      fs.fsyncSync(descriptor);
    } catch (error) {
      if (['EACCES', 'EBUSY', 'EEXIST', 'EPERM'].includes(error?.code)) {
        throw codedError('RUN_LOCK_HELD', 'workflow run lock is already held');
      }
      throw error;
    } finally {
      if (descriptor !== undefined) fs.closeSync(descriptor);
    }
    return lock;
  }

  hasRunLock(runId) {
    safeId(runId, 'runId');
    try {
      return fs.existsSync(resolveWithinRoot(this.root, `.factory/runs/${runId}/lock.json`));
    } catch {
      return true;
    }
  }

  releaseRunLock(runId, token, options = {}) {
    safeId(runId, 'runId');
    const relative = `.factory/runs/${runId}/lock.json`;
    try {
      const file = resolveWithinRoot(this.root, relative);
      const opened = readOpenedFile(this.root, relative, {
        maxBytes: 64 * 1024,
        fault: options.fault,
      });
      const existing = JSON.parse(opened.buffer.toString('utf8'));
      if (!validRunLock(existing, runId, token)) {
        throw codedError('RUN_LOCK_OWNER_MISMATCH', 'workflow run lock ownership is not confirmed');
      }
      assertPathIdentity(this.root, relative, opened.identity, { fault: options.beforeUnlink });
      fs.unlinkSync(file);
      return true;
    } catch (error) {
      if (error?.code === 'RUN_LOCK_OWNER_MISMATCH') throw error;
      throw codedError('RUN_LOCK_OWNER_MISMATCH', 'workflow run lock ownership is not confirmed');
    }
  }
}

module.exports = { FactoryStore, atomicWriteJson, readJson, resolveWithinRoot };
