'use strict';

/**
 * Content-addressed test-result cache for Cargo workspaces (ADR-0021).
 *
 * A package's input digest covers: its own files, the digests of every workspace package it depends on
 * (recursively), every repository file outside package directories except documentation (manifests,
 * lockfile, migrations, query metadata, OpenAPI, fixtures — anything a test may read), the toolchain
 * version and the exact test command. A package whose digest already passed is skipped; the rest run in
 * one invocation and are recorded only when the whole invocation passes. Keys hold no path, so every
 * worktree of the same content shares the cache. Memoization, not parallelism, is what removes work.
 */

const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync, spawn } = require('node:child_process');
const { cargoMembers, closure, changedFiles, select } = require('./impacted');

const DOCS = [/\.md$/i, /^docs\//, /^\.github\//, /(^|\/)LICENSE[^/]*$/i];

function cacheRoot(env = process.env) {
  return env.INFRA_TESTCACHE_DIR || path.join(os.homedir(), '.infra-cache', 'testcache');
}

function trackedFiles(repo, run = spawnSync) {
  const result = run('git', ['-C', repo, 'ls-files', '-z', '--cached', '--others', '--exclude-standard'], { encoding: 'utf8', shell: false, maxBuffer: 256 * 1024 * 1024 });
  if (result.status !== 0) throw new Error(`git ls-files failed: ${(result.stderr || '').trim()}`);
  return result.stdout.split('\0').filter(Boolean).map(file => file.replace(/\\/g, '/')).sort();
}

function hashFiles(repo, files) {
  const hash = crypto.createHash('sha256');
  for (const file of files) {
    let content;
    try { content = fs.readFileSync(path.join(repo, file)); } catch { content = Buffer.from('<missing>'); }
    hash.update(`${file}\0`).update(content).update('\0');
  }
  return hash.digest('hex');
}

/** Input digest of every member; `context` (toolchain + command) is mixed into each one. */
function digests(repo, members, files, context) {
  const byMember = new Map(members.map(member => [member.name, []]));
  const shared = [];
  const sorted = [...members].filter(member => member.dir).sort((a, b) => b.dir.length - a.dir.length);
  for (const file of files) {
    const member = sorted.find(candidate => file.startsWith(`${candidate.dir}/`));
    if (member) byMember.get(member.name).push(file);
    else if (!DOCS.some(pattern => pattern.test(file))) shared.push(file);
  }
  const base = crypto.createHash('sha256').update(context).update('\0').update(hashFiles(repo, shared)).digest('hex');
  const own = new Map(members.map(member => [member.name, hashFiles(repo, byMember.get(member.name))]));
  const result = new Map();
  const visiting = new Set();
  const index = new Map(members.map(member => [member.name, member]));
  const digestOf = name => {
    if (result.has(name)) return result.get(name);
    if (visiting.has(name)) throw new Error(`dependency cycle at ${name}`);
    visiting.add(name);
    const member = index.get(name);
    const hash = crypto.createHash('sha256').update(base).update(own.get(name));
    for (const dep of [...member.deps].sort()) hash.update(digestOf(dep));
    visiting.delete(name);
    const value = hash.update(name).digest('hex');
    result.set(name, value);
    return value;
  };
  for (const member of members) digestOf(member.name);
  return result;
}

function marker(root, digest) {
  return path.join(root, digest.slice(0, 2), `${digest}.pass`);
}

function isCached(root, digest) {
  return fs.existsSync(marker(root, digest));
}

function record(root, digest, info) {
  const file = marker(root, digest);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ at: new Date().toISOString(), ...info }));
}

function toolchain(repo, run = spawnSync) {
  const result = run('rustc', ['-Vv'], { cwd: repo, encoding: 'utf8', shell: false });
  return result.status === 0 ? result.stdout.trim() : 'rustc-unknown';
}

/**
 * Plan a run: which members are selected, which are already proven, and the argv for the rest.
 * `runner` is `nextest` or `test`; `extra` are appended test arguments (part of the cache key).
 */
function plan(repo, { all = false, base, runner = 'nextest', extra = [], env = process.env, run = spawnSync } = {}) {
  const members = cargoMembers(repo, run);
  const files = trackedFiles(repo, run);
  const selection = all ? { all: true, members: members.map(m => m.name) } : select(changedFiles(repo, base), members, []);
  const selected = selection ? selection.members : [];
  const command = runner === 'nextest' ? ['nextest', 'run'] : ['test'];
  const context = JSON.stringify({ toolchain: toolchain(repo, run), command, extra, features: env.INFRA_TESTCACHE_SALT || '' });
  const map = digests(repo, members, files, context);
  const root = cacheRoot(env);
  const cached = selected.filter(name => isCached(root, map.get(name)));
  const pending = selected.filter(name => !cached.includes(name));
  const argv = pending.length ? ['cargo', ...command, ...pending.flatMap(name => ['-p', name]), ...extra] : null;
  return { root, members: members.length, selected, cached, pending, argv, digests: map };
}

const USAGE = 'usage: infra testcache cargo [--repo DIR] [--all | --base REF] [--runner nextest|test] [--dry-run] [-- <extra test args>]';

async function testcacheMain(args, { cwd = process.cwd(), env = process.env, out = console.log, err = console.error, run = spawnSync, exec = spawn } = {}) {
  const separator = args.indexOf('--');
  const options = separator >= 0 ? args.slice(0, separator) : args;
  const extra = separator >= 0 ? args.slice(separator + 1) : [];
  const value = name => { const index = options.indexOf(name); return index >= 0 ? options[index + 1] : undefined; };
  if (options[0] !== 'cargo') { err(USAGE); return 2; }
  const runner = value('--runner') || 'nextest';
  if (!['nextest', 'test'].includes(runner)) { err(USAGE); return 2; }
  const repo = path.resolve(cwd, value('--repo') || '.');
  let result;
  try {
    result = plan(repo, { all: options.includes('--all'), base: value('--base'), runner, extra, env, run });
  } catch (error) {
    err(`[testcache] ${error.message}`);
    return 1;
  }
  out(`[testcache] ${result.selected.length} selected of ${result.members}; ${result.cached.length} already proven, ${result.pending.length} to run`);
  if (result.cached.length) out(`[testcache] skipped: ${result.cached.join(' ')}`);
  if (!result.argv) return 0;
  out(`[testcache] $ ${result.argv.join(' ')}`);
  if (options.includes('--dry-run')) return 0;
  const code = await new Promise(resolve => {
    const child = exec(result.argv[0], result.argv.slice(1), { cwd: repo, stdio: 'inherit', env, shell: false });
    child.on('error', error => { err(`[testcache] ${error.message}`); resolve(127); });
    child.on('exit', (exit, signal) => resolve(exit ?? (signal ? 1 : 0)));
  });
  if (code === 0) {
    for (const name of result.pending) record(result.root, result.digests.get(name), { package: name, runner });
    out(`[testcache] recorded ${result.pending.length} passing package(s)`);
  }
  return code;
}

module.exports = { DOCS, USAGE, cacheRoot, digests, hashFiles, isCached, plan, record, testcacheMain, trackedFiles };
