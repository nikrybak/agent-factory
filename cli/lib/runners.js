'use strict';

/**
 * Local GitHub Actions runners for the owner's private repositories (ADR-0022). Every repository keeps
 * `minSlotsPerRepo` ephemeral just-in-time runners online; each takes exactly one job and is replaced by a
 * fresh one. When jobs wait, the supervisor adds slots up to `maxSlotsPerRepo` per repository and `maxSlots`
 * in total, and removes an extra slot once it has been idle for `idleMinutes`. A slot is a pair of containers like an ARC "dind" pod: the runner and its own Docker daemon,
 * sharing the network namespace (service containers answer on localhost as on GitHub's VMs) and the work
 * volume (container jobs mount the workspace). Runners carry GitHub's own labels (`ubuntu-latest`,
 * `ubuntu-24.04`), so workflows stay unchanged and jobs run here instead of using hosted minutes.
 *
 * Machine settings live in `~/.infra-cache/runners.json` (no machine paths in tracked code); the GitHub
 * token never leaves the gh CLI: the supervisor asks gh for a one-job registration and hands it to the
 * container through the environment.
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const childProcess = require('node:child_process');

const USAGE = 'usage: infra runners <build | up | down | status | run | install | uninstall>';
const LABEL = 'infra.runners';
const NAME_PREFIX = 'infra-';
const DOCKER_GROUP_ID = 123;
const STATE_DIR = env => env.INFRA_CLEAN_DIR || path.join(os.homedir(), '.infra-cache');
const TASK_NAME = 'Infra GitHub Runners';
/** The repository variable workflows read in `runs-on: ${{ fromJSON(vars.CI_RUNNER || '"ubuntu-24.04"') }}`. */
const RUNNER_VARIABLE = 'CI_RUNNER';
const LOCAL_TARGET = JSON.stringify(['self-hosted', 'infra-local']);

const DEFAULTS = Object.freeze({
  owner: null,
  gh: 'gh',
  ghConfigDir: null,
  repos: null,
  exclude: [],
  minSlotsPerRepo: 1,
  maxSlotsPerRepo: 3,
  maxSlots: 8,
  idleMinutes: 5,
  demandSeconds: 30,
  labels: ['ubuntu-latest', 'ubuntu-24.04'],
  image: 'infra-gh-runner:local',
  dindImage: 'docker:28-dind',
  cpus: 6,
  memory: '8g',
  pollSeconds: 10,
  discoverMinutes: 10,
  pruneHours: 24,
  runtimeDir: null,
});

function loadConfig(env = process.env) {
  let local = {};
  try {
    local = JSON.parse(fs.readFileSync(path.join(STATE_DIR(env), 'runners.json'), 'utf8'));
  } catch {
    local = {};
  }
  const config = { ...DEFAULTS, ...local };
  config.runtimeDir = config.runtimeDir || path.join(STATE_DIR(env), 'runners');
  return Object.freeze(config);
}

/** A Docker-safe slot key for a repository: `ghr-<repo>-<n>`. */
function slotName(repo, index) {
  return `ghr-${repo.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')}-${index}`;
}

/** Slots 1..n of every repository; `counts` is one number for all or a count per repository. */
function desiredSlots(repos, counts) {
  const slots = [];
  for (const repo of [...repos].sort()) {
    const n = typeof counts === 'number' ? counts : counts[repo] || 0;
    for (let index = 1; index <= n; index += 1) slots.push({ repo, index, name: slotName(repo, index) });
  }
  return slots;
}

/**
 * How many slots each repository gets. `warm[repo]` lists the slot numbers that ran a job (or started) within
 * `idleMinutes` and must stay; `demand[repo]` counts jobs waiting for a local runner. Each repository keeps
 * at least `minSlotsPerRepo`, gets one slot per waiting job up to `maxSlotsPerRepo`, and the extras are
 * trimmed, largest repository first, until the total fits `maxSlots`. A warm slot is never trimmed.
 */
