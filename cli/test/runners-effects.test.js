'use strict';

// The supervisor and commands against a scripted docker and gh: no container, network or GitHub call.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const childProcess = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { LOCAL_TARGET, runnersMain } = require('../lib/runners');

const OWNER = 'owner';

/** A scripted host: containers, repositories, registered runners and the route variable per repository. */
function host() {
  return {
    containers: [],
    repos: [
      { name: 'App', owner: { login: OWNER }, private: true, archived: false, disabled: false, workflows: 2 },
      { name: 'Site', owner: { login: OWNER }, private: false, archived: false, workflows: 1 },
      { name: 'Docs', owner: { login: OWNER }, private: true, archived: false, workflows: 0 },
    ],
    runners: { App: [{ id: 7, name: 'infra-app-1-old', status: 'offline' }, { id: 8, name: 'manual', status: 'offline' }] },
    variables: {},
    calls: [],
    jitEnv: [],
    failGh: false,
    waiting: {},
    volumesRemoved: [],
    busy: new Set(),
  };
}

const ok = stdout => ({ status: 0, stdout: typeof stdout === 'string' ? stdout : JSON.stringify(stdout), stderr: '' });
const fail = stderr => ({ status: 1, stdout: '', stderr });

function fakeSpawnSync(h) {
  return (command, args, options = {}) => {
    h.calls.push([command, ...args].join(' '));
    if (command === 'docker') return docker(h, args, options);
    if (command === 'schtasks') return ok('SUCCESS: done');
    return gh(h, args);
  };
}

function docker(h, args, options) {
  const [verb] = args;
  if (verb === 'ps') {
    return ok(h.containers.map(c => JSON.stringify({
      Names: c.name, State: c.state,
      Labels: `infra.runners=1,infra.runners.slot=${c.slot},infra.runners.repo=${c.repo},infra.runners.role=${c.role}`,
    })).join('\n'));
  }
  if (verb === 'run') {
    const name = args[args.indexOf('--name') + 1];
    const label = key => args.find(a => a.startsWith(`infra.runners.${key}=`)).split('=')[1];
    if (label('role') === 'runner') h.jitEnv.push(options.env.INFRA_RUNNER_JITCONFIG);
    h.containers.push({ name, state: 'running', slot: label('slot'), repo: label('repo'), role: label('role') });
    return ok('id');
  }
  if (verb === 'rm') {
    h.containers = h.containers.filter(c => c.name !== args[2]);
    return ok('');
  }
  if (verb === 'exec') return h.busy.has(args[1]) ? ok('') : fail('');
  if (verb === 'build') return { status: 0 };
  if (verb === 'volume') {
    h.volumesRemoved.push(args[3]);
    return ok('');
  }
  return fail(`unexpected docker ${verb}`);
}

function gh(h, args) {
  if (h.failGh) return fail('HTTP 502: bad gateway');
  const method = args.includes('-X') ? args[args.indexOf('-X') + 1] : 'GET';
  const route = args.find(a => a.startsWith('user/') || a.startsWith('repos/'));
  const repo = route.startsWith('repos/') ? route.split('/')[2] : null;
  if (route.startsWith('user/repos')) return ok([h.repos.map(({ workflows, ...r }) => r)]);
  if (route.endsWith('/actions/workflows')) return ok({ total_count: h.repos.find(r => r.name === repo).workflows });
  if (route.includes('/actions/runners?')) return ok({ runners: h.runners[repo] || [] });
  if (route.includes('/actions/runs?status=queued')) return ok({ workflow_runs: h.waiting[repo] ? [{ id: 41 }] : [] });
  if (route.includes('/actions/runs?status=in_progress')) return ok({ workflow_runs: [] });
  if (route.includes('/actions/runs/41/jobs')) {
    const queued = Array.from({ length: h.waiting[repo] }, () => ({ status: 'queued', labels: ['self-hosted', 'infra-local'] }));
    return ok({ jobs: [...queued, { status: 'queued', labels: ['windows-latest'] }, { status: 'completed', labels: ['infra-local'] }] });
  }
  if (route.includes('/actions/runners/generate-jitconfig')) return ok({ encoded_jit_config: `jit-${repo}` });
  if (method === 'DELETE' && route.includes('/actions/runners/')) {
    h.runners[repo] = (h.runners[repo] || []).filter(r => `${r.id}` !== route.split('/').pop());
    return ok('');
  }
  if (route.includes('/actions/variables')) {
    if (method === 'GET') return repo in h.variables ? ok({ value: h.variables[repo] }) : fail('HTTP 404');
    if (method === 'DELETE') {
      if (!(repo in h.variables)) return fail('HTTP 404');
      delete h.variables[repo];
      return ok('');
    }
    h.variables[repo] = args.find(a => a.startsWith('value=')).slice(6);
    return ok('');
  }
  return fail(`unexpected gh ${route}`);
}

