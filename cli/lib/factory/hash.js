'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { DEFAULT_IGNORES } = require('./paths');
const { UNITY_GENERATED_DIRS, UNITY_ROOT_DEPTH, hasUnityMarker } = require('./unity');
const { FileHashCache, infraCacheDir } = require('../file-hash-cache');

const DEFAULT_EXCLUDES = new Set([
  '.git', '.factory', 'node_modules', 'vendor', '.venv', '.coverage', 'coverage',
  'playwright-report', 'test-results', '.pytest_cache', '__pycache__',
  '.gradle', '.idea', '_output', 'build', 'dist', 'target',
]);
/**
 * Local working state of the tools, never project source: Factory runs and evidence, harness state and agent worktrees
 * (whole other checkouts: hashed, detected and listed in the SBOM they made the base look like several projects).
 */
const LOCAL_WORKSPACE_PATHS = Object.freeze(['.factory', '.claude/state', '.claude/worktrees']);
const DEFAULT_EXCLUDED_PATHS = new Set(LOCAL_WORKSPACE_PATHS);

function isLocalWorkspacePath(relative) {
  return LOCAL_WORKSPACE_PATHS.some(prefix => relative === prefix || relative.startsWith(`${prefix}/`));
}
// Project-memory journals: the gate and the docs-parity provider check only that they exist, and no code
// reads their text. Test memo keys may leave their content out (ADR-0021); certification never does.
const JOURNAL_PATHS = Object.freeze(['docs/operations', 'tasks']);

/**
 * Child application repositories (`<key>-<version>/`) and `_output/` are local;
 * each child's `_project/` knowledge is base source (ADR-0008, ADR-0018).
 */
function isLocalChildPath(relative) {
  const parts = relative.split('/');
  return parts.length > 2
    && parts[0] === 'app_entry_root'
    && parts[1] !== '_registry'
    && parts[2] !== '_project';
}

function isCityFabricBase(root) {
  return fs.existsSync(path.join(root, 'app_entry_root', '_registry', 'registry.json'));
}

function isGeneratedSkillMirrorPath(relative) {
  return ['.agents/skills', '.claude/skills'].some(
    prefix => relative === prefix || relative.startsWith(`${prefix}/`),
  );
}

function canonicalJson(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  return `{${Object.keys(value).sort().map(k => `${JSON.stringify(k)}:${canonicalJson(value[k])}`).join(',')}}`;
}

function hashValue(value) {
  return crypto.createHash('sha256').update(canonicalJson(value)).digest('hex');
}

/**
 * One walk, several digests: `variants[i]` is a set of extra excluded paths for digest i (the walk enters what the
 * least-excluding variant needs). `hashTree` is the one-variant case, so a pair of keys costs one walk, not two.
 */
function digestTrees(root, options, variants) {
  const canonicalRoot = fs.realpathSync.native(path.resolve(root));
  const cityFabricBase = isCityFabricBase(canonicalRoot);
  const excluded = new Set([...(options.exclude || DEFAULT_EXCLUDES)]);
  const excludedPaths = new Set([...DEFAULT_EXCLUDED_PATHS]);
  const everywhere = [...variants[0]].filter(item => variants.every(set => set.has(item)));
  for (const item of everywhere) excludedPaths.add(item);
  const hashes = variants.map(() => crypto.createHash('sha256'));

  // Unity roots are found in this same walk (it used to be a second full walk, 2.3 s of every certify). The rules are
  // findUnityProjectRoots' own: a directory up to UNITY_ROOT_DEPTH deep, outside DEFAULT_IGNORES, holding the marker;
  // its generated first-level entries are left out. `unityVisible` says whether that finder would have looked here.
  function walk(directory, prefix, live, depth, unityVisible) {
    const all = fs.readdirSync(directory, { withFileTypes: true });
    const unityRoot = unityVisible && hasUnityMarker(directory, all);
    const entries = all
      .filter(entry => !excluded.has(entry.name) && !(unityRoot && UNITY_GENERATED_DIRS.has(entry.name)))
      .sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      const absolute = path.join(directory, entry.name);
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (excludedPaths.has(relative)
        || (cityFabricBase && (isLocalChildPath(relative) || isGeneratedSkillMirrorPath(relative)))) continue;
      const here = live.filter(index => !variants[index].has(relative));
      if (here.length === 0) continue;
      if (entry.isSymbolicLink()) {
        const text = `L\0${relative}\0${fs.readlinkSync(absolute)}\0`;
        for (const index of here) hashes[index].update(text);
      } else if (entry.isDirectory()) {
        walk(absolute, relative, here, depth + 1, unityVisible && depth + 1 <= UNITY_ROOT_DEPTH && !DEFAULT_IGNORES.has(entry.name));
      } else if (entry.isFile()) {
        // options.fileHash (test memo keys only): a per-file digest from a size+mtime cache instead of the bytes. It
        // gives a DIFFERENT digest, so the certification identity never passes it and stays byte-for-byte as before.
        const body = options.fileHash ? `#${options.fileHash(absolute)}` : fs.readFileSync(absolute);
        for (const index of here) hashes[index].update(`F\0${relative}\0`).update(body).update('\0');
      }
    }
  }

  walk(canonicalRoot, '', variants.map((_, index) => index), 0, true);
  return hashes.map(hash => hash.digest('hex'));
}