function slotCounts(repos, { demand = {}, warm = {} }, config) {
  const topWarm = repo => Math.max(0, ...(warm[repo] || []));
  const counts = {};
  for (const repo of repos) {
    const need = (warm[repo] || []).length + (demand[repo] || 0);
    counts[repo] = Math.max(topWarm(repo), Math.min(config.maxSlotsPerRepo, Math.max(config.minSlotsPerRepo, need)));
  }
  let total = Object.values(counts).reduce((a, b) => a + b, 0);
  while (total > config.maxSlots) {
    const trimmable = repos.filter(r => counts[r] > Math.max(config.minSlotsPerRepo, topWarm(r)))
      .sort((a, b) => counts[b] - counts[a] || a.localeCompare(b));
    if (!trimmable.length) break;
    counts[trimmable[0]] -= 1;
    total -= 1;
  }
  return counts;
}

/** Labels of a just-in-time runner: GitHub's hosted labels plus a marker that the job ran here. */
function jitLabels(config) {
  return [...new Set(['self-hosted', 'Linux', 'X64', ...config.labels, 'infra-local'])];
}

function slotLabels(slot, role) {
  return ['--label', `${LABEL}=1`, '--label', `${LABEL}.slot=${slot.name}`, '--label', `${LABEL}.repo=${slot.repo}`,
    '--label', `${LABEL}.role=${role}`];
}

function dindArgs(slot, config) {
  return ['run', '-d', '--name', `${slot.name}-dind`, '--privileged', '--restart', 'unless-stopped',
    ...slotLabels(slot, 'dind'),
    '--cpus', String(config.cpus), '--memory', config.memory,
    '-e', 'DOCKER_TLS_CERTDIR=',
    '-v', `${slot.name}-work:/home/runner/_work`,
    '-v', `${slot.name}-sock:/var/run`,
    '-v', `${slot.name}-docker:/var/lib/docker`,
    config.dindImage, 'dockerd', '--host=unix:///var/run/docker.sock', `--group=${DOCKER_GROUP_ID}`];
}

function runnerArgs(slot, config) {
  return ['run', '-d', '--name', slot.name, '--network', `container:${slot.name}-dind`,
    ...slotLabels(slot, 'runner'),
    '--cpus', String(config.cpus), '--memory', config.memory,
    '-e', 'INFRA_RUNNER_JITCONFIG', '-e', 'DOCKER_HOST=unix:///var/run/docker.sock',
    '-v', `${slot.name}-work:/home/runner/_work`,
    '-v', `${slot.name}-sock:/var/run`,
    '-v', `${slot.name}-toolcache:/opt/hostedtoolcache`,
    '-v', `${slot.name}-gradle:/home/runner/.gradle`,
    '-v', 'ghr-cargo-registry:/home/runner/.cargo/registry',
    config.image];
}

/**
 * What to change so the containers match the slots. `containers` are `{name, state, slot, role}` of every
 * container labelled `infra.runners`. A slot whose runner finished its job (or whose daemon stopped) is
 * recreated whole, like an ARC pod: runner and daemon removed (with every container the job left in it),
 * the work volume emptied, then a fresh daemon and runner. The daemon's image cache is a separate volume.
 */
function reconcile(slots, containers) {
  const byName = new Map(containers.map(c => [c.name, c]));
  const wanted = new Set(slots.flatMap(s => [s.name, `${s.name}-dind`]));
  const actions = [];
  for (const c of containers) {
    if (!wanted.has(c.name)) actions.push({ kind: 'remove', name: c.name });
  }
  for (const slot of slots) {
    const dind = byName.get(`${slot.name}-dind`);
    const runner = byName.get(slot.name);
    if (dind && dind.state === 'running' && runner && runner.state === 'running') continue;
    if (runner) actions.push({ kind: 'remove', name: runner.name });
    if (dind) actions.push({ kind: 'remove', name: dind.name });
    actions.push({ kind: 'fresh', slot });
    actions.push({ kind: 'dind', slot });
    actions.push({ kind: 'runner', slot });
  }
  return actions;
}

