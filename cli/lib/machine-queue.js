'use strict';

/**
 * Machine-wide FIFO queue for heavy jobs (ADR-0021).
 *
 * Every agent, worktree and repository on one host shares a single queue
 * directory. A job takes a ticket file. The queue throttles only an overloaded host: a job starts at once
 * while the host has headroom (idle CPU and free memory) and the class ceiling is not reached; when the
 * host is saturated, jobs wait in arrival order. The guaranteed slot count always runs regardless of load. Holders
 * heartbeat their ticket, so a killed process frees its slot on its own:
 * tickets whose owner PID is gone or whose heartbeat is stale are pruned by
 * any participant. The queue only orders work; it never runs a shell.
 *
 * Speed (ADR-0021 amendment, 2026-10-26): a waiter wakes on a directory change event (a released slot is taken
 * within ~20 ms) with a 250 ms poll as the safety net; the burst gate keeps a rolling idle-CPU window and reads the
 * free memory at every wake, so a gate that memory had closed opens the moment memory is free instead of one whole
 * window later; the short `quick` class has its own capped slots; `queue status` says why a job waits.
 * State lives on the Dev Drive (INFRA_QUEUE_DIR, else DEV_TEMP/queue); the old home-folder directory is still
 * read while processes started before the switch hold tickets in it (migration, no queue stop needed).
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');

const HEARTBEAT_MS = 10_000;
const STALE_MS = 120_000;
const POLL_MS = 250;
const WAKE_DEBOUNCE_MS = 15;
const REPORT_GAP_MS = 5_000;
const GIB = 1024 ** 3;
// Admission by load, not by count (ADR-0021): a waiting job starts as soon as the host shows headroom over a
// short window (at least 15% idle CPU, 4 GiB free memory); only a saturated host makes jobs wait.
const BURST_WINDOW_MS = 2_000;
const BURST_IDLE = 0.15;
const BURST_MIN_FREE_BYTES = 4 * GIB;
// `quick` jobs (lint, one test file, `node --check`, memoized runners) have their own small, capped slot pool and
// never wait behind long builds; a quick job past QUICK_MAX_SECONDS is reported as an overrun (never killed).
const QUICK_MAX_SECONDS = 120;
// `background` jobs (asset production, renders, crawls: throughput work nobody waits on) have their own pool and run
// at the lowest OS priority, inherited by every child (Blender, Python): a build or test always gets the CPU first,
// and their CPU use never closes the build burst gate (owner order 2026-11-21: builds 10-20x faster).
const CLASSES = Object.freeze(['build', 'emulator', 'quick', 'background']);

/**
 * Queue directory: INFRA_QUEUE_DIR, else `queue` inside the Dev Drive scratch root DEV_TEMP (owner rule: nothing on
 * the system drive, ADR-0025; the junk sweeper only touches `jobs/` and `os/` there), else the legacy home folder.
 */
function queueRoot(env = process.env) {
  if (env.INFRA_QUEUE_DIR) return env.INFRA_QUEUE_DIR;
  if (env.DEV_TEMP) return path.join(env.DEV_TEMP, 'queue');
  return legacyQueueRoot();
}

function legacyQueueRoot() {
  return path.join(os.homedir(), '.infra-queue');
}

function samePath(left, right) {
  const norm = value => path.resolve(value).toLowerCase();
  return norm(left) === norm(right);
}

/**
 * Directories of older queue generations whose live tickets still count (migration). Processes started before the
 * switch keep their tickets in the old home folder and never look at the new one, so every new participant reads that
 * folder too (read-only: nothing there is pruned or written) until it holds no live ticket. INFRA_QUEUE_LEGACY_DIR
 * names it explicitly (empty disables); an explicit INFRA_QUEUE_DIR without it means a private queue (tests, sandboxes).
 */
function legacyRoots(env = process.env, root = queueRoot(env)) {
  const named = env.INFRA_QUEUE_LEGACY_DIR;
  const legacy = named !== undefined ? named : (env.INFRA_QUEUE_DIR ? '' : legacyQueueRoot());
  return legacy && !samePath(legacy, root) ? [legacy] : [];
}

/** Free memory a burst slot needs: INFRA_QUEUE_BURST_MIN_FREE_GB, default 4 GiB. */
function burstMinFreeBytes(env = process.env) {
  const gib = Number(env.INFRA_QUEUE_BURST_MIN_FREE_GB);
  return Number.isFinite(gib) && gib > 0 ? gib * GIB : BURST_MIN_FREE_BYTES;
}