function setup(t, config = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'runners-fx-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.writeFileSync(path.join(dir, 'runners.json'), JSON.stringify({ owner: OWNER, ...config }));
  const h = host();
  t.mock.method(childProcess, 'spawnSync', fakeSpawnSync(h));
  const out = [];
  t.mock.method(console, 'log', message => out.push(message));
  t.mock.method(console, 'error', message => out.push(message));
  const env = { INFRA_CLEAN_DIR: dir };
  return { h, env, out, dir, log: () => fs.readFileSync(path.join(dir, 'runners', 'runners.log'), 'utf8') };
}

test('one pass starts a slot per private repository with workflows, then routes its jobs', async t => {
  const { h, env, log } = setup(t);
  assert.equal(await runnersMain(['run', '--once'], env), 0);
  assert.deepEqual(h.containers.map(c => c.name).sort(), ['ghr-app-1', 'ghr-app-1-dind']);
  assert.deepEqual(h.jitEnv, ['jit-App'], 'the registration reaches the runner through its environment');
  assert.ok(!h.calls.some(c => c.includes('jit-App')), 'and never through a command line');
  assert.equal(h.variables.App, LOCAL_TARGET);
  assert.ok(!('Site' in h.variables), 'public repositories are never routed here');
  assert.deepEqual(h.runners.App.map(r => r.name), ['manual'], 'only this machine\'s stale registrations go');
  const order = h.calls.filter(c => /docker run|variables/.test(c)).map(c => (c.includes('variables') ? 'route' : 'start'));
  assert.equal(order.lastIndexOf('start') < order.indexOf('route'), true, 'runners are online before the route');
  assert.match(log(), /repositories: App/);
  assert.match(log(), /App: jobs now run on the local runners/);
});

test('a pass replaces a finished runner and leaves a correct route alone', async t => {
  const { h, env } = setup(t, { pruneHours: -1 });
  await runnersMain(['run', '--once'], env);
  h.containers.find(c => c.name === 'ghr-app-1').state = 'exited';
  h.calls.length = 0;
  await runnersMain(['run', '--once'], env);
  assert.equal(h.containers.find(c => c.name === 'ghr-app-1').state, 'running');
  assert.deepEqual(h.volumesRemoved, ['ghr-app-1-work', 'ghr-app-1-work'], 'every pod starts with an empty work volume');
  assert.ok(!h.calls.some(c => c.includes('-X POST repos/owner/App/actions/variables')), 'no second create');
  assert.ok(h.calls.some(c => c.includes('docker exec ghr-app-1-dind docker system prune')), 'daily prune ran');
  h.variables.App = '"ubuntu-24.04"';
  await runnersMain(['run', '--once'], env);
  assert.equal(h.variables.App, LOCAL_TARGET, 'a drifted route is patched back');
});

test('GitHub failures are logged, not thrown, and a missing owner is a usage error', async t => {
  const { h, env, log, dir } = setup(t);
  h.failGh = true;
  assert.equal(await runnersMain(['run', '--once'], env), 0);
  assert.match(log(), /error: gh api .* failed: HTTP 502/);
  fs.writeFileSync(path.join(dir, 'runners.json'), JSON.stringify({}));
  await assert.rejects(runnersMain(['run', '--once'], env), /set "owner"/);
});

test('status shows each runner as busy or idle', async t => {
  const { h, env, out } = setup(t);
  await runnersMain(['status'], env);
  assert.match(out.join('\n'), /supervisor: stopped[\s\S]*no runner containers/);
  await runnersMain(['run', '--once'], env);
  h.busy.add('ghr-app-1');
  out.length = 0;
  await runnersMain(['status'], env);
  assert.match(out.join('\n'), /ghr-app-1 +running +running a job/);
  h.busy.clear();
  out.length = 0;
  await runnersMain(['status'], env);
  assert.match(out.join('\n'), /ghr-app-1 +running +idle/);
});

