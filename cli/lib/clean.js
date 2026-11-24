'use strict';

/**
 * Automatic disk hygiene (ADR-0021). Build outputs are caches: a target directory nobody touched for
 * `idleHours` is removed whole; in the rest, `incremental` caches are removed (queued builds run
 * non-incremental, so they only waste space). Docker: build cache older than a day, dangling images and
 * stopped one-off test databases (label `infra.testdb=1`); volumes are never touched except those.
 * Roots come from the local machine config `~/.infra-cache/clean.json` ({"roots": [...], "keep": [...],
 * "idleHours": 48}) so tracked code holds no machine paths. Runs automatically after queued jobs at most
 * once per `intervalHours`.
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');

const STATE_DIR = env => env.INFRA_CLEAN_DIR || path.join(os.homedir(), '.infra-cache');
const MARKERS = ['CACHEDIR.TAG', '.rustc_info.json', 'debug', 'release'];

function loadConfig(env = process.env) {
  try {
    const config = JSON.parse(fs.readFileSync(path.join(STATE_DIR(env), 'clean.json'), 'utf8'));
    return { roots: config.roots || [], keep: config.keep || [], idleHours: config.idleHours || 48, intervalHours: config.intervalHours || 6 };
  } catch {
    return { roots: [], keep: [], idleHours: 48, intervalHours: 6 };
  }
}

function mtime(file) {
  try { return fs.statSync(file).mtimeMs; } catch { return 0; }
}

/** Newest modification among the places a build writes; 0 when the directory is not a build output. */
function lastUsed(dir) {
  if (!MARKERS.some(marker => fs.existsSync(path.join(dir, marker)))) return 0;
  return Math.max(...[dir, path.join(dir, '.rustc_info.json'), path.join(dir, 'debug'), path.join(dir, 'debug', 'deps'),
    path.join(dir, 'debug', '.fingerprint'), path.join(dir, 'llvm-cov-target')].map(mtime));
}

function sizeOf(dir) {
  let total = 0;
  const stack = [dir];
  while (stack.length) {
    const current = stack.pop();
    let entries;
    try { entries = fs.readdirSync(current, { withFileTypes: true }); } catch { continue; }
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) stack.push(full);
      else { try { total += fs.statSync(full).size; } catch { /* vanished */ } }
    }
  }
  return total;
}

function remove(dir, measure) {
  const bytes = measure ? sizeOf(dir) : 0;
  fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
  return bytes;
}

/** Plan and (unless dryRun) apply the target-directory policy. */
function cleanTargets({ roots, keep = [], idleHours = 48, now = Date.now(), dryRun = false, busy = () => false, measure = true }) {
  const actions = [];
  for (const root of roots) {
    let entries;
    try { entries = fs.readdirSync(root, { withFileTypes: true }); } catch { continue; }
    for (const entry of entries.filter(item => item.isDirectory())) {
      const dir = path.join(root, entry.name);
      const used = lastUsed(dir);
      // A directory written in the last 15 minutes may have a build running in it: leave it alone.
      if (!used || keep.includes(entry.name) || busy(dir) || now - used < 15 * 60_000) continue;
      if (now - used > idleHours * 3600_000) {
        actions.push({ action: 'remove', dir, bytes: dryRun ? 0 : remove(dir, measure) });
        continue;
      }
      for (const incremental of [path.join(dir, 'debug', 'incremental'), path.join(dir, 'llvm-cov-target', 'debug', 'incremental')]) {
        if (fs.existsSync(incremental)) actions.push({ action: 'drop-incremental', dir: incremental, bytes: dryRun ? 0 : remove(incremental, measure) });
      }
    }
  }
  return actions;
}

function cleanDocker(run = spawnSync) {
  const docker = args => run('docker', args, { encoding: 'utf8', shell: false });
  const results = [];
  results.push(['builder prune', docker(['builder', 'prune', '-f', '--filter', 'until=24h']).status]);
  results.push(['image prune', docker(['image', 'prune', '-f']).status]);
  const stopped = docker(['ps', '-a', '-q', '--filter', 'label=infra.testdb=1', '--filter', 'status=exited']);
  const ids = (stopped.stdout || '').split(/\s+/).filter(Boolean);
  if (ids.length) results.push(['remove stopped test databases', docker(['rm', '-v', ...ids]).status]);
  return results;
}

/** Called after queued jobs: start a detached clean at most once per interval. */
function maybeAutoClean({ env = process.env, now = Date.now(), launch } = {}) {
  if (env.INFRA_AUTO_CLEAN === '0') return false;
  const config = loadConfig(env);
  if (!config.roots.length) return false;
  const stamp = path.join(STATE_DIR(env), 'clean.stamp');
  if (now - mtime(stamp) < config.intervalHours * 3600_000) return false;
  fs.mkdirSync(path.dirname(stamp), { recursive: true });
  fs.writeFileSync(stamp, new Date(now).toISOString());
  const start = launch || (() => {
    const child = spawn(process.execPath, [path.join(__dirname, '..', 'bin', 'infra.js'), 'clean', 'all', '--quiet'],
      { detached: true, stdio: 'ignore', windowsHide: true, env });
    child.unref();
  });
  start();
  return true;
}

const USAGE = 'usage: infra clean <targets|docker|all> [--dry-run] [--idle-hours N] [--quiet]';

function cleanMain(args, { env = process.env, out = console.log, err = console.error, run = spawnSync, busy = () => false } = {}) {
  const [scope] = args;
  if (!['targets', 'docker', 'all'].includes(scope)) { err(USAGE); return 2; }
  const config = loadConfig(env);
  const index = args.indexOf('--idle-hours');
  const idleHours = index >= 0 ? Number(args[index + 1]) || config.idleHours : config.idleHours;
  const quiet = args.includes('--quiet');
  if (scope !== 'docker') {
    if (!config.roots.length) err('[clean] no roots configured in ~/.infra-cache/clean.json');
    const actions = cleanTargets({ roots: config.roots, keep: config.keep, idleHours, dryRun: args.includes('--dry-run'), busy });
    const freed = actions.reduce((sum, item) => sum + item.bytes, 0);
    if (!quiet) for (const item of actions) out(`[clean] ${item.action} ${item.dir}`);
    out(`[clean] targets: ${actions.length} action(s), freed ${(freed / 1024 ** 3).toFixed(1)} GB`);
  }
  if (scope !== 'targets' && !args.includes('--dry-run')) {
    for (const [name, status] of cleanDocker(run)) if (!quiet || status !== 0) out(`[clean] docker ${name}: ${status === 0 ? 'ok' : `exit ${status}`}`);
  }
  return 0;
}

module.exports = { USAGE, cleanDocker, cleanMain, cleanTargets, lastUsed, loadConfig, maybeAutoClean, sizeOf };