function positiveInt(value) {
  const parsed = Number.parseInt(value, 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

/**
 * Guaranteed slots, ceiling and per-job parallelism of a class on a host with `cores` CPUs.
 * `slots` always run (two builds by default: a lone job takes every core, so with one guaranteed slot the
 * next job could never see headroom and the queue convoyed behind it; two concurrent builds cost little
 * on any host). Jobs above it up to `burst` (half the cores, i.e. the number of concurrent heavy workers a
 * laptop sustains) start while the host has headroom. `quick` is a separate pool of short jobs: 2 slots, no burst,
 * never more than half the cores (INFRA_QUEUE_QUICK_SLOTS cannot starve the build class), 2 workers each on 8 cores.
 */
function classLimits(className, { cores = os.availableParallelism(), env = process.env } = {}) {
  if (!CLASSES.includes(className)) throw new Error(`unknown queue class '${className}' (expected ${CLASSES.join(', ')})`);
  if (className === 'emulator') return { slots: 1, burst: 1, jobs: cores };
  if (className === 'background') {
    const slots = positiveInt(env.INFRA_QUEUE_BACKGROUND_SLOTS) ?? 2;
    return { slots, burst: slots, jobs: Math.max(1, Math.floor(cores / 2)) };
  }
  if (className === 'quick') {
    const slots = Math.min(positiveInt(env.INFRA_QUEUE_QUICK_SLOTS) ?? 2, Math.max(1, Math.floor(cores / 2)));
    return { slots, burst: slots, jobs: Math.max(1, Math.floor(cores / (slots * 2))) };
  }
  const slots = positiveInt(env.INFRA_QUEUE_BUILD_SLOTS) ?? Math.min(2, Math.max(1, Math.floor(cores / 2)));
  const burst = Math.max(slots, positiveInt(env.INFRA_QUEUE_BUILD_BURST) ?? Math.max(1, Math.floor(cores / 2)));
  return { slots, burst, jobs: Math.max(1, Math.floor(cores / slots)) };
}

function cpuTotals(list) {
  return list.reduce((sum, cpu) => {
    const { user, nice, sys, idle, irq } = cpu.times;
    return { idle: sum.idle + idle, total: sum.total + user + nice + sys + idle + irq };
  }, { idle: 0, total: 0 });
}

/** Returns a function giving the host idle fraction since its previous call. */
function cpuSampler(read = os.cpus) {
  let last = cpuTotals(read());
  return () => {
    const now = cpuTotals(read());
    const total = now.total - last.total;
    const idle = now.idle - last.idle;
    last = now;
    return total > 0 ? idle / total : 0;
  };
}

function isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === 'EPERM';
  }
}

function ticketName(now, pid) {
  return `${String(now).padStart(15, '0')}-${pid}-${crypto.randomBytes(4).toString('hex')}.json`;
}

function writeTicket(file, data) {
  const temp = path.join(path.dirname(file), `.tmp-${path.basename(file)}`);
  fs.writeFileSync(temp, JSON.stringify(data));
  fs.renameSync(temp, file);
}

/**
 * Live tickets of one class directory in arrival order; with `prune` (the default) stale tickets are removed.
 * A directory that is only read (an older queue generation) passes `prune: false`: dead tickets are skipped, never deleted.
 */
function readTickets(dir, { now = Date.now(), alive = isAlive, staleMs = STALE_MS, prune = true } = {}) {
  let names;
  try { names = fs.readdirSync(dir); } catch { return []; }
  const tickets = [];
  for (const name of names.filter(entry => entry.endsWith('.json') && !entry.startsWith('.')).sort()) {
    const file = path.join(dir, name);
    let data;
    let mtime;
    try {
      data = JSON.parse(fs.readFileSync(file, 'utf8'));
      mtime = fs.statSync(file).mtimeMs;
    } catch {
      continue;
    }
    if (!alive(data.pid) || now - mtime > staleMs) {
      // Another waiter may be removing the same stale ticket at this moment (Windows answers EPERM/EBUSY while the file
      // is being deleted); losing that race is fine, the ticket is skipped either way and must never kill the caller's job.
      if (prune) {
        try { fs.rmSync(file, { force: true }); } catch { /* removed or being removed by another waiter */ }
      }
      continue;
    }
    tickets.push({ name, file, ...data });
  }
  return tickets;
}