test('up starts one detached supervisor and down returns every job to GitHub', async t => {
  const { h, env, out, dir } = setup(t);
  const spawned = [];
  t.mock.method(childProcess, 'spawn', (command, args, options) => {
    spawned.push({ args, options });
    return { pid: process.pid, unref() {} };
  });
  assert.equal(await runnersMain(['up'], env), 0);
  assert.deepEqual(spawned[0].args.slice(-2), ['runners', 'run']);
  assert.equal(spawned[0].options.detached, true);
  assert.equal(fs.readFileSync(path.join(dir, 'runners', 'supervisor.pid'), 'utf8'), String(process.pid));
  assert.equal(await runnersMain(['up'], env), 0);
  assert.equal(spawned.length, 1, 'a running supervisor is not started twice');
  assert.match(out.join('\n'), /already running/);

  t.mock.method(process, 'kill', () => true);
  await runnersMain(['run', '--once'], env);
  assert.equal(h.variables.App, LOCAL_TARGET);
  assert.equal(await runnersMain(['down'], env), 0);
  assert.deepEqual(h.containers, []);
  assert.ok(!('App' in h.variables), 'the route is removed: jobs use the hosted image');
  assert.ok(!fs.existsSync(path.join(dir, 'runners', 'supervisor.pid')));
  assert.match(out.join('\n'), /jobs go back to GitHub-hosted runners/);
});

test('build, install and uninstall drive docker and the Windows task scheduler', async t => {
  const { h, env, out } = setup(t);
  assert.equal(await runnersMain(['build'], env), 0);
  assert.ok(h.calls.some(c => /docker build -t infra-gh-runner:local -f .*runner\.Dockerfile/.test(c)));
  const platform = Object.getOwnPropertyDescriptor(process, 'platform');
  t.after(() => Object.defineProperty(process, 'platform', platform));
  Object.defineProperty(process, 'platform', { value: 'win32' });
  assert.equal(await runnersMain(['install'], env), 0);
  assert.ok(h.calls.some(c => c.startsWith('schtasks /Create') && c.includes('runners up')));
  assert.equal(await runnersMain(['uninstall'], env), 0);
  assert.ok(h.calls.some(c => c.startsWith('schtasks /Delete')));
  Object.defineProperty(process, 'platform', { value: 'linux' });
  assert.equal(await runnersMain(['install'], env), 2);
  assert.match(out.join('\n'), /Windows logon task/);
});

test('the log rotates at 5 MB', async t => {
  const { env, dir } = setup(t);
  const file = path.join(dir, 'runners', 'runners.log');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, Buffer.alloc((5 << 20) + 1));
  await runnersMain(['run', '--once'], env);
  assert.ok(fs.statSync(`${file}.1`).size > 5 << 20);
  assert.ok(fs.statSync(file).size < 4096);
});

test('waiting jobs add slots; idle extras go, busy ones stay', async t => {
  const { h, env, log } = setup(t, { maxSlotsPerRepo: 3, idleMinutes: 1 });
  h.waiting.App = 3;
  await runnersMain(['run', '--once'], env);
  assert.deepEqual(h.containers.filter(c => c.role === 'runner').map(c => c.name).sort(),
    ['ghr-app-1', 'ghr-app-2', 'ghr-app-3'], 'three waiting jobs (other labels ignored): three slots');
  assert.match(log(), /slots: \{"App":3\} \(waiting \{"App":3\}\)/);
  h.waiting.App = 0;
  h.busy.add('ghr-app-2');
  await runnersMain(['run', '--once'], env);
  assert.deepEqual(h.containers.filter(c => c.role === 'runner').map(c => c.name).sort(), ['ghr-app-1', 'ghr-app-2'],
    'the idle extra slot is removed; the busy one is not, even right after a restart');
  h.busy.clear();
  await runnersMain(['run', '--once'], env);
  assert.deepEqual(h.containers.map(c => c.name).sort(), ['ghr-app-1', 'ghr-app-1-dind']);
});