/** Repositories that get runners: private, active, with workflows (public repositories never: fork PRs). */
function selectRepos(repos, config) {
  const exclude = new Set(config.exclude);
  return repos
    .filter(r => r.private && !r.archived && !r.disabled && r.workflows > 0 && !exclude.has(r.name))
    .filter(r => !config.repos || config.repos.includes(r.name))
    .map(r => r.name)
    .sort();
}

// ------------------------------------------------------------------------------------------- effects

function ghEnv(config, extra = {}) {
  const env = { ...process.env, ...extra };
  if (config.ghConfigDir) env.GH_CONFIG_DIR = config.ghConfigDir;
  return env;
}

function gh(config, args) {
  const r = childProcess.spawnSync(config.gh, args, { encoding: 'utf8', env: ghEnv(config), windowsHide: true, maxBuffer: 16 << 20 });
  if (r.status !== 0) throw new Error(`gh ${args.slice(0, 3).join(' ')} failed: ${(r.stderr || '').trim().split('\n')[0]}`);
  return r.stdout.trim() ? JSON.parse(r.stdout) : null;
}

function docker(args, options = {}) {
  return childProcess.spawnSync('docker', args, { encoding: 'utf8', windowsHide: true, ...options });
}

function listContainers() {
  const r = docker(['ps', '-a', '--filter', `label=${LABEL}=1`, '--format', '{{json .}}']);
  if (r.status !== 0) throw new Error(`docker is not available: ${(r.stderr || '').trim().split('\n')[0]}`);
  return r.stdout.split('\n').filter(Boolean).map(line => {
    const c = JSON.parse(line);
    const labels = Object.fromEntries((c.Labels || '').split(',').map(kv => kv.split('=')));
    return { name: c.Names, state: c.State, slot: labels[`${LABEL}.slot`], repo: labels[`${LABEL}.repo`], role: labels[`${LABEL}.role`] };
  });
}

function discoverRepos(config) {
  const repos = gh(config, ['api', '--paginate', '--slurp', 'user/repos?affiliation=owner&per_page=100']).flat();
  return repos.filter(r => r.owner.login === config.owner && r.private && !r.archived).map(r => {
    let workflows = 0;
    try {
      workflows = gh(config, ['api', `repos/${config.owner}/${r.name}/actions/workflows`]).total_count;
    } catch {
      workflows = 0;
    }
    return { name: r.name, private: r.private, archived: r.archived, disabled: r.disabled, workflows };
  });
}

function jitConfig(config, slot) {
  const name = `${NAME_PREFIX}${slot.name.slice(4)}-${Date.now().toString(36)}`;
  const args = ['api', '-X', 'POST', `repos/${config.owner}/${slot.repo}/actions/runners/generate-jitconfig`,
    '-f', `name=${name}`, '-F', 'runner_group_id=1', '-f', 'work_folder=_work'];
  for (const label of jitLabels(config)) args.push('-f', `labels[]=${label}`);
  return { name, encoded: gh(config, args).encoded_jit_config };
}

/** Offline runners this machine registered whose container is gone (a slot killed before its job). */
function removeStaleRunners(config, repo, log) {
  const listed = gh(config, ['api', `repos/${config.owner}/${repo}/actions/runners?per_page=100`]);
  for (const r of listed.runners || []) {
    if (r.name.startsWith(NAME_PREFIX) && r.status === 'offline') {
      gh(config, ['api', '-X', 'DELETE', `repos/${config.owner}/${repo}/actions/runners/${r.id}`]);
      log(`removed stale runner ${r.name} of ${repo}`);
    }
  }
}