/**
 * Live tickets of one class across the primary queue directory and the older generations still being read
 * (see legacyRoots), merged in arrival order. Ticket names start with the arrival time, so one sort orders them all.
 */
function readClassTickets(root, className, legacy = [], options = {}) {
  const tickets = readTickets(path.join(root, className), options).map(ticket => ({ ...ticket, legacy: false }));
  for (const older of legacy) {
    for (const ticket of readTickets(path.join(older, className), { ...options, prune: false })) tickets.push({ ...ticket, legacy: true });
  }
  return legacy.length ? tickets.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0)) : tickets;
}

/** A waiter is granted when it is among the first free slots in arrival order. */
function mayRun(tickets, name, slots) {
  const held = tickets.filter(ticket => ticket.granted).length;
  const waiting = tickets.filter(ticket => !ticket.granted).map(ticket => ticket.name);
  const position = waiting.indexOf(name);
  return position >= 0 && position < slots - held;
}

function gib(bytes) {
  return `${(bytes / GIB).toFixed(1)} GiB`;
}

/**
 * Why the next waiter of a class has to wait, from the live numbers: `{ open, kind, reason }`. `open` is true when the
 * burst gate lets it start (a guaranteed slot is free, or ceiling, memory and idle CPU all allow it). Shown by
 * `queue status` and in the wait log.
 */
function burstGate({
  held, slots, burst, idle = 1, freeBytes = Infinity, minFreeBytes = BURST_MIN_FREE_BYTES, threshold = BURST_IDLE,
}) {
  if (held < slots) return { open: true, kind: 'slot', reason: 'a guaranteed slot is free' };
  if (held >= burst) return { open: false, kind: 'ceiling', reason: `ceiling: ${held} of ${burst} slots are running, one has to finish` };
  if (freeBytes < minFreeBytes) {
    return { open: false, kind: 'memory', reason: `memory: ${gib(freeBytes)} free, a burst slot needs ${gib(minFreeBytes)}` };
  }
  if (idle < threshold) {
    return { open: false, kind: 'cpu', reason: `cpu: ${Math.round(idle * 100)}% idle, a burst slot needs ${Math.round(threshold * 100)}%` };
  }
  return { open: true, kind: 'open', reason: 'the host has headroom' };
}

/**
 * The head waiter may take one burst slot when every base slot is busy, the burst ceiling is
 * not reached, the host stayed idle enough for a whole observation window and enough memory is free.
 */
function mayBurst(tickets, name, {
  slots, burst, idle, windowElapsedMs, windowMs = BURST_WINDOW_MS, threshold = BURST_IDLE,
  freeBytes = Infinity, minFreeBytes = BURST_MIN_FREE_BYTES,
}) {
  const held = tickets.filter(ticket => ticket.granted).length;
  const head = tickets.find(ticket => !ticket.granted);
  return Boolean(head) && head.name === name && held >= slots && held < burst
    && windowElapsedMs >= windowMs && burstGate({ held, slots, burst, idle, freeBytes, minFreeBytes, threshold }).open;
}

/**
 * Rolling idle-CPU observation for the head waiter. `reset` starts a fresh window (the load profile changed: a slot
 * was granted or released); `add` records the idle share since the previous sample; `mean` is the time-weighted idle
 * over the last `windowMs` and how long the window has been observed.
 */
function idleWindow(windowMs) {
  let held = null;
  let start = 0;
  let lastAt = 0;
  let samples = [];
  return {
    get held() { return held; },
    get lastAt() { return lastAt; },
    reset(newHeld, now) { held = newHeld; start = now; lastAt = now; samples = []; },
    clear() { held = null; samples = []; },
    add(idle, now) {
      samples.push({ at: now, idle, ms: now - lastAt });
      lastAt = now;
      samples = samples.filter(sample => sample.at > now - windowMs);
    },
    mean(now) {
      const weight = samples.reduce((sum, sample) => sum + sample.ms, 0);
      const idle = weight > 0
        ? samples.reduce((sum, sample) => sum + sample.idle * sample.ms, 0) / weight
        : (samples.at(-1)?.idle ?? 0);
      return { idle, spanMs: held === null ? 0 : now - start };
    },
  };
}

