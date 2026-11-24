'use strict';

/**
 * Memoized Node test runs (ADR-0021, amended 2026-10-29). A passed test file is stored with the exact inputs it
 * read, found by running it under the read tracer (`test-trace.js`): every repository path any of its Node
 * processes touched (files, directory listings, absent paths) plus its static `require` closure, each with a
 * content fingerprint. The pass is reused only while every fingerprint is unchanged, so an edit to a document the
 * test never reads costs nothing and an edit to a library re-runs exactly the tests that load it.
 *
 * Fallbacks, always towards running more:
 * - a run that started a program other than Node where it can read the repository, or used an fs call the tracer
 *   cannot follow, is stored under the tree key: the base tree hash without the project-memory journals
 *   (`JOURNAL_PATHS`: only their existence is ever checked);
 * - a file that reads the text of the whole repository says so with `node-test-memo: whole-tree` and is keyed by
 *   the complete tree hash;
 * - a run where an input was modified while it ran is not stored at all.
 * Each test file has one entry holding up to MAX_VARIANTS passed variants, so alternating between two states keeps
 * both. Entries hold no paths of the checkout, so worktrees share results. Only passes are ever stored.
 */

const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { JOURNAL_PATHS, hashTree, hashTreePair } = require('./factory/hash');
const trace = require('./test-trace');

