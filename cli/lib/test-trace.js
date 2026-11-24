'use strict';

/**
 * Analysis side of the read tracer (see test-trace-preload.js and ADR-0021, amendment 2026-10-29).
 *
 * A traced run yields the set of repository paths a test (and every Node process it started) looked at. A pass is
 * stored together with a fingerprint of each of them; it is reused only while every fingerprint is unchanged:
 *   file     sha256 of the content        directory   sha256 of its sorted entry names and kinds
 *   absent   a path that did not exist    subtree     sha256 of every name and content below it
 * Paths the run created itself before reading them are outputs, not inputs, and are left out. Anything the tracer
 * cannot follow (a program other than Node started where it can read the repository, an unsupported fs call)
 * makes the run untraceable, and the caller falls back to the whole-tree key.
 */

const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { FileHashCache } = require('./file-hash-cache');
const PRELOAD = path.join(__dirname, 'test-trace-preload.js');
const PYTHON_TRACE_DIR = path.join(__dirname, 'pytrace');
const WIN = process.platform === 'win32';

function sha(...parts) {
  const hash = crypto.createHash('sha256');
  for (const part of parts) hash.update(part).update('\0');
  return hash.digest('hex');
}

/** Environment that makes a Node process (and its Node children) write a trace into `dir`. */
function traceEnv(dir, roots, base = process.env) {
  const env = { ...base };
  const key = Object.keys(env).find(name => (WIN ? name.toUpperCase() : name) === 'NODE_OPTIONS') || 'NODE_OPTIONS';
  const flag = `--require "${PRELOAD.replace(/\\/g, '/')}"`;
  const current = env[key] || '';
  if (!current.includes(PRELOAD.replace(/\\/g, '/'))) env[key] = `${current} ${flag}`.trim();
  env.INFRA_TEST_TRACE_DIR = dir;
  env.INFRA_TEST_TRACE_ROOT = [...new Set(roots)].join(';');
  // Python (as sitecustomize) traces Python runs and children; it hands the Node tracer to Node children.
  const pythonKey = Object.keys(env).find(name => (WIN ? name.toUpperCase() : name) === 'PYTHONPATH') || 'PYTHONPATH';
  const pythonPath = (env[pythonKey] || '').split(path.delimiter).filter(Boolean);
  if (!pythonPath.includes(PYTHON_TRACE_DIR)) env[pythonKey] = [PYTHON_TRACE_DIR, ...pythonPath].join(path.delimiter);
  env.INFRA_TEST_TRACE_NODE_PRELOAD = PRELOAD.replace(/\\/g, '/');
  env.PYTHONDONTWRITEBYTECODE = '1';
  return env;
}

function newTraceDir(prefix = 'infra-trace-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function parseTrace(dir) {
  const events = [];
  let names = [];
  try { names = fs.readdirSync(dir).filter(name => name.endsWith('.trace')); } catch { return events; }
  for (const name of names) {
    let text = '';
    try { text = fs.readFileSync(path.join(dir, name), 'utf8'); } catch { continue; }
    // \r\n as well: a writer in Windows text mode must never leave "\r" on a path (it would name no file, so the
    // fingerprint would never change and a pass would never be invalidated)
    for (const line of text.split(/\r?\n/)) {
      if (!line) continue;
      const first = line.indexOf('\t');
      const second = line.indexOf('\t', first + 1);
      if (first < 1 || second < 0) continue;
      events.push({ kind: line.slice(0, first), time: Number(line.slice(first + 1, second)), text: line.slice(second + 1) });
    }
  }
  return events;
}

/** Inputs of a run: read paths minus the ones the run created first, plus the reasons it cannot be followed. */
function analyzeTrace(events, extraPaths = []) {
  const firstRead = new Map();
  const firstWrite = new Map();
  const opaque = [];
  for (const event of events) {
    if (event.kind === 'R' || event.kind === 'D') {
      const key = `${event.kind === 'D' ? 'D' : 'R'}|${event.text}`;
      const previous = firstRead.get(key);
      if (previous === undefined || event.time < previous) firstRead.set(key, event.time);
    } else if (event.kind === 'W') {
      const previous = firstWrite.get(event.text);
      if (previous === undefined || event.time < previous) firstWrite.set(event.text, event.time);
    } else if (event.kind === 'S' || event.kind === 'X') {
      opaque.push(`${event.kind}:${event.text}`);
    }
  }
  const writtenBefore = (rel, time) => {
    for (const current of ancestorsAndSelf(rel)) {
      const written = firstWrite.get(current);
      if (written !== undefined && written <= time) return true;
    }
    return false;
  };
  const inputs = new Map();
  for (const [key, time] of firstRead) {
    const deep = key[0] === 'D';
    const rel = key.slice(2);
    if (writtenBefore(rel, time)) continue;
    const previous = inputs.get(rel);
    inputs.set(rel, { path: rel, deep: Boolean(previous?.deep) || deep, time: Math.min(previous?.time ?? Infinity, time) });
  }
  for (const extra of extraPaths) {
    const rel = extra.replace(/\\/g, '/');
    if (!inputs.has(rel)) inputs.set(rel, { path: rel, deep: false, time: null });
  }
  // An input the run also writes, lists a directory it adds to, or sits below a path it rewrites: the content stored
  // afterwards is not what the run read, so such a run is never stored.
  const writtenAbove = new Set();
  for (const written of firstWrite.keys()) {
    for (let current = parentOf(written); current !== null; current = parentOf(current)) writtenAbove.add(current);
  }
  const mutatedPaths = [...inputs.keys()].filter(rel => writtenAbove.has(rel) || [...ancestorsAndSelf(rel)].some(item => firstWrite.has(item)));
  return {
    inputs: [...inputs.values()].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0)),
    opaque: [...new Set(opaque)].sort(),
    mutated: mutatedPaths.length > 0,
    // the inputs behind `mutated` and what was written there, so the runner can say why a pass was not kept
    mutatedPaths,
    written: [...firstWrite.keys()].sort(),
  };
}