/**
 * Watches directories and calls `onChange` for every change event; returns a close function. A directory that cannot
 * be watched (missing, unsupported file system) is skipped: the poll interval covers it.
 */
function watchDirs(dirs, onChange) {
  const watchers = [];
  for (const dir of dirs) {
    try {
      const watcher = fs.watch(dir, { persistent: false }, onChange);
      watcher.on('error', () => {});
      watchers.push(watcher);
    } catch { /* poll only */ }
  }
  return () => { for (const watcher of watchers) { try { watcher.close(); } catch { /* already closed */ } } };
}

/**
 * Wait for a slot. Resolves to `{ file, release }`; the caller must release.
 * `log` receives a line whenever the waiting position or the reason for waiting changes.
 * `legacy` lists older queue directories that are read (never written) so their live tickets count too.
 */
async function acquire({
  root = queueRoot(), legacy = [], className, label, command = [], slots, burst = slots, pid = process.pid,
  pollMs = POLL_MS, heartbeatMs = HEARTBEAT_MS, log = () => {}, watch = true,
  windowMs = BURST_WINDOW_MS, threshold = BURST_IDLE, sampleIdle = cpuSampler(), sampleFreeBytes = () => os.freemem(),
  minFreeBytes = BURST_MIN_FREE_BYTES, cpuYielded = () => false,
}) {
  const dir = path.join(root, className);
  fs.mkdirSync(dir, { recursive: true });
  const name = ticketName(Date.now(), pid);
  const file = path.join(dir, name);
  const ticket = { pid, label, command, cwd: process.cwd(), createdAt: new Date().toISOString(), granted: false };
  writeTicket(file, ticket);
  const beat = setInterval(() => {
    try { const now = new Date(); fs.utimesSync(file, now, now); } catch { /* released or pruned */ }
  }, heartbeatMs);
  beat.unref();
  const release = () => {
    clearInterval(beat);
    fs.rmSync(file, { force: true });
  };
  // A change in any watched directory (a ticket released, granted or added) ends the nap after a short debounce.
  let wake = null;
  let pending = false;
  const onChange = () => { if (wake) wake(); else pending = true; };
  const nap = ms => new Promise(resolve => {
    let debounce = null;
    const done = () => { clearTimeout(timer); clearTimeout(debounce); wake = null; resolve(); };
    const timer = setTimeout(done, ms);
    wake = () => { if (!debounce) debounce = setTimeout(done, WAKE_DEBOUNCE_MS); };
    if (pending) { pending = false; wake(); }
  });
  const closeWatch = watch ? watchDirs([dir, ...legacy.map(older => path.join(older, className))], onChange) : () => {};
  const minSampleMs = Math.min(100, pollMs);
  const idleSeen = idleWindow(windowMs);
  let lastReport = null;
  let lastReportAt = 0;
  try {
    for (;;) {
      pending = false;
      const tickets = readClassTickets(root, className, legacy);
      if (!tickets.some(entry => entry.name === name)) writeTicket(file, ticket);
      if (mayRun(tickets, name, slots)) {
        writeTicket(file, { ...ticket, granted: true, grantedAt: new Date().toISOString() });
        return { file, release };
      }
      const held = tickets.filter(entry => entry.granted).length;
      const head = tickets.find(entry => !entry.granted)?.name === name;
      const now = Date.now();
      const watching = { open: false, kind: 'window', reason: 'watching the host load before taking a burst slot' };
      let gate = { open: false, kind: 'queue', reason: 'waiting for its turn' };
      if (!head) idleSeen.clear();
      else if (held >= burst) {
        idleSeen.clear();
        gate = burstGate({ held, slots, burst });
      } else if (idleSeen.held !== held) {
        sampleIdle();
        idleSeen.reset(held, now);
        gate = watching;
      } else {
        if (now - idleSeen.lastAt >= minSampleMs) idleSeen.add(sampleIdle(), now);
        const measured = idleSeen.mean(now);
        // CPU taken by lowest-priority background jobs is free for this job: the OS hands it over at once
        const idle = cpuYielded() ? 1 : measured.idle;
        const { spanMs } = measured;
        const freeBytes = sampleFreeBytes();
        gate = burstGate({ held, slots, burst, idle, freeBytes, minFreeBytes, threshold });
        if (gate.open && spanMs < windowMs) gate = watching;
        if (mayBurst(tickets, name, { slots, burst, idle, windowElapsedMs: spanMs, windowMs, threshold, freeBytes, minFreeBytes })) {
          log(`[queue] ${className}: host ${Math.round(idle * 100)}% idle, taking burst slot ${held + 1} of ${burst}`);
          writeTicket(file, { ...ticket, granted: true, burst: true, grantedAt: new Date().toISOString() });
          return { file, release };
        }
      }
      const waiting = tickets.filter(entry => !entry.granted);
      const position = waiting.findIndex(entry => entry.name === name) + 1;
      const report = `${position}/${gate.kind}`;
      const positionChanged = lastReport === null || position !== Number(lastReport.split('/')[0]);
      // The observation window is silent: a job that gets its burst slot within it never logs a wait.
      if (gate.kind !== 'window' && (positionChanged || (report !== lastReport && now - lastReportAt >= REPORT_GAP_MS))) {
        const running = tickets.filter(entry => entry.granted).map(entry => entry.label).join(', ') || 'none';
        log(`[queue] ${className}: waiting, position ${position} of ${waiting.length}; running: ${running}; ${gate.reason}`);
        lastReport = report;
        lastReportAt = now;
      }
      await nap(pollMs);
    }
  } finally {
    closeWatch();
  }
}