/**
 * Points the repository's jobs at the local runners. GitHub never prefers a self-hosted runner over its own
 * VMs for a hosted label, so workflows read this variable; without it they fall back to the hosted image.
 */
function routeToLocal(config, repo, log) {
  const base = `repos/${config.owner}/${repo}/actions/variables`;
  let current = null;
  try {
    current = gh(config, ['api', `${base}/${RUNNER_VARIABLE}`]).value;
  } catch {
    current = null;
  }
  if (current === LOCAL_TARGET) return;
  if (current === null) gh(config, ['api', '-X', 'POST', base, '-f', `name=${RUNNER_VARIABLE}`, '-f', `value=${LOCAL_TARGET}`]);
  else gh(config, ['api', '-X', 'PATCH', `${base}/${RUNNER_VARIABLE}`, '-f', `value=${LOCAL_TARGET}`]);
  log(`${repo}: jobs now run on the local runners (${RUNNER_VARIABLE})`);
}

/** Sends the repository's jobs back to GitHub's VMs (the workflows' fallback label). */
function routeToHosted(config, repo, log) {
  try {
    gh(config, ['api', '-X', 'DELETE', `repos/${config.owner}/${repo}/actions/variables/${RUNNER_VARIABLE}`]);
    log(`${repo}: jobs go back to GitHub-hosted runners`);
  } catch {
    // no variable: already hosted
  }
}

/** Jobs of the repository that wait for a local runner (queued, addressed to `infra-local`). */
function waitingJobs(config, repo) {
  let waiting = 0;
  for (const status of ['queued', 'in_progress']) {
    const runs = gh(config, ['api', `repos/${config.owner}/${repo}/actions/runs?status=${status}&per_page=20`]).workflow_runs || [];
    for (const run of runs) {
      const jobs = gh(config, ['api', `repos/${config.owner}/${repo}/actions/runs/${run.id}/jobs?filter=latest&per_page=100`]).jobs || [];
      waiting += jobs.filter(j => j.status === 'queued' && (j.labels || []).includes('infra-local')).length;
    }
  }
  return waiting;
}

/** Runner containers that are running a job right now. */
function busyRunners(containers) {
  return containers.filter(c => c.role === 'runner' && c.state === 'running'
    && docker(['exec', c.name, 'pgrep', '-f', 'Runner.Worker']).status === 0).map(c => c.slot);
}

function apply(action, config, log) {
  if (action.kind === 'remove') {
    docker(['rm', '-f', action.name]);
    return;
  }
  if (action.kind === 'fresh') {
    docker(['volume', 'rm', '-f', `${action.slot.name}-work`]);
    return;
  }
  if (action.kind === 'dind') {
    const r = docker(dindArgs(action.slot, config));
    if (r.status !== 0) throw new Error(`dind ${action.slot.name}: ${r.stderr.trim()}`);
    log(`started the Docker daemon of ${action.slot.name}`);
    return;
  }
  const jit = jitConfig(config, action.slot);
  const r = docker(runnerArgs(action.slot, config), { env: { ...process.env, INFRA_RUNNER_JITCONFIG: jit.encoded } });
  if (r.status !== 0) throw new Error(`runner ${action.slot.name}: ${r.stderr.trim()}`);
  log(`runner ${jit.name} online for ${action.slot.repo} (slot ${action.slot.index})`);
}

function logger(config) {
  fs.mkdirSync(config.runtimeDir, { recursive: true });
  const file = path.join(config.runtimeDir, 'runners.log');
  return message => {
    try {
      if (fs.existsSync(file) && fs.statSync(file).size > 5 << 20) fs.renameSync(file, `${file}.1`);
      fs.appendFileSync(file, `${new Date().toISOString()} ${message}\n`);
    } catch {
      // logging never stops the supervisor
    }
  };
}