const REQUIRE = /require\(\s*['"](\.{1,2}\/[^'"]+)['"]\s*\)/g;
const REPOSITORY_BOUND = /child_process|\bspawn|\bexecFile|\bexecSync|__dirname|__filename|process\.cwd\(/;
const WHOLE_TREE = /node-test-memo: whole-tree/;
const MAX_VARIANTS = 6;
const ENTRY_SCHEMA = 2;

function cacheDir(env = process.env) {
  return env.INFRA_NODE_TEST_CACHE_DIR || path.join(os.homedir(), '.infra-cache', 'nodetests');
}

function resolveLocal(from, request) {
  const base = path.resolve(path.dirname(from), request);
  for (const candidate of [base, `${base}.js`, `${base}.json`, path.join(base, 'index.js')]) {
    try { if (fs.statSync(candidate).isFile()) return candidate; } catch { /* next candidate */ }
  }
  return null;
}

/** Local files reachable from `file` through relative requires, the file included. */
function closure(file) {
  const seen = new Set();
  const stack = [path.resolve(file)];
  while (stack.length) {
    const current = stack.pop();
    if (seen.has(current)) continue;
    seen.add(current);
    if (!current.endsWith('.js')) continue;
    const text = fs.readFileSync(current, 'utf8');
    for (const match of text.matchAll(REQUIRE)) {
      const resolved = resolveLocal(current, match[1]);
      if (resolved) stack.push(resolved);
    }
  }
  return [...seen].sort();
}

/**
 * Tree-level content key of one test file, the fallback of the traced scheme. `codeHash` and `treeHash` return the
 * (memoized) base tree hash without and with the journals; they are called only when needed. A file whose closure
 * touches the repository, or any file with `forceBound`, is keyed by the tree; a pure one by its closure.
 */
function testKey(root, file, {
  codeHash = () => hashTree(root, { excludePaths: JOURNAL_PATHS }),
  treeHash = () => hashTree(root),
  nodeVersion = process.version,
  forceBound = false,
} = {}) {
  const files = closure(path.join(root, file));
  const bound = forceBound || files.some(item => item.endsWith('.js') && REPOSITORY_BOUND.test(fs.readFileSync(item, 'utf8')));
  const wholeTree = WHOLE_TREE.test(fs.readFileSync(path.join(root, file), 'utf8'));
  const hash = crypto.createHash('sha256').update(`${nodeVersion}\0${file.replace(/\\/g, '/')}\0`);
  if (wholeTree) {
    hash.update(`tree\0${treeHash()}`);
  } else if (bound) {
    hash.update(`code\0${codeHash()}`);
  } else {
    for (const item of files) {
      hash.update(path.relative(root, item).replace(/\\/g, '/')).update('\0').update(fs.readFileSync(item)).update('\0');
    }
  }
  return { key: hash.digest('hex'), bound };
}

let saltValue = null;
/** The memo and tracer sources: a change to any of them invalidates every stored entry. */
function memoSalt() {
  if (saltValue === null) {
    saltValue = trace.sha(...[__filename, path.join(__dirname, 'test-trace.js'), trace.PRELOAD,
      path.join(trace.PYTHON_TRACE_DIR, 'sitecustomize.py')].map(file => fs.readFileSync(file)), String(ENTRY_SCHEMA));
  }
  return saltValue;
}

function slash(file) { return file.replace(/\\/g, '/'); }

function entryFile(dir, label, name, nodeVersion = process.version) {
  return path.join(dir, `m-${trace.sha(memoSalt(), nodeVersion, process.platform, label, slash(name))}.json`);
}

function readEntry(dir, label, name, nodeVersion) {
  try {
    const entry = JSON.parse(fs.readFileSync(entryFile(dir, label, name, nodeVersion), 'utf8'));
    return entry && entry.schema === ENTRY_SCHEMA && Array.isArray(entry.variants) ? entry : null;
  } catch { return null; }
}

function writeEntry(dir, label, name, entry, nodeVersion) {
  fs.mkdirSync(dir, { recursive: true });
  const target = entryFile(dir, label, name, nodeVersion);
  const temporary = `${target}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, JSON.stringify(entry));
  fs.renameSync(temporary, target);
}

/** Shared state of one planning pass: lazily computed tree hashes and fingerprints, each at most once. */
function createContext(root, { env = process.env } = {}) {
  let pair = null;
  const dir = cacheDir(env);
  // content hashes of the files the traces name, reused while size and mtime hold (saved by the runner: saveHashes)
  const hashes = new trace.FileHashCache(path.join(dir, `file-hashes-${crypto.createHash('sha256').update(path.resolve(root)).digest('hex').slice(0, 16)}.json`));
  const fileHash = absolute => hashes.hashOf(absolute, fs.statSync(absolute));
  return {
    root,
    dir,
    hashes,
    saveHashes: () => hashes.save(),
    fingerprints: new trace.Fingerprints(root, hashes),
    // both memo keys from ONE walk (the tree and the code tree without the journals); per-file digests from the size+mtime
    // cache (the certification identity hashes bytes and never shares these keys)
    treeHash: () => { pair ??= hashTreePair(root, JOURNAL_PATHS, { fileHash }); return pair.tree; },
    codeHash: () => { pair ??= hashTreePair(root, JOURNAL_PATHS, { fileHash }); return pair.without; },
  };
}

function treeKey(context, file) {
  return testKey(context.root, file, { codeHash: context.codeHash, treeHash: context.treeHash, forceBound: true }).key;
}

function variantMatches(context, name, variant, tree) {
  if (variant.mode === 'tree') return tree !== null && variant.key === treeKey(context, tree);
  if (variant.mode === 'trace') return trace.snapshotMatches(variant.snapshot, context.fingerprints);
  return false;
}

/** The stored variant of `name` that still matches the tree, or null. `treeFile` names the test file for tree keys. */
function findProven(context, label, name, treeFile = null) {
  const entry = readEntry(context.dir, label, name);
  if (!entry) return null;
  return entry.variants.find(variant => variantMatches(context, name, variant, treeFile)) || null;
}

/** Split `files` into already-proven and pending ones. */
function planNodeTests(root, files, { env = process.env, label = 'file', context = createContext(root, { env }) } = {}) {
  const proven = [];
  const pending = [];
  const durations = new Map();
  for (const file of files) {
    const entry = readEntry(context.dir, label, file);
    if (entry && Number.isFinite(entry.ms)) durations.set(file, entry.ms);
    (findProven(context, label, file, file) ? proven : pending).push(file);
  }
  pending.sort((a, b) => (durations.get(b) ?? Infinity) - (durations.get(a) ?? Infinity));
  return { context, dir: context.dir, proven, pending, durations };
}

/**
 * Store a passed run of `name`. `events` is the parsed trace, `staticFiles` the absolute paths of the static
 * closure of the test files that ran, `startedAt` the wall-clock start in ms. Returns the stored mode or null.
 */
function recordPass(context, label, name, { events, staticFiles, startedAt, ms, treeFile, wholeTree = false }) {
  const analysis = trace.analyzeTrace(events, staticFiles.map(file => slash(path.relative(context.root, file))));
  const untraceable = wholeTree || analysis.opaque.length > 0 || analysis.inputs.length === 0;
  let variant;
  if (untraceable) {
    if (!treeFile) return null;
    variant = { mode: 'tree', key: treeKey(context, treeFile), why: wholeTree ? 'whole-tree' : analysis.opaque.slice(0, 5) };
  } else {
    const why = text => {
      if (process.env.INFRA_TEST_TRACE_DEBUG) process.stderr.write(`[node-test-memo] ${slash(name)} not stored: ${text}\n`);
    };
    if (analysis.mutated) {
      why(`it rewrote an input: read ${analysis.mutatedPaths.slice(0, 5).join(', ')}; wrote ${analysis.written.slice(0, 5).join(', ')}`);
      return null;
    }
    // fresh fingerprints: the planning pass may have cached values from before the run
    const captured = trace.captureSnapshot(analysis.inputs, new trace.Fingerprints(context.root, context.hashes), startedAt);
    if (captured.unstable) {
      why(`inputs changed while it ran: ${captured.changed.slice(0, 8).join(', ')}`);
      return null;
    }
    variant = { mode: 'trace', snapshot: captured.snapshot };
  }
  variant.at = new Date().toISOString();
  const previous = readEntry(context.dir, label, name);
  const same = item => item.mode === variant.mode && (item.mode === 'tree'
    ? item.key === variant.key : JSON.stringify(item.snapshot) === JSON.stringify(variant.snapshot));
  const variants = [variant, ...(previous ? previous.variants.filter(item => !same(item)) : [])].slice(0, MAX_VARIANTS);
  writeEntry(context.dir, label, name, { schema: ENTRY_SCHEMA, name: slash(name), ms, variants });
  return variant.mode;
}

/** A stored result blob (the coverage report) for `name` whose inputs are unchanged, or null. */
function findResult(context, label, name, treeFile = null) {
  const variant = findProven(context, label, name, treeFile);
  return variant && typeof variant.result === 'string' ? variant.result : null;
}

function recordResult(context, label, name, args, result) {
  const mode = recordPass(context, label, name, { ...args });
  if (mode === null) return null;
  const entry = readEntry(context.dir, label, name);
  entry.variants[0].result = result;
  writeEntry(context.dir, label, name, entry);
  return mode;
}

module.exports = {
  MAX_VARIANTS,
  REPOSITORY_BOUND,
  WHOLE_TREE,
  cacheDir,
  closure,
  createContext,
  entryFile,
  findProven,
  findResult,
  memoSalt,
  planNodeTests,
  readEntry,
  recordPass,
  recordResult,
  resolveLocal,
  testKey,
  treeKey,
};