/**
 * The class of the queued job this process runs inside (its environment carries INFRA_QUEUE_CLASS), when a new job of
 * `className` should run in that job's slot instead of taking another: a bake script queued as one build that queues
 * each render held two or three build slots for one piece of work (2026-11-21). A quick or emulator parent, or an
 * emulator child, still queues normally. A parent that fans out in parallel should not be queued itself.
 */
function nestedIn(className, env = process.env) {
  const parent = env.INFRA_QUEUE_CLASS;
  return (parent === 'build' || parent === 'background') && className !== 'emulator' ? parent : null;
}

/** True while a granted `background` job runs: its CPU is lowest priority and yields to builds. */
function backgroundRunning(root, legacy = []) {
  return readClassTickets(root, 'background', legacy, { prune: false }).some(ticket => ticket.granted);
}

/**
 * Drops this queue process to the lowest OS priority before it starts the job (Windows IDLE class, nice 19 elsewhere):
 * every child and grandchild inherits it at creation, so no race with processes the job starts later.
 */
function lowerOwnPriority(log, setPriority = os.setPriority) {
  try {
    setPriority(0, os.constants.priority.PRIORITY_LOW);
    return true;
  } catch (error) {
    log(`[queue] background: could not lower the priority (${error.message}); running at normal priority`);
    return false;
  }
}

/** Parallelism for a build job: all cores divided by the jobs running now (this one included). */
function sharedJobs({ className, root, legacy = [], cores = os.availableParallelism(), fallback }) {
  if (className !== 'build') return fallback;
  const running = readClassTickets(root, className, legacy).filter(ticket => ticket.granted).length;
  return Math.max(1, Math.floor(cores / Math.max(1, running)));
}

/**
 * Run argv once a slot of `className` is free; resolves to the child exit code. Without an explicit `root` the queue
 * directory comes from the environment (queueRoot) and older generations are read too (legacyRoots).
 */