function pruneDaemons(slots, log) {
  for (const slot of slots) {
    docker(['exec', `${slot.name}-dind`, 'docker', 'system', 'prune', '-af', '--volumes', '--filter', 'until=72h']);
    docker(['exec', `${slot.name}-dind`, 'docker', 'builder', 'prune', '-af', '--filter', 'until=72h']);
  }
  log(`pruned ${slots.length} slot daemons`);
}

/**
 * The supervisor: reconciles every `pollSeconds` until stopped. Every `demandSeconds` it measures waiting jobs
 * and busy runners and sizes each repository's slots (`slotCounts`); a slot that ran a job or started within
 * `idleMinutes` stays.
 */
async function supervise(config, { once = false } = {}) {
  const log = logger(config);
  if (!config.owner) throw new Error('set "owner" in ~/.infra-cache/runners.json');
  let repos = [];
  let counts = {};
  let discoveredAt = 0;
  let measuredAt = 0;
  let prunedAt = Date.now();
  const active = new Map(); // slot name -> {repo, index, at}: the last time it started or ran a job
  const touch = slot => active.set(slot.name, { repo: slot.repo, index: slot.index, at: Date.now() });
  const warm = () => {
    const out = {};
    for (const [name, slot] of active) {
      if (Date.now() - slot.at > config.idleMinutes * 60_000) active.delete(name);
      else (out[slot.repo] = out[slot.repo] || []).push(slot.index);
    }
    return out;
  };
  const reconcileAll = () => {
    for (const action of reconcile(desiredSlots(repos, counts), listContainers())) {
      apply(action, config, log);
      if (action.kind === 'runner') touch(action.slot);
    }
  };
  log(`supervisor ${process.pid} started`);
  for (;;) {
    try {
      const discover = Date.now() - discoveredAt > config.discoverMinutes * 60_000;
      if (discover) {
        const next = selectRepos(discoverRepos(config), config);
        if (next.join() !== repos.join()) log(`repositories: ${next.join(', ') || 'none'}`);
        repos = next;
        // stale registrations before any runner starts: a runner just started may not be online yet
        for (const repo of repos) removeStaleRunners(config, repo, log);
        discoveredAt = Date.now();
      }
      // busy runners are measured before any slot is sized, so a restarted supervisor never removes a slot
      // that is running a job
      if (discover || Date.now() - measuredAt > config.demandSeconds * 1000) {
        const containers = listContainers();
        for (const name of busyRunners(containers)) {
          const c = containers.find(x => x.slot === name && x.role === 'runner');
          touch({ name, repo: c.repo, index: Number(name.slice(name.lastIndexOf('-') + 1)) });
        }
        const demand = Object.fromEntries(repos.map(repo => [repo, waitingJobs(config, repo)]));
        const next = slotCounts(repos, { demand, warm: warm() }, config);
        if (JSON.stringify(next) !== JSON.stringify(counts)) log(`slots: ${JSON.stringify(next)} (waiting ${JSON.stringify(demand)})`);
        counts = next;
        measuredAt = Date.now();
      }
      reconcileAll();
      // the route last: a job is never sent to runners that are not there yet
      if (discover) for (const repo of repos) routeToLocal(config, repo, log);
      if (Date.now() - prunedAt > config.pruneHours * 3600_000) {
        pruneDaemons(desiredSlots(repos, counts), log);
        prunedAt = Date.now();
      }
    } catch (error) {
      log(`error: ${error.message}`);
    }
    if (once) return;
    await new Promise(resolve => setTimeout(resolve, config.pollSeconds * 1000));
  }
}

// ------------------------------------------------------------------------------------------- commands

const pidFile = config => path.join(config.runtimeDir, 'supervisor.pid');

function supervisorPid(config) {
  try {
    const pid = Number(fs.readFileSync(pidFile(config), 'utf8'));
    process.kill(pid, 0);
    return pid;
  } catch {
    return null;
  }
}

