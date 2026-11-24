'use strict';

// Queue jobs trigger the detached disk clean; never from unit tests.
process.env.INFRA_AUTO_CLEAN = '0';
// The suite may itself run inside a queued job; its jobs must take their own slots (no nesting in the runner's slot).
delete process.env.INFRA_QUEUE_CLASS;
delete process.env.INFRA_QUEUE_JOBS;

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const {
  POLL_MS, acquire, backgroundRunning, burstGate, lowerOwnPriority, nestedIn, burstMinFreeBytes, classLimits, cpuSampler, idleWindow, isAlive, jobEnv, legacyRoots, sharedJobs, mayBurst,
  mayRun, queueMain, queueRoot, queueSnapshot, queueStats, queueStatus, readClassTickets, readHistory, readTickets, recordHistory,
  runQueued, watchDirs,
} = require('../lib/machine-queue');
const INFRA_CLI = path.join(__dirname, '..', 'bin', 'infra.js');

function tempRoot(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'infra-queue-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

function collect() {
  const lines = [];
  return { lines, log: line => lines.push(line) };
}

test('two builds are guaranteed and half the cores is the ceiling', () => {
  assert.deepEqual(classLimits('build', { cores: 8, env: {} }), { slots: 2, burst: 4, jobs: 4 });
  assert.deepEqual(classLimits('build', { cores: 2, env: {} }), { slots: 1, burst: 1, jobs: 2 });
  assert.deepEqual(classLimits('build', { cores: 8, env: { INFRA_QUEUE_BUILD_SLOTS: '3' } }), { slots: 3, burst: 4, jobs: 2 });
  assert.deepEqual(classLimits('build', { cores: 8, env: { INFRA_QUEUE_BUILD_SLOTS: '6' } }), { slots: 6, burst: 6, jobs: 1 });
  assert.deepEqual(classLimits('build', { cores: 8, env: { INFRA_QUEUE_BUILD_SLOTS: 'x', INFRA_QUEUE_BUILD_BURST: '5' } }), { slots: 2, burst: 5, jobs: 4 });
  assert.deepEqual(classLimits('emulator', { cores: 8, env: {} }), { slots: 1, burst: 1, jobs: 8 });
  assert.throws(() => classLimits('gpu', { cores: 8, env: {} }), /unknown queue class/);
});

test('waiters are granted strictly in arrival order up to the free slots', () => {
  const tickets = [
    { name: 'a', granted: true },
    { name: 'b', granted: false },
    { name: 'c', granted: false },
  ];
  assert.equal(mayRun(tickets, 'b', 2), true);
  assert.equal(mayRun(tickets, 'c', 2), false);
  assert.equal(mayRun(tickets, 'c', 3), true);
  assert.equal(mayRun(tickets, 'missing', 3), false);
});

test('only the head waiter bursts, and only after an idle full window below the ceiling', () => {
  const tickets = [
    { name: 'a', granted: true },
    { name: 'b', granted: true },
    { name: 'c', granted: false },
    { name: 'd', granted: false },
  ];
  const ok = { slots: 2, burst: 4, idle: 0.7, windowElapsedMs: 15_000, windowMs: 15_000, threshold: 0.5 };
  assert.equal(mayBurst(tickets, 'c', ok), true);
  assert.equal(mayBurst(tickets, 'd', ok), false);
  assert.equal(mayBurst(tickets, 'c', { ...ok, idle: 0.3 }), false);
  assert.equal(mayBurst(tickets, 'c', { ...ok, windowElapsedMs: 5_000 }), false);
  assert.equal(mayBurst(tickets, 'c', { ...ok, burst: 2 }), false);
  assert.equal(mayBurst(tickets.slice(1), 'c', ok), false);
  assert.equal(mayBurst([{ name: 'a', granted: true }], 'a', ok), false);
  assert.equal(mayBurst(tickets, 'c', { ...ok, freeBytes: 1e9, minFreeBytes: 4e9 }), false, 'memory pressure');
  assert.equal(mayBurst(tickets, 'c', { ...ok, freeBytes: 8e9, minFreeBytes: 4e9 }), true);
});

test('the cpu sampler reports the idle share between calls', () => {
  const cpu = (idle, busy) => ({ times: { user: busy, nice: 0, sys: 0, idle, irq: 0 } });
  const readings = [[cpu(0, 0), cpu(0, 0)], [cpu(75, 25), cpu(75, 25)], [cpu(75, 25), cpu(75, 25)]];
  const sample = cpuSampler(() => readings.shift());
  assert.equal(sample(), 0.75);
  assert.equal(sample(), 0);
  assert.equal(typeof cpuSampler()(), 'number');
});

test('a waiter takes a burst slot when the host stays idle', async t => {
  const root = tempRoot(t);
  const holder = await acquire({ root, className: 'build', label: 'holder', slots: 1, pollMs: 5 });
  const { lines, log } = collect();
  const idleValues = [0.1, 0.2, 0.9];
  const burst = await acquire({
    root, className: 'build', label: 'burst', slots: 1, burst: 2, pollMs: 5, windowMs: 20, log,
    sampleIdle: () => idleValues.shift() ?? 0.9,
  });
  assert.ok(lines.some(line => /taking burst slot 2 of 2/.test(line)));
  assert.deepEqual(queueStatus(root).build.map(ticket => ticket.state), ['running', 'running']);
  burst.release();
  holder.release();
});

test('a waiter does not burst into memory pressure', async t => {
  const root = tempRoot(t);
  const holder = await acquire({ root, className: 'build', label: 'holder', slots: 1, pollMs: 5 });
  const free = [1024, 1024, 1024, 64 * 1024 ** 3];
  const freeSeen = [];
  const burst = await acquire({
    root, className: 'build', label: 'burst', slots: 1, burst: 2, pollMs: 5, windowMs: 10,
    sampleIdle: () => 0.9,
    sampleFreeBytes: () => { const value = free.shift() ?? 64 * 1024 ** 3; freeSeen.push(value); return value; },
  });
  assert.ok(freeSeen.length >= 4, 'kept waiting while memory was short');
  burst.release();
  holder.release();
});

test('tickets of dead owners and stale heartbeats are pruned', t => {
  const dir = tempRoot(t);
  const write = (name, pid) => fs.writeFileSync(path.join(dir, name), JSON.stringify({ pid, label: name }));
  write('001-live.json', 1);
  write('002-dead.json', 2);
  write('003-stale.json', 3);
  fs.writeFileSync(path.join(dir, '.tmp-004.json'), '{}');
  fs.writeFileSync(path.join(dir, '005-broken.json'), '{');
  const old = new Date(Date.now() - 600_000);
  fs.utimesSync(path.join(dir, '003-stale.json'), old, old);
  const live = readTickets(dir, { alive: pid => pid !== 2, staleMs: 120_000 });
  assert.deepEqual(live.map(ticket => ticket.label), ['001-live.json']);
  assert.equal(fs.existsSync(path.join(dir, '002-dead.json')), false);
  assert.equal(fs.existsSync(path.join(dir, '003-stale.json')), false);
  assert.deepEqual(readTickets(path.join(dir, 'absent')), []);
});

test('a stale ticket another waiter is deleting at the same moment does not kill the reader (Windows EPERM race)', t => {
  const dir = tempRoot(t);
  fs.writeFileSync(path.join(dir, '001-dead.json'), JSON.stringify({ pid: 2, label: 'dead' }));
  fs.writeFileSync(path.join(dir, '002-live.json'), JSON.stringify({ pid: 1, label: 'live' }));
  const rmSync = fs.rmSync;
  fs.rmSync = () => { const error = new Error('EPERM, Permission denied'); error.code = 'EPERM'; throw error; };
  let live;
  try {
    live = readTickets(dir, { alive: pid => pid !== 2, staleMs: 120_000 });
  } finally {
    fs.rmSync = rmSync;
  }
  assert.deepEqual(live.map(ticket => ticket.label), ['live']);
});

test('the current process is alive and an unused pid is not', () => {
  assert.equal(isAlive(process.pid), true);
  assert.equal(isAlive(2 ** 30), false);
});

test('a second job waits for the only slot and starts after release', async t => {
  const root = tempRoot(t);
  const first = await acquire({ root, className: 'emulator', label: 'first', slots: 1, pollMs: 10, heartbeatMs: 5 });
  const { lines, log } = collect();
  let secondGranted = false;
  const second = acquire({ root, className: 'emulator', label: 'second', slots: 1, pollMs: 10, log })
    .then(lease => { secondGranted = true; return lease; });
  await new Promise(resolve => { setTimeout(resolve, 80); });
  assert.equal(secondGranted, false);
  assert.match(lines[0], /position 1 of 1; running: first/);
  assert.deepEqual(queueStatus(root).emulator.map(ticket => ticket.state), ['running', 'waiting']);
  first.release();
  const lease = await second;
  assert.equal(secondGranted, true);
  lease.release();
  assert.deepEqual(queueStatus(root).emulator, []);
});

test('a pruned ticket is rewritten so the waiter keeps its place', async t => {
  const root = tempRoot(t);
  const holder = await acquire({ root, className: 'build', label: 'holder', slots: 1, pollMs: 10 });
  const waiting = acquire({ root, className: 'build', label: 'waiter', slots: 1, pollMs: 10 });
  await new Promise(resolve => { setTimeout(resolve, 40); });
  const dir = path.join(root, 'build');
  const waiterFile = fs.readdirSync(dir).find(name => JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8')).label === 'waiter');
  fs.rmSync(path.join(dir, waiterFile));
  await new Promise(resolve => { setTimeout(resolve, 40); });
  assert.equal(fs.existsSync(path.join(dir, waiterFile)), true);
  holder.release();
  (await waiting).release();
});

test('runQueued gives a lone job every core and returns its exit code', async t => {
  const root = tempRoot(t);
  const { lines, log } = collect();
  const script = 'process.exit(process.env.CARGO_BUILD_JOBS === "8" && process.env.INFRA_QUEUE_JOBS === "8" ? 7 : 1)';
  const code = await runQueued({ className: 'build', argv: [process.execPath, '-e', script], root, cores: 8, env: { ...process.env, INFRA_QUEUE_BUILD_SLOTS: '' }, log });
  assert.equal(code, 7);
  assert.ok(lines.some(line => /running \(8 job\(s\)\)/.test(line)));
  assert.ok(lines.some(line => /done in/.test(line)));
  assert.deepEqual(queueStatus(root).build, []);
});

test('runQueued reports a command that cannot start and frees the slot', async t => {
  const root = tempRoot(t);
  const { lines, log } = collect();
  const code = await runQueued({ className: 'emulator', argv: ['definitely-not-a-command-xyz'], root, cores: 8, log });
  assert.equal(code, 127);
  assert.ok(lines.some(line => /cannot start/.test(line)));
  await assert.rejects(runQueued({ className: 'build', argv: [], root, log }), /nothing to run/);
  assert.deepEqual(queueStatus(root).emulator, []);
});

test('runQueued turns a .bat that Windows refuses to spawn into exit 127 with a bash hint', { skip: process.platform !== 'win32' }, async t => {
  const root = tempRoot(t);
  const bat = path.join(root, 'job.bat');
  fs.writeFileSync(bat, '@exit /b 0\r\n');
  const { lines, log } = collect();
  const code = await runQueued({ className: 'build', argv: [bat, 'arg'], root, cores: 8, log });
  assert.equal(code, 127);
  assert.ok(lines.some(line => /cannot start .*bash gradlew/.test(line)));
  assert.deepEqual(queueStatus(root).build, []);
});

test('queueMain validates usage and prints status', async t => {
  const root = tempRoot(t);
  const env = { ...process.env, INFRA_QUEUE_DIR: root };
  const out = [];
  const err = [];
  const io = { env, out: line => out.push(line), err: line => err.push(line) };
  assert.equal(await queueMain([], io), 2);
  assert.equal(await queueMain(['run', '--class', 'gpu', '--', 'x'], io), 2);
  assert.equal(await queueMain(['run', '--class', 'build'], io), 2);
  assert.equal(await queueMain(['status'], io), 0);
  assert.ok(out.some(line => /build \(\d+ guaranteed, up to \d+ while the host has headroom\): idle/.test(line)));
  const lease = await acquire({ root, className: 'build', label: 'cargo test -p demo', slots: 1 });
  assert.equal(await queueMain(['status'], io), 0);
  assert.ok(out.some(line => /running .*cargo test -p demo/.test(line)));
  assert.equal(await queueMain(['status', '--json'], io), 0);
  assert.equal(JSON.parse(out.at(-1)).build[0].label, 'cargo test -p demo');
  lease.release();
  assert.equal(await queueMain(['run', '--class', 'build', '--label', 'ok', '--', process.execPath, '-e', 'process.exit(0)'], io), 0);
});

test('build jobs are non-incremental by default and can opt back in', () => {
  assert.equal(jobEnv('build', 4, {}).CARGO_INCREMENTAL, '0');
  assert.equal(jobEnv('build', 4, {}).CARGO_BUILD_JOBS, '4');
  assert.equal(jobEnv('build', 4, { INFRA_QUEUE_INCREMENTAL: '1' }).CARGO_INCREMENTAL, undefined);
  assert.equal(jobEnv('emulator', 8, {}).CARGO_INCREMENTAL, undefined);
  assert.equal(jobEnv('emulator', 8, {}).INFRA_QUEUE_JOBS, '8');
  assert.equal(jobEnv('build', 4, {}).SQLX_OFFLINE, 'true');
  assert.equal(jobEnv('build', 4, { SQLX_OFFLINE: 'false' }).SQLX_OFFLINE, 'false');
  assert.equal(jobEnv('build', 4, { INFRA_QUEUE_SQLX_ONLINE: '1' }).SQLX_OFFLINE, undefined);
  assert.equal(jobEnv('emulator', 8, {}).SQLX_OFFLINE, undefined);
});

test('finished jobs are recorded and summarised by owner and duration', async t => {
  const root = tempRoot(t);
  const { log } = collect();
  assert.equal(await runQueued({ className: 'build', argv: [process.execPath, '-e', 'process.exit(3)'], label: 'slice-a: tests', root, cores: 8, log }), 3);
  recordHistory(root, { className: 'build', label: 'slice-a: clippy', waitSeconds: 5, runSeconds: 90, exitCode: 0 });
  recordHistory(root, { className: 'build', label: 'slice-b: tests', waitSeconds: 1, runSeconds: 30, exitCode: 0 });
  recordHistory(root, { className: 'build', waitSeconds: 0, runSeconds: 1, exitCode: 0 });
  fs.appendFileSync(path.join(root, 'history.jsonl'), 'not json\n');
  const stats = queueStats(root, { top: 2 });
  assert.equal(stats.jobs, 4);
  assert.deepEqual(stats.slowest.map(entry => entry.runSeconds), [90, 30]);
  const owners = Object.fromEntries(stats.owners.map(owner => [owner.owner, owner]));
  assert.equal(owners['slice-a'].jobs, 2);
  assert.equal(owners['slice-a'].failed, 1);
  assert.equal(owners['slice-b'].runSeconds, 30);
  assert.equal(owners['(unlabelled)'].jobs, 1);
  assert.deepEqual(readHistory(path.join(root, 'absent')), []);
  assert.deepEqual(queueStats(path.join(root, 'absent')).owners, []);
});

test('queueMain prints stats as text and json', async t => {
  const root = tempRoot(t);
  recordHistory(root, { className: 'build', label: 'x: y', waitSeconds: 2, runSeconds: 7, exitCode: 0 });
  const out = [];
  const io = { env: { ...process.env, INFRA_QUEUE_DIR: root }, out: line => out.push(line), err: () => {} };
  assert.equal(await queueMain(['stats'], io), 0);
  assert.ok(out.some(line => /1 finished job/.test(line)));
  assert.ok(out.some(line => /7s\s+exit 0\s+x: y/.test(line)));
  assert.equal(await queueMain(['stats', '--json', '--top', '1'], io), 0);
  assert.equal(JSON.parse(out.at(-1)).slowest.length, 1);
});

test('a lone build job gets every core and shares them when others run', async t => {
  const root = tempRoot(t);
  assert.equal(sharedJobs({ className: 'build', root, cores: 8, fallback: 4 }), 8);
  const first = await acquire({ root, className: 'build', label: 'a', slots: 2, pollMs: 5 });
  assert.equal(sharedJobs({ className: 'build', root, cores: 8, fallback: 4 }), 8);
  const second = await acquire({ root, className: 'build', label: 'b', slots: 2, pollMs: 5 });
  assert.equal(sharedJobs({ className: 'build', root, cores: 8, fallback: 4 }), 4);
  assert.equal(sharedJobs({ className: 'emulator', root, cores: 8, fallback: 8 }), 8);
  assert.equal(sharedJobs({ className: 'build', root, cores: 1, fallback: 1 }), 1);
  first.release();
  second.release();
});

const pause = ms => new Promise(resolve => { setTimeout(resolve, ms); });

/** A ticket as an older queue generation (a process started before the switch) leaves it in its own directory. */
function oldTicket(root, className, { label, granted = true, pid = process.pid, at = Date.now() }) {
  const dir = path.join(root, className);
  fs.mkdirSync(dir, { recursive: true });
  const name = `${String(at).padStart(15, '0')}-${pid}-${label.replace(/\W/g, '')}.json`;
  fs.writeFileSync(path.join(dir, name), JSON.stringify({ pid, label, granted, createdAt: new Date(at).toISOString() }));
  return path.join(dir, name);
}

test('the queue directory comes from INFRA_QUEUE_DIR, else DEV_TEMP/queue, else the old home folder', () => {
  const scratch = path.join(os.tmpdir(), 'dev-scratch');
  assert.equal(queueRoot({ INFRA_QUEUE_DIR: path.join(scratch, 'q'), DEV_TEMP: scratch }), path.join(scratch, 'q'));
  assert.equal(queueRoot({ DEV_TEMP: scratch }), path.join(scratch, 'queue'));
  assert.equal(queueRoot({}), path.join(os.homedir(), '.infra-queue'));
  assert.equal(POLL_MS, 250);
});

test('older queue generations are read only for the default directory, or when named', () => {
  const scratch = path.join(os.tmpdir(), 'dev-scratch');
  const home = path.join(os.homedir(), '.infra-queue');
  assert.deepEqual(legacyRoots({ DEV_TEMP: scratch }), [home]);
  assert.deepEqual(legacyRoots({}), [], 'the default already is the old folder');
  assert.deepEqual(legacyRoots({ INFRA_QUEUE_DIR: path.join(scratch, 'q') }), [], 'a private queue stays private');
  assert.deepEqual(legacyRoots({ INFRA_QUEUE_DIR: path.join(scratch, 'q'), INFRA_QUEUE_LEGACY_DIR: home }), [home]);
  assert.deepEqual(legacyRoots({ DEV_TEMP: scratch, INFRA_QUEUE_LEGACY_DIR: '' }), [], 'empty switches it off');
  assert.deepEqual(legacyRoots({ INFRA_QUEUE_DIR: home, INFRA_QUEUE_LEGACY_DIR: home }), [], 'never the primary itself');
});

test('the background class has its own pool, drops to the lowest priority and frees the CPU for builds', async t => {
  assert.deepEqual(classLimits('background', { cores: 8, env: {} }), { slots: 2, burst: 2, jobs: 4 });
  assert.equal(classLimits('background', { cores: 8, env: { INFRA_QUEUE_BACKGROUND_SLOTS: '3' } }).slots, 3);
  const calls = [];
  assert.equal(lowerOwnPriority(() => {}, (pid, value) => calls.push([pid, value])), true);
  assert.deepEqual(calls, [[0, os.constants.priority.PRIORITY_LOW]], 'own process, so every child inherits it');
  const logged = [];
  assert.equal(lowerOwnPriority(line => logged.push(line), () => { throw new Error('denied'); }), false);
  assert.match(logged[0], /normal priority/);
  const root = tempRoot(t);
  assert.equal(backgroundRunning(root), false);
  const lease = await acquire({ root, className: 'background', label: 'coord: produce', slots: 2, burst: 2, pollMs: 5, watch: false });
  assert.equal(backgroundRunning(root), true, 'a granted background job yields its CPU to builds');
  lease.release();
  assert.equal(backgroundRunning(root), false);
});

test('a job started inside a build or background job runs in that slot instead of taking another', async t => {
  assert.equal(nestedIn('build', { INFRA_QUEUE_CLASS: 'build' }), 'build');
  assert.equal(nestedIn('build', { INFRA_QUEUE_CLASS: 'background' }), 'background');
  assert.equal(nestedIn('quick', { INFRA_QUEUE_CLASS: 'build' }), 'build');
  assert.equal(nestedIn('build', { INFRA_QUEUE_CLASS: 'quick' }), null, 'a quick job may not grow into a build');
  assert.equal(nestedIn('emulator', { INFRA_QUEUE_CLASS: 'build' }), null, 'the one emulator slot is always taken');
  assert.equal(nestedIn('build', {}), null);
  const root = tempRoot(t);
  // the only build slot is held by someone else: a nested job still runs at once, with its parent's parallelism
  const holder = await acquire({ root, className: 'build', label: 'other: build', slots: 1, burst: 1, pollMs: 5, watch: false });
  const lines = [];
  const script = 'process.exit(process.env.INFRA_QUEUE_JOBS === "3" ? 0 : 9)';
  const code = await runQueued({
    className: 'build', argv: [process.execPath, '-e', script], root, cores: 8, log: line => lines.push(line),
    env: { ...process.env, INFRA_QUEUE_CLASS: 'build', INFRA_QUEUE_JOBS: '3', INFRA_QUEUE_BUILD_SLOTS: '1', INFRA_QUEUE_BUILD_BURST: '1' },
  });
  holder.release();
  assert.equal(code, 0);
  assert.match(lines[0], /inside a running build job/);
  assert.equal(readClassTickets(root, 'build').length, 0, 'no ticket of its own');
});

test('the quick class has its own small pool that cannot grow past half the cores', () => {
  assert.deepEqual(classLimits('quick', { cores: 8, env: {} }), { slots: 2, burst: 2, jobs: 2 });
  assert.deepEqual(classLimits('quick', { cores: 8, env: { INFRA_QUEUE_QUICK_SLOTS: '3' } }), { slots: 3, burst: 3, jobs: 1 });
  assert.equal(classLimits('quick', { cores: 8, env: { INFRA_QUEUE_QUICK_SLOTS: '99' } }).slots, 4, 'hard cap: half the cores');
  assert.deepEqual(classLimits('quick', { cores: 2, env: {} }), { slots: 1, burst: 1, jobs: 1 });
  assert.equal(burstMinFreeBytes({}), 4 * 1024 ** 3);
  assert.equal(burstMinFreeBytes({ INFRA_QUEUE_BURST_MIN_FREE_GB: '2' }), 2 * 1024 ** 3);
  assert.equal(burstMinFreeBytes({ INFRA_QUEUE_BURST_MIN_FREE_GB: 'x' }), 4 * 1024 ** 3);
});

test('the burst gate names the reason a job waits', () => {
  const base = { slots: 2, burst: 4, idle: 0.6, freeBytes: 8 * 1024 ** 3, minFreeBytes: 4 * 1024 ** 3, threshold: 0.15 };
  assert.equal(burstGate({ ...base, held: 1 }).kind, 'slot');
  assert.equal(burstGate({ ...base, held: 2 }).open, true);
  assert.equal(burstGate({ ...base, held: 4 }).kind, 'ceiling');
  const memory = burstGate({ ...base, held: 2, freeBytes: 2.1 * 1024 ** 3 });
  assert.equal(memory.kind, 'memory');
  assert.match(memory.reason, /2\.1 GiB free, a burst slot needs 4\.0 GiB/);
  const cpu = burstGate({ ...base, held: 3, idle: 0.05 });
  assert.equal(cpu.kind, 'cpu');
  assert.match(cpu.reason, /5% idle, a burst slot needs 15%/);
  assert.equal(burstGate({ held: 2, slots: 2, burst: 4 }).open, true, 'unknown numbers do not block');
});

test('the idle window averages the last window by time and resets with the load', () => {
  const window = idleWindow(1000);
  assert.deepEqual(window.mean(0), { idle: 0, spanMs: 0 });
  window.reset(2, 1000);
  window.add(0.1, 1250);
  window.add(0.9, 1500);
  window.add(0.9, 2000);
  assert.equal(window.held, 2);
  assert.equal(window.lastAt, 2000);
  const mean = window.mean(2000);
  assert.equal(mean.spanMs, 1000);
  assert.ok(Math.abs(mean.idle - (0.1 * 250 + 0.9 * 250 + 0.9 * 500) / 1000) < 1e-9);
  window.add(0.9, 2600);
  assert.equal(window.mean(2600).idle > mean.idle, true, 'the oldest sample left the window');
  window.reset(3, 3000);
  assert.equal(window.mean(3000).idle, 0);
  window.clear();
  assert.equal(window.held, null);
  assert.equal(window.mean(3000).spanMs, 0);
});

test('a freed memory gate opens at once, not one whole window later', async t => {
  const root = tempRoot(t);
  const holder = await acquire({ root, className: 'build', label: 'holder', slots: 1, pollMs: 5 });
  let free = 1024;
  setTimeout(() => { free = 64 * 1024 ** 3; }, 400);
  // counted in polls, not milliseconds: a loaded host stretches every poll, but the old gate needed a whole new
  // 150 ms window (about 30 polls of 5 ms) after memory was free
  let pollsAfterFree = 0;
  const burst = await acquire({
    root, className: 'build', label: 'burst', slots: 1, burst: 2, pollMs: 5, windowMs: 150, watch: false,
    sampleIdle: () => 0.9, sampleFreeBytes: () => { if (free > 1024) pollsAfterFree += 1; return free; },
  });
  assert.ok(pollsAfterFree > 0 && pollsAfterFree <= 2, `started ${pollsAfterFree} polls after memory was free; the old gate restarted its 150 ms window first`);
  burst.release();
  holder.release();
});

test('the wait log says memory when memory holds a job back', async t => {
  const root = tempRoot(t);
  const holder = await acquire({ root, className: 'build', label: 'holder', slots: 1, pollMs: 5 });
  const { lines, log } = collect();
  let free = 2 * 1024 ** 3;
  // memory frees only once the waiter has said why it waits (a timer raced the first check on a loaded host)
  const said = line => { log(line); if (/memory: 2\.0 GiB free/.test(line)) free = 64 * 1024 ** 3; };
  const burst = await acquire({
    root, className: 'build', label: 'burst', slots: 1, burst: 2, pollMs: 5, windowMs: 20, log: said,
    sampleIdle: () => 0.9, sampleFreeBytes: () => free,
  });
  assert.ok(lines.some(line => /position 1 of 1; running: holder; memory: 2\.0 GiB free, a burst slot needs 4\.0 GiB/.test(line)), lines.join('\n'));
  burst.release();
  holder.release();
});

test('a released slot is taken at once through the directory watch, not a poll later', async t => {
  const root = tempRoot(t);
  const first = await acquire({ root, className: 'emulator', label: 'first', slots: 1, pollMs: 5 });
  const second = acquire({ root, className: 'emulator', label: 'second', slots: 1, pollMs: 5_000 });
  await pause(150);
  const released = Date.now();
  first.release();
  const lease = await second;
  const latency = Date.now() - released;
  assert.ok(latency < 1_000, `hand-over took ${latency} ms with a 5 s poll: the watch must wake the waiter`);
  lease.release();
});

test('watchDirs ignores directories it cannot watch and closes cleanly', t => {
  const root = tempRoot(t);
  const close = watchDirs([path.join(root, 'absent'), root], () => {});
  assert.equal(typeof close, 'function');
  close();
  close();
});

test('tickets of an older queue directory count as held slots and are never pruned', async t => {
  const root = tempRoot(t);
  const older = tempRoot(t);
  const heldFile = oldTicket(older, 'build', { label: 'old-a' });
  const deadFile = oldTicket(older, 'build', { label: 'old-dead', pid: 2 ** 30 });
  const merged = readClassTickets(root, 'build', [older]);
  assert.deepEqual(merged.map(ticket => [ticket.label, ticket.legacy]), [['old-a', true]]);
  assert.equal(fs.existsSync(deadFile), true, 'a dead ticket in the old directory is skipped, not deleted');
  assert.equal(fs.existsSync(heldFile), true);
  assert.deepEqual(queueStatus(root, Date.now(), [older]).build.map(ticket => [ticket.label, ticket.legacy]), [['old-a', true]]);
  assert.equal(sharedJobs({ className: 'build', root, legacy: [older], cores: 8, fallback: 4 }), 8);
  oldTicket(older, 'build', { label: 'old-b' });
  assert.equal(sharedJobs({ className: 'build', root, legacy: [older], cores: 8, fallback: 4 }), 4, 'old holders share the cores');
  // both guaranteed slots are taken by old processes: a new job waits until one of them ends
  const { lines, log } = collect();
  let granted = false;
  const waiting = acquire({ root, legacy: [older], className: 'build', label: 'new', slots: 2, pollMs: 10, log }).then(lease => { granted = true; return lease; });
  await pause(100);
  assert.equal(granted, false);
  assert.match(lines[0], /position 1 of 1; running: old-a, old-b/);
  fs.rmSync(heldFile);
  const lease = await waiting;
  assert.equal(granted, true);
  lease.release();
});

test('old and new waiters keep one arrival order', async t => {
  const root = tempRoot(t);
  const older = tempRoot(t);
  const holder = oldTicket(older, 'emulator', { label: 'old-holder', at: 1_000 });
  const oldWaiter = oldTicket(older, 'emulator', { label: 'old-waiter', granted: false, at: 2_000 });
  assert.deepEqual(readClassTickets(root, 'emulator', [older]).map(ticket => ticket.label), ['old-holder', 'old-waiter']);
  let granted = false;
  const waiting = acquire({ root, legacy: [older], className: 'emulator', label: 'new', slots: 1, pollMs: 10 });
  waiting.then(() => { granted = true; });
  await pause(80);
  assert.equal(granted, false, 'one slot, held by an old process');
  fs.rmSync(holder);
  await pause(80);
  assert.equal(granted, false, 'the older waiter of the old directory goes first');
  fs.rmSync(oldWaiter);
  (await waiting).release();
});

test('history and stats continue across the old and the new directory', t => {
  const root = tempRoot(t);
  const older = tempRoot(t);
  fs.writeFileSync(path.join(older, 'history.jsonl'), `${JSON.stringify({ at: '2026-10-25T10:00:00Z', label: 'a: old', runSeconds: 50, waitSeconds: 1, exitCode: 0 })}\n`);
  recordHistory(root, { className: 'quick', label: 'a: new', waitSeconds: 0, runSeconds: 2, exitCode: 0, overran: true });
  const stats = queueStats(root, { legacy: [older] });
  assert.equal(stats.jobs, 2);
  assert.equal(stats.owners[0].overran, 1);
  assert.deepEqual(readHistory(root, [older]).map(entry => entry.label), ['a: old', 'a: new']);
  assert.equal(queueStats(root).jobs, 1, 'without the old directory only the new history counts');
});

test('a quick job never waits behind builds and runs with its own parallelism', async t => {
  const root = tempRoot(t);
  const builds = [
    await acquire({ root, className: 'build', label: 'gradle 1', slots: 2, pollMs: 5 }),
    await acquire({ root, className: 'build', label: 'gradle 2', slots: 2, pollMs: 5 }),
  ];
  const { lines, log } = collect();
  const script = 'process.exit(process.env.INFRA_QUEUE_CLASS === "quick" && process.env.INFRA_QUEUE_JOBS === "2" && !process.env.CARGO_BUILD_JOBS ? 0 : 9)';
  const env = { ...process.env };
  delete env.CARGO_BUILD_JOBS;
  const code = await runQueued({ className: 'quick', argv: [process.execPath, '-e', script], root, cores: 8, env, log });
  assert.equal(code, 0);
  assert.ok(!lines.some(line => /waiting/.test(line)));
  assert.deepEqual(queueStatus(root).quick, []);
  assert.equal(readHistory(root).at(-1).className, 'quick');
  builds.forEach(lease => lease.release());
});

test('the quick pool is capped: a third quick job waits for a free slot', async t => {
  const root = tempRoot(t);
  const first = await acquire({ root, className: 'quick', label: 'q1', slots: 2, burst: 2, pollMs: 5 });
  const second = await acquire({ root, className: 'quick', label: 'q2', slots: 2, burst: 2, pollMs: 5 });
  let granted = false;
  const third = acquire({ root, className: 'quick', label: 'q3', slots: 2, burst: 2, pollMs: 5 }).then(lease => { granted = true; return lease; });
  await pause(120);
  assert.equal(granted, false, 'quick never bursts past its slots');
  first.release();
  (await third).release();
  second.release();
});

test('a quick job that runs too long is reported, recorded and left alone', async t => {
  const root = tempRoot(t);
  const { lines, log } = collect();
  const code = await runQueued({
    className: 'quick', argv: [process.execPath, '-e', 'setTimeout(() => {}, 600)'], label: 'agent: slow lint', root, cores: 8, quickMaxSeconds: 0.1, log,
  });
  assert.equal(code, 0, 'never killed');
  assert.ok(lines.some(line => /quick: still running after 0\.1s.*--class build/.test(line)));
  assert.equal(readHistory(root).at(-1).overran, true);
  const fast = await runQueued({ className: 'quick', argv: [process.execPath, '-e', '0'], root, cores: 8, quickMaxSeconds: 30, log });
  assert.equal(fast, 0);
  assert.equal(readHistory(root).at(-1).overran, undefined);
});

test('the snapshot reports free memory, the threshold and why the next job waits', async t => {
  const root = tempRoot(t);
  const idleSnapshot = await queueSnapshot({ root, sampleFreeBytes: () => 6 * 1024 ** 3, sampleIdle: () => 0.5, cpuMs: 1 });
  assert.equal(idleSnapshot.host.idle, null, 'the cpu is only measured when somebody waits');
  assert.deepEqual(idleSnapshot.gates, {});
  const held = [
    await acquire({ root, className: 'build', label: 'gradle 1', slots: 2, pollMs: 5 }),
    await acquire({ root, className: 'build', label: 'gradle 2', slots: 2, pollMs: 5 }),
  ];
  const waiter = acquire({ root, className: 'build', label: 'lane tests', slots: 2, pollMs: 5, sampleFreeBytes: () => 0 });
  await pause(80);
  const memory = await queueSnapshot({ root, sampleFreeBytes: () => 2.1 * 1024 ** 3, sampleIdle: () => 0.5, cpuMs: 1 });
  assert.equal(memory.host.freeBytes, 2.1 * 1024 ** 3);
  assert.equal(memory.host.minFreeBytes, 4 * 1024 ** 3);
  assert.equal(memory.gates.build.kind, 'memory');
  assert.equal(memory.gates.build.next, 'lane tests');
  const cpu = await queueSnapshot({ root, sampleFreeBytes: () => 9 * 1024 ** 3, sampleIdle: () => 0.04, cpuMs: 1 });
  assert.equal(cpu.gates.build.kind, 'cpu');
  const open = await queueSnapshot({ root, sampleFreeBytes: () => 9 * 1024 ** 3, sampleIdle: () => 0.6, cpuMs: 1 });
  assert.match(open.gates.build.reason, /headroom/);
  const strict = await queueSnapshot({
    root, sampleFreeBytes: () => 9 * 1024 ** 3, sampleIdle: () => 0.6, cpuMs: 1, env: { INFRA_QUEUE_BURST_MIN_FREE_GB: '16' },
  });
  assert.equal(strict.gates.build.kind, 'memory', 'the memory floor is tunable');
  held.forEach(lease => lease.release());
  (await waiter).release();
});

test('queueMain status prints the memory gate and the quick class', async t => {
  const root = tempRoot(t);
  const out = [];
  const io = { env: { ...process.env, INFRA_QUEUE_DIR: root, INFRA_QUEUE_BURST_MIN_FREE_GB: '4096' }, out: line => out.push(line), err: () => {} };
  assert.equal(await queueMain(['status'], io), 0);
  assert.ok(out.some(line => /^\[queue\] host: [\d.]+ GiB free memory \(a burst slot needs 4096\.0 GiB\), cpu not sampled/.test(line)), out.join('\n'));
  assert.ok(out.some(line => /quick \(\d+ slots?, no burst\): idle/.test(line)));
  const held = [
    await acquire({ root, className: 'build', label: 'gradle 1', slots: 2, pollMs: 5 }),
    await acquire({ root, className: 'build', label: 'gradle 2', slots: 2, pollMs: 5 }),
  ];
  const waiter = acquire({ root, className: 'build', label: 'lane tests', slots: 2, pollMs: 5, sampleFreeBytes: () => 0 });
  await pause(80);
  out.length = 0;
  assert.equal(await queueMain(['status'], io), 0);
  assert.ok(out.some(line => /next "lane tests" waits - memory: [\d.]+ GiB free, a burst slot needs 4096\.0 GiB/.test(line)), out.join('\n'));
  assert.ok(out.some(line => /cpu \d+% idle \(a burst slot needs 15%\)/.test(line)));
  out.length = 0;
  assert.equal(await queueMain(['status', '--json'], io), 0);
  const json = JSON.parse(out.join(''));
  assert.equal(json.build.length, 3);
  assert.equal(json.gates.build.kind, 'memory');
  assert.deepEqual(json.quick, []);
  held.forEach(lease => lease.release());
  (await waiter).release();
});

test('queueMain runs a quick job and rejects unknown classes with the class help', async t => {
  const root = tempRoot(t);
  const err = [];
  const io = { env: { ...process.env, INFRA_QUEUE_DIR: root }, out: () => {}, err: line => err.push(line) };
  assert.equal(await queueMain(['run', '--class', 'quick', '--label', 'x: lint', '--', process.execPath, '-e', '0'], io), 0);
  assert.equal(readHistory(root).at(-1).className, 'quick');
  err.length = 0;
  assert.equal(await queueMain(['run', '--class', 'fast', '--', 'x'], io), 2);
  assert.match(err.join('\n'), /build\|quick\|emulator[\s\S]*quick {5}jobs under about a minute/);
});

test('the infra CLI starts the queue through its fast path and passes the exit code on', t => {
  const root = tempRoot(t);
  const env = { ...process.env, INFRA_QUEUE_DIR: root, INFRA_AUTO_CLEAN: '0' };
  const run = (...args) => spawnSync(process.execPath, [INFRA_CLI, 'queue', ...args], { env, encoding: 'utf8' });
  const status = run('status');
  assert.equal(status.status, 0, status.stderr);
  assert.match(status.stdout, /\[queue\] host:/);
  assert.equal(run('bogus').status, 2);
  const job = run('run', '--class', 'quick', '--', process.execPath, '-e', 'process.exit(5)');
  assert.equal(job.status, 5);
  assert.match(job.stderr, /quick: running \(2 job\(s\)\)/);
  assert.equal(readHistory(root).at(-1).exitCode, 5);
});