async function runQueued({
  className, argv, label, env = process.env, root, legacy, cores, quickMaxSeconds = QUICK_MAX_SECONDS,
  log = line => process.stderr.write(`${line}\n`),
}) {
  if (!argv.length) throw new Error('nothing to run: pass the command after --');
  const { slots, burst, jobs: slotJobs } = classLimits(className, { cores, env });
  const queueDir = root ?? queueRoot(env);
  const older = legacy ?? (root === undefined ? legacyRoots(env, queueDir) : []);
  const jobLabel = label || argv.join(' ').slice(0, 80);
  const requested = Date.now();
  const parent = nestedIn(className, env);
  if (parent) log(`[queue] ${className}: inside a running ${parent} job - runs in its slot`);
  const lease = parent ? { release: () => {} } : await acquire({
    root: queueDir, legacy: older, className, label: jobLabel, command: argv, slots, burst, log, minFreeBytes: burstMinFreeBytes(env),
    cpuYielded: className === 'build' ? () => backgroundRunning(queueDir, older) : () => false,
  });
  if (className === 'background' && !parent) lowerOwnPriority(log);
  // A job that runs alone gets every core; with company it gets its share (measured 2026-10-06: a lone Billing
  // Center build ran on 4 of 8 threads and left half the CPU idle).
  const jobs = parent ? positiveInt(env.INFRA_QUEUE_JOBS) ?? slotJobs
    : sharedJobs({ className, root: queueDir, legacy: older, cores, fallback: slotJobs });
  const onExit = () => lease.release();
  process.once('exit', onExit);
  const started = Date.now();
  let exitCode = 1;
  let overran = false;
  let overrunTimer = null;
  if (className === 'quick') {
    overrunTimer = setTimeout(() => {
      overran = true;
      log(`[queue] quick: still running after ${quickMaxSeconds}s; the quick class is for jobs under about a minute, use --class build for this one`);
    }, quickMaxSeconds * 1000);
    overrunTimer.unref();
  }
  log(`[queue] ${className}: running (${jobs} job(s)): ${argv.join(' ')}`);
  try {
    exitCode = await new Promise(resolve => {
      const cannotStart = error => {
        // Windows refuses a .bat/.cmd without a shell (Node throws EINVAL at once); the shell stays off on purpose.
        const hint = /\.(bat|cmd)$/i.test(argv[0]) ? 'run the script through bash instead, e.g. bash gradlew ...' : "wrap scripts as: bash -c '...'";
        log(`[queue] cannot start ${argv[0]}: ${error.message} (${hint})`);
        resolve(127);
      };
      let child;
      try {
        child = spawn(argv[0], argv.slice(1), { stdio: 'inherit', env: jobEnv(className, jobs, env), shell: false });
      } catch (error) {
        cannotStart(error);
        return;
      }
      child.on('error', cannotStart);
      child.on('exit', (code, signal) => resolve(code ?? (signal ? 1 : 0)));
    });
    return exitCode;
  } finally {
    clearTimeout(overrunTimer);
    lease.release();
    process.removeListener('exit', onExit);
    const runSeconds = Math.round((Date.now() - started) / 1000);
    recordHistory(queueDir, {
      className, label: jobLabel, waitSeconds: Math.round((started - requested) / 1000), runSeconds, exitCode, ...(overran ? { overran } : {}),
    });
    // Disk hygiene piggybacks on queue traffic: at most one detached clean per configured interval.
    try { require('./clean').maybeAutoClean({ env }); } catch { /* never fail a job over cleaning */ }
    log(`[queue] ${className}: done in ${runSeconds}s`);
  }
}

/**
 * Environment of a queued job. Build jobs get the class parallelism and, unless the caller opts back in
 * with INFRA_QUEUE_INCREMENTAL=1, non-incremental Rust builds: sccache cannot cache incremental crates,
 * so this lets unchanged workspace crates hit the shared cache across worktrees (ADR-0021). `sqlx` query
 * macros check against the branch's committed `.sqlx` metadata (`SQLX_OFFLINE=true`) instead of one shared
 * schema database that cannot match every branch; `INFRA_QUEUE_SQLX_ONLINE=1` keeps an online check (needed by
 * `cargo sqlx prepare`, which uses its own per-agent schema database).
 */
function jobEnv(className, jobs, env) {
  const childEnv = { ...env, INFRA_QUEUE_CLASS: className, INFRA_QUEUE_JOBS: String(jobs) };
  if (className === 'build') {
    childEnv.CARGO_BUILD_JOBS = String(jobs);
    if (env.INFRA_QUEUE_INCREMENTAL !== '1') childEnv.CARGO_INCREMENTAL = '0';
    if (env.INFRA_QUEUE_SQLX_ONLINE !== '1' && env.SQLX_OFFLINE === undefined) childEnv.SQLX_OFFLINE = 'true';
  }
  return childEnv;
}

const HISTORY_FILE = 'history.jsonl';
const HISTORY_LIMIT = 5000;

function recordHistory(root, entry) {
  try {
    fs.mkdirSync(root, { recursive: true });
    fs.appendFileSync(path.join(root, HISTORY_FILE), `${JSON.stringify({ at: new Date().toISOString(), ...entry })}\n`);
  } catch { /* history is best effort */ }
}