function up(config) {
  const running = supervisorPid(config);
  if (running) {
    console.log(`[runners] supervisor already running (pid ${running})`);
    return 0;
  }
  fs.mkdirSync(config.runtimeDir, { recursive: true });
  const child = childProcess.spawn(process.execPath, [path.join(__dirname, '..', 'bin', 'infra.js'), 'runners', 'run'],
    { detached: true, stdio: 'ignore', windowsHide: true });
  fs.writeFileSync(pidFile(config), String(child.pid));
  child.unref();
  console.log(`[runners] supervisor started (pid ${child.pid}); log: ${path.join(config.runtimeDir, 'runners.log')}`);
  return 0;
}

function down(config) {
  const pid = supervisorPid(config);
  if (pid) process.kill(pid);
  fs.rmSync(pidFile(config), { force: true });
  const containers = listContainers();
  for (const c of containers) docker(['rm', '-f', c.name]);
  const repos = [...new Set(containers.map(c => c.repo).filter(Boolean))];
  console.log(`[runners] stopped the supervisor and ${containers.length} containers; caches kept`);
  if (config.owner) {
    for (const repo of repos) {
      try {
        routeToHosted(config, repo, message => console.log(`[runners] ${message}`));
        removeStaleRunners(config, repo, message => console.log(`[runners] ${message}`));
      } catch (error) {
        console.error(`[runners] ${error.message}`);
      }
    }
  }
  return 0;
}

function status(config) {
  const pid = supervisorPid(config);
  console.log(`[runners] supervisor: ${pid ? `running (pid ${pid})` : 'stopped'}`);
  const containers = listContainers().filter(c => c.role === 'runner');
  for (const c of containers.sort((a, b) => a.name.localeCompare(b.name))) {
    const busy = c.state === 'running' && docker(['exec', c.name, 'pgrep', '-f', 'Runner.Worker']).status === 0;
    console.log(`  ${c.name.padEnd(36)} ${c.state.padEnd(8)} ${busy ? 'running a job' : 'idle'}`);
  }
  if (!containers.length) console.log('  no runner containers');
  return 0;
}

function build(config) {
  const context = path.join(__dirname, '..', 'runners');
  const r = childProcess.spawnSync('docker', ['build', '-t', config.image, '-f', path.join(context, 'runner.Dockerfile'), context], { stdio: 'inherit' });
  return r.status === 0 ? 0 : 1;
}

/** A logon task that starts the supervisor (Windows); elsewhere use the platform's service manager. */
function install(config, remove = false) {
  if (process.platform !== 'win32') {
    console.error('[runners] install registers a Windows logon task; on other hosts run `infra runners up` from a service');
    return 2;
  }
  const args = remove
    ? ['/Delete', '/F', '/TN', TASK_NAME]
    : ['/Create', '/F', '/SC', 'ONLOGON', '/DELAY', '0002:00', '/TN', TASK_NAME, '/TR',
      `"${process.execPath}" "${path.join(__dirname, '..', 'bin', 'infra.js')}" runners up`];
  const r = childProcess.spawnSync('schtasks', args, { encoding: 'utf8', windowsHide: true });
  console.log(`[runners] ${(r.stdout || r.stderr).trim()}`);
  return r.status === 0 ? 0 : 1;
}

async function runnersMain(args, env = process.env) {
  const config = loadConfig(env);
  switch (args[0]) {
    case 'build': return build(config);
    case 'up': return up(config);
    case 'down': return down(config);
    case 'status': return status(config);
    case 'run': await supervise(config, { once: args.includes('--once') }); return 0;
    case 'install': return install(config);
    case 'uninstall': return install(config, true);
    default:
      console.error(USAGE);
      return 2;
  }
}

module.exports = {
  DEFAULTS, LABEL, LOCAL_TARGET, RUNNER_VARIABLE, USAGE, slotCounts, desiredSlots, dindArgs, jitLabels, loadConfig, reconcile, runnerArgs, runnersMain,
  selectRepos, slotName,
};