/**
 * The parent of a traced name, or null above the top: a repository path climbs to '.', an absolute '@' path stops at
 * its drive or root (it never climbs into the repository's '.': a write under a temp folder is not a write to the root).
 */
function parentOf(name) {
  if (name === '.' || name === '') return null;
  const cut = name.lastIndexOf('/');
  if (cut < 0) return name.startsWith('@') ? null : '.';
  return name.slice(0, cut);
}

function* ancestorsAndSelf(rel) {
  for (let current = rel; current !== null; current = parentOf(current)) yield current;
}

class Fingerprints {
  constructor(root, hashes = null) {
    this.root = root;
    this.cache = new Map();
    this.hashes = hashes;
  }

  fileHash(absolute, stat) {
    return this.hashes ? this.hashes.hashOf(absolute, stat) : sha(fs.readFileSync(absolute));
  }

  /** { fp, newest } of one path; `newest` is the latest modification time seen (ms) for the racy-write guard. */
  of(rel, deep) {
    const key = `${deep ? 'D' : 'P'}|${rel}`;
    let value = this.cache.get(key);
    if (!value) {
      value = this.compute(rel, deep);
      this.cache.set(key, value);
    }
    return value;
  }

  compute(rel, deep) {
    const absolute = rel === '.' ? this.root : rel.startsWith('@') ? rel.slice(1) : path.join(this.root, rel);
    let stat;
    try { stat = fs.statSync(absolute); } catch { return { fp: '-', newest: 0 }; }
    if (stat.isFile()) return { fp: `f:${this.fileHash(absolute, stat)}`, newest: stat.mtimeMs };
    if (stat.isDirectory()) return deep ? this.subtree(absolute, stat) : this.listing(absolute, stat);
    return { fp: 'o', newest: stat.mtimeMs };
  }

  listing(absolute, stat) {
    let entries;
    try { entries = fs.readdirSync(absolute, { withFileTypes: true }); } catch { return { fp: '-', newest: 0 }; }
    const lines = entries.map(entry => `${entry.name}\t${entry.isDirectory() ? 'd' : entry.isFile() ? 'f' : 'o'}`).sort();
    return { fp: `d:${sha(lines.join('\n'))}`, newest: stat.mtimeMs };
  }

  subtree(absolute, stat) {
    const hash = crypto.createHash('sha256');
    let newest = stat.mtimeMs;
    const walk = (directory, prefix) => {
      let entries;
      try { entries = fs.readdirSync(directory, { withFileTypes: true }); } catch { hash.update(`?${prefix}\0`); return; }
      entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
      for (const entry of entries) {
        const child = path.join(directory, entry.name);
        const name = `${prefix}${entry.name}`;
        let childStat;
        try { childStat = fs.statSync(child); } catch { hash.update(`-${name}\0`); continue; }
        newest = Math.max(newest, childStat.mtimeMs);
        if (childStat.isDirectory()) { hash.update(`d${name}\0`); walk(child, `${name}/`); }
        else if (childStat.isFile()) hash.update(`f${name}\0${this.fileHash(child, childStat)}\0`);
        else hash.update(`o${name}\0`);
      }
    };
    walk(absolute, '');
    return { fp: `D:${hash.digest('hex')}`, newest };
  }
}

// File times can lag the clock by one tick (about 16 ms on Windows) and node needs about 40 ms to reach the first read.
const CLOCK_SLACK_MS = 20;
const BOOT_MS = 40;

/**
 * Fingerprints of the inputs after a run. `unstable` is true when something an input covers was modified after the
 * run first read it (or within the clock slack before): the test may have read the older content, so the pass is
 * not recorded. Inputs without a read time (the static closure) count from `startedAt` plus the node boot time.
 */
function captureSnapshot(inputs, fingerprints, startedAt) {
  const snapshot = [];
  const changed = [];
  for (const input of inputs) {
    const { fp, newest } = fingerprints.of(input.path, input.deep);
    const readAt = input.time ?? startedAt + BOOT_MS;
    if (newest > readAt - CLOCK_SLACK_MS) changed.push(input.path);
    snapshot.push([input.path, input.deep ? 1 : 0, fp]);
  }
  // `changed` names the inputs that moved, so the runner can say why a pass was not kept
  return { snapshot, unstable: changed.length > 0, changed };
}

function snapshotMatches(snapshot, fingerprints) {
  if (!Array.isArray(snapshot) || snapshot.length === 0) return false;
  return snapshot.every(item => Array.isArray(item) && item.length === 3
    && typeof item[0] === 'string' && fingerprints.of(item[0], item[1] === 1).fp === item[2]);
}

module.exports = {
  FileHashCache,
  Fingerprints,
  PRELOAD,
  PYTHON_TRACE_DIR,
  analyzeTrace,
  captureSnapshot,
  newTraceDir,
  parseTrace,
  sha,
  snapshotMatches,
  traceEnv,
};