const TREE_MEMO_ENTRIES = 64;

/**
 * The byte digest of the tree (the certification identity's source hash). It is remembered under a FAST key: the same
 * walk over per-file content digests from a size+mtime cache (FileHashCache). Equal contents give equal fast keys and
 * equal byte digests, so a hit returns exactly what the byte walk would; any content change moves the fast key
 * (ADR-0021 amendment 2026-10-30). INFRA_TREE_HASH_CACHE=0 always walks the bytes. `options.fileHash` asks for the fast
 * digest itself (test memo keys) and is never memoized here.
 */
function hashTree(root, options = {}) {
  const variants = [new Set(options.excludePaths || [])];
  if (options.fileHash || process.env.INFRA_TREE_HASH_CACHE === '0') return digestTrees(root, options, variants)[0];
  const dir = path.join(infraCacheDir(), 'treehash');
  const rootKey = crypto.createHash('sha256').update(fs.realpathSync.native(path.resolve(root))).digest('hex').slice(0, 16);
  const hashes = new FileHashCache(path.join(dir, `files-${rootKey}.json`));
  const fast = digestTrees(root, { ...options, fileHash: absolute => hashes.hashOf(absolute, fs.statSync(absolute)) }, variants)[0];
  const key = crypto.createHash('sha256')
    .update(JSON.stringify([fast, [...(options.exclude || DEFAULT_EXCLUDES)].sort(), [...variants[0]].sort()])).digest('hex');
  const mapFile = path.join(dir, `digests-${rootKey}.json`);
  let map = {};
  try { map = JSON.parse(fs.readFileSync(mapFile, 'utf8')) || {}; } catch { map = {}; }
  hashes.save();
  if (typeof map[key] === 'string' && /^[0-9a-f]{64}$/.test(map[key])) return map[key];
  const bytes = digestTrees(root, options, variants)[0];
  const kept = Object.entries(map).slice(-(TREE_MEMO_ENTRIES - 1));
  const temporary = `${mapFile}.${process.pid}.tmp`;
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(temporary, JSON.stringify(Object.fromEntries([...kept, [key, bytes]])));
    fs.renameSync(temporary, mapFile);
  } catch { try { fs.rmSync(temporary, { force: true }); } catch { /* best effort: the digest is still right */ } }
  return bytes;
}

/** The digests of the whole tree and of the tree without `withoutPaths`, from one walk: `{ tree, without }`. */
function hashTreePair(root, withoutPaths, options = {}) {
  const [tree, without] = digestTrees(root, options, [new Set(options.excludePaths || []), new Set([...(options.excludePaths || []), ...withoutPaths])]);
  return { tree, without };
}

module.exports = {
  JOURNAL_PATHS,
  canonicalJson,
  hashTree,
  hashTreePair,
  hashValue,
  isCityFabricBase,
  isGeneratedSkillMirrorPath,
  isLocalChildPath,
  isLocalWorkspacePath,
};