function readHistoryFile(root) {
  let text;
  try { text = fs.readFileSync(path.join(root, HISTORY_FILE), 'utf8'); } catch { return []; }
  return text.split('\n').filter(Boolean).slice(-HISTORY_LIMIT).flatMap(line => {
    try { return [JSON.parse(line)]; } catch { return []; }
  });
}

/** History of the primary directory plus that of the older generations still read (see legacyRoots), oldest first. */
function readHistory(root, legacy = []) {
  const entries = [...legacy.flatMap(readHistoryFile), ...readHistoryFile(root)];
  return legacy.length ? entries.sort((a, b) => String(a.at).localeCompare(String(b.at))).slice(-HISTORY_LIMIT) : entries;
}

/** Slowest jobs and per-owner totals (owner = label text before the first colon). */
function queueStats(root = queueRoot(), { top = 10, legacy = [] } = {}) {
  const entries = readHistory(root, legacy);
  const owners = new Map();
  for (const entry of entries) {
    const owner = String(entry.label || '').split(':')[0].trim() || '(unlabelled)';
    const sum = owners.get(owner) || { owner, jobs: 0, runSeconds: 0, waitSeconds: 0, failed: 0, overran: 0 };
    sum.jobs += 1;
    sum.runSeconds += entry.runSeconds || 0;
    sum.waitSeconds += entry.waitSeconds || 0;
    if (entry.exitCode !== 0) sum.failed += 1;
    if (entry.overran) sum.overran += 1;
    owners.set(owner, sum);
  }
  return {
    jobs: entries.length,
    slowest: [...entries].sort((a, b) => (b.runSeconds || 0) - (a.runSeconds || 0)).slice(0, top),
    owners: [...owners.values()].sort((a, b) => b.runSeconds - a.runSeconds),
  };
}

function queueStatus(root = queueRoot(), now = Date.now(), legacy = []) {
  return Object.fromEntries(CLASSES.map(className => [className, readClassTickets(root, className, legacy, { now }).map(ticket => ({
    label: ticket.label,
    pid: ticket.pid,
    state: ticket.granted ? 'running' : 'waiting',
    ageSeconds: Math.round((now - Date.parse(ticket.createdAt)) / 1000),
    ...(ticket.legacy ? { legacy: true } : {}),
  }))]));
}

function sleep(ms) {
  return new Promise(resolve => { setTimeout(resolve, ms); });
}

/**
 * The status plus the memory/CPU gate: free RAM, the burst threshold and, per class with waiters, why the next one waits.
 * `sampleIdle`/`sampleFreeBytes` are injectable; the idle share is measured over `cpuMs` only when somebody waits.
 */
async function queueSnapshot({
  root = queueRoot(), legacy = [], env = process.env, now = Date.now(), cores = os.availableParallelism(),
  sampleIdle = cpuSampler(), sampleFreeBytes = () => os.freemem(), cpuMs = 250,
} = {}) {
  const status = queueStatus(root, now, legacy);
  const minFreeBytes = burstMinFreeBytes(env);
  const freeBytes = sampleFreeBytes();
  const waitingAny = Object.values(status).some(list => list.some(ticket => ticket.state === 'waiting'));
  let idle = null;
  if (waitingAny) {
    await sleep(cpuMs);
    idle = sampleIdle();
  }
  const gates = {};
  for (const className of CLASSES) {
    const list = status[className];
    const next = list.find(ticket => ticket.state === 'waiting');
    if (!next) continue;
    const { slots, burst } = classLimits(className, { cores, env });
    const held = list.filter(ticket => ticket.state === 'running').length;
    const gate = burstGate({ held, slots, burst, idle: idle ?? 1, freeBytes, minFreeBytes, threshold: BURST_IDLE });
    gates[className] = { next: next.label, kind: gate.kind, reason: gate.kind === 'open' ? 'the host has headroom: it starts within the observation window' : gate.reason };
  }
  return { ...status, host: { freeBytes, minFreeBytes, idle, idleNeeded: BURST_IDLE, dir: root, legacy }, gates };
}

const USAGE = 'usage: infra queue <run --class <build|quick|emulator|background> [--label TEXT] -- <command...> | status [--json] | stats [--top N] [--json]>\n'
  + '  build     compile, test, lint, coverage of any stack (Gradle, Cargo); 2 guaranteed slots, bursts while the host has headroom\n'
  + `  quick     jobs under about a minute and little memory (lint, one test file, node --check, memoized runners): own pool of 2, never waits behind builds; reported past ${QUICK_MAX_SECONDS}s\n`
  + '  emulator  one slot; device and emulator runs (coordinator only)\n'
  + '  background  asset production, renders, crawls nobody waits on: own pool of 2 (INFRA_QUEUE_BACKGROUND_SLOTS), lowest OS priority, never holds back builds';

async function queueMain(args, { env = process.env, out = console.log, err = console.error } = {}) {
  const [subcommand, ...rest] = args;
  if (subcommand === 'stats') {
    const topIndex = rest.indexOf('--top');
    const root = queueRoot(env);
    const stats = queueStats(root, { top: topIndex >= 0 ? positiveInt(rest[topIndex + 1]) ?? 10 : 10, legacy: legacyRoots(env, root) });
    if (rest.includes('--json')) out(JSON.stringify(stats, null, 2));
    else {
      out(`[queue] ${stats.jobs} finished job(s) recorded`);
      for (const owner of stats.owners) {
        const overran = owner.overran ? `  quick overran ${owner.overran}` : '';
        out(`  ${owner.owner.padEnd(28)} ${String(owner.jobs).padStart(4)} job(s)  run ${String(owner.runSeconds).padStart(6)}s  wait ${String(owner.waitSeconds).padStart(6)}s  failed ${owner.failed}${overran}`);
      }
      out('[queue] slowest:');
      for (const entry of stats.slowest) out(`  ${String(entry.runSeconds).padStart(6)}s  exit ${entry.exitCode}  ${entry.label}`);
    }
    return 0;
  }
  if (subcommand === 'status') {
    const root = queueRoot(env);
    const snapshot = await queueSnapshot({ root, legacy: legacyRoots(env, root), env });
    if (rest.includes('--json')) out(JSON.stringify(snapshot, null, 2));
    else {
      const { host } = snapshot;
      const cpu = host.idle === null ? 'cpu not sampled (nobody waits)' : `cpu ${Math.round(host.idle * 100)}% idle (a burst slot needs ${Math.round(host.idleNeeded * 100)}%)`;
      out(`[queue] host: ${gib(host.freeBytes)} free memory (a burst slot needs ${gib(host.minFreeBytes)}), ${cpu}`);
      for (const className of CLASSES) {
        const tickets = snapshot[className];
        const { slots, burst } = classLimits(className, { env });
        const policy = burst > slots ? `${slots} guaranteed, up to ${burst} while the host has headroom` : `${slots} slot${slots > 1 ? 's' : ''}, no burst`;
        out(`[queue] ${className} (${policy}): ${tickets.length ? '' : 'idle'}`);
        for (const ticket of tickets) out(`  ${ticket.state.padEnd(7)} ${String(ticket.ageSeconds).padStart(6)}s  ${ticket.label}${ticket.legacy ? '  (old queue directory)' : ''}`);
        const gate = snapshot.gates[className];
        if (gate) out(`  next "${gate.next}" waits - ${gate.reason}`);
      }
    }
    return 0;
  }
  if (subcommand !== 'run') {
    err(USAGE);
    return 2;
  }
  const separator = rest.indexOf('--');
  const options = separator >= 0 ? rest.slice(0, separator) : rest;
  const argv = separator >= 0 ? rest.slice(separator + 1) : [];
  const value = name => { const index = options.indexOf(name); return index >= 0 ? options[index + 1] : undefined; };
  const className = value('--class');
  if (!className || !CLASSES.includes(className) || !argv.length) {
    err(USAGE);
    return 2;
  }
  return runQueued({ className, argv, label: value('--label'), env, log: err });
}

module.exports = {
  BURST_IDLE, BURST_WINDOW_MS, CLASSES, HEARTBEAT_MS, POLL_MS, QUICK_MAX_SECONDS, STALE_MS, USAGE,
  acquire, backgroundRunning, burstGate, burstMinFreeBytes, classLimits, lowerOwnPriority, nestedIn, cpuSampler, idleWindow, isAlive, jobEnv, legacyQueueRoot, legacyRoots, mayBurst,
  mayRun, queueMain, queueRoot, queueSnapshot, queueStats, queueStatus, readClassTickets, readHistory, readTickets, recordHistory,
  runQueued, sharedJobs, watchDirs,
};
