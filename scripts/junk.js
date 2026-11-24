#!/usr/bin/env node
'use strict';

// Scratch space that never lands on the system drive (owner rule 2026-10-22): every temporary folder of a job lives under
// DEV_TEMP (on the Dev Drive), is marked as junk the moment it is no longer needed, and once the root has grown to the sweep threshold (1 GB by
// default) everything marked is removed in one batch. Removal never reads a file: it only deletes
// folders that carry the junk marker, all at once (`rd /s /q` on Windows). DEV_TEMP/os is the TEMP of the tools themselves;
// what is left there is swept after a day. Only folders inside DEV_TEMP are ever touched.

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const MARKER = '.junk';
const LEDGER = '.junk-ledger';
const SIZE_CACHE = '.size-cache.json';
const DAY_MS = 24 * 60 * 60 * 1000;
const SIZE_TTL_MS = 5 * 60 * 1000;

function usage() {
  return [
    'usage: junk.js <new LABEL | done PATH... | sweep [--auto] | status>',
    '  new LABEL   create a fresh folder for a job under DEV_TEMP/jobs and print its path',
    '  done PATH   mark folders or files as junk (no longer needed); sweeps when the whole root reaches the threshold',
    '  sweep       delete everything marked now in one batch (--auto: only once the root reaches the threshold), plus tool',
    '              leftovers in DEV_TEMP/os older than a day',
    '  status      root, marked folders and bytes, threshold',
    'DEV_TEMP names the root (it must not be on the system drive); DEV_TEMP_SWEEP_MB the threshold (default 1024).',
  ].join('\n');
}

/** The junk root: DEV_TEMP, refused when missing, too shallow or on the system drive. */
function rootOf(env = process.env) {
  const named = env.DEV_TEMP;
  if (!named) throw new Error('DEV_TEMP is not set (the scratch root on the Dev Drive)');
  const root = path.resolve(named);
  const parts = root.split(/[\\/]+/).filter(Boolean);
  if (parts.length < 2) throw new Error(`DEV_TEMP=${root} is too shallow to be a scratch root`);
  const system = (env.SystemDrive || '').toLowerCase();
  if (system && root.toLowerCase().startsWith(system)) throw new Error(`DEV_TEMP=${root} is on the system drive ${env.SystemDrive}; owner rule: nothing there`);
  return root;
}

function thresholdBytes(env = process.env) {
  const mb = Number(env.DEV_TEMP_SWEEP_MB || 1024);
  if (!Number.isFinite(mb) || mb <= 0) throw new Error('DEV_TEMP_SWEEP_MB must be a positive number');
  return Math.round(mb * 1024 * 1024);
}

function inside(root, target) {
  const relative = path.relative(root, path.resolve(target));
  return relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative);
}

/** Bytes of a folder from directory entries and lstat only (no file is opened, links are not followed). */
function sizeOf(target) {
  let total = 0;
  const stack = [target];
  while (stack.length) {
    const current = stack.pop();
    let entries;
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) stack.push(full);
      else {
        try { total += fs.lstatSync(full).size; } catch { /* gone meanwhile */ }
      }
    }
  }
  return total;
}

/**
 * Root size for the `--auto` threshold check. Walking the whole root costs seconds (4.5 s at 850 MB, on every session end
 * and every `done`), so a measurement younger than 5 minutes is reused unless it is near the threshold (90-100 %); a
 * stale or unreadable cache is measured again, and a sweep that deleted something drops it. `sweep` also skips the
 * measurement entirely when nothing marked could go (the root is often GBs of other sessions' unmarked work). A late sweep is harmless: it
 * only affects when marked junk goes, never what is deleted.
 */
function cachedSize(root, threshold, now = Date.now()) {
  const file = path.join(root, SIZE_CACHE);
  try {
    const cached = JSON.parse(fs.readFileSync(file, 'utf8'));
    const fresh = now - cached.at >= 0 && now - cached.at < SIZE_TTL_MS;
    if (fresh && (cached.bytes < threshold * 0.9 || cached.bytes >= threshold)) return cached.bytes;
  } catch { /* no usable cache: measure */ }
  const bytes = sizeOf(root);
  try { fs.writeFileSync(file, JSON.stringify({ bytes, at: now })); } catch { /* read-only root: measure next time */ }
  return bytes;
}

function readLedger(root) {
  const file = path.join(root, LEDGER);
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, 'utf8').split(/\r?\n/).filter(Boolean).map(line => {
    const [bytes, ...rest] = line.split('\t');
    return { bytes: Number(bytes) || 0, path: rest.join('\t') };
  });
}

function writeLedger(root, entries) {
  const file = path.join(root, LEDGER);
  const temporary = `${file}.${process.pid}`;
  fs.writeFileSync(temporary, entries.map(entry => `${entry.bytes}\t${entry.path}\n`).join(''));
  fs.renameSync(temporary, file);
}

function stamp(now = new Date()) {
  const pad = value => String(value).padStart(2, '0');
  return `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
}

/** A fresh folder for a job: DEV_TEMP/jobs/<label>-<time>-<random>. */
function newJob(root, label) {
  const safe = String(label || 'job').toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'job';
  const folder = path.join(root, 'jobs', `${safe}-${stamp()}-${Math.random().toString(36).slice(2, 6)}`);
  fs.mkdirSync(folder, { recursive: true });
  return folder;
}

/**
 * Marks [targets] (folders or files inside the root) as junk: a folder gets the marker file, every target a ledger line
 * with its size. Returns the marked total.
 */
function markDone(root, targets) {
  const ledger = readLedger(root);
  const known = new Set(ledger.map(entry => path.resolve(entry.path).toLowerCase()));
  for (const target of targets) {
    const full = path.resolve(target);
    if (!inside(root, full)) throw new Error(`${full} is outside ${root}; only scratch can be marked`);
    if (!fs.existsSync(full)) throw new Error(`${full} does not exist`);
    const folder = fs.statSync(full).isDirectory();
    if (folder) fs.writeFileSync(path.join(full, MARKER), '');
    if (!known.has(full.toLowerCase())) {
      ledger.push({ bytes: folder ? sizeOf(full) : fs.statSync(full).size, path: full });
      known.add(full.toLowerCase());
    }
  }
  writeLedger(root, ledger);
  return ledger.reduce((sum, entry) => sum + entry.bytes, 0);
}

/** Whether a ledger entry may go: a folder that still carries the marker, or a file the ledger named. */
function deletable(root, entry) {
  if (!inside(root, entry.path) || !fs.existsSync(entry.path)) return false;
  return fs.statSync(entry.path).isDirectory() ? fs.existsSync(path.join(entry.path, MARKER)) : true;
}

/** Removes [folders] in batches: one `rd /s /q` per batch on Windows, fs.rmSync elsewhere. Nothing is read. */
function removeAll(folders, platform = process.platform, spawn = spawnSync) {
  if (!folders.length) return;
  if (platform !== 'win32') {
    for (const folder of folders) fs.rmSync(folder, { recursive: true, force: true });
    return;
  }
  let batch = [];
  let length = 0;
  const flush = () => {
    if (!batch.length) return;
    spawn('cmd.exe', ['/d', '/c', batch.map(folder => `rd /s /q "${folder}"`).join(' & ')], { stdio: 'ignore', windowsVerbatimArguments: true });
    batch = [];
    length = 0;
  };
  for (const folder of folders) {
    const piece = folder.length + 16;
    if (length + piece > 7000) flush();
    batch.push(folder);
    length += piece;
  }
  flush();
}

/**
 * The newest modification time of [full] and, for a folder, of everything in it two levels down: a long-lived tool keeps
 * its temp root in os/ for days (the sccache server did, and lost it to a sweep on 2026-10-25), so the folder's own mtime
 * says nothing about whether it is still in use.
 */
function newestMtime(full, isDir, depth = 2) {
  let newest = fs.lstatSync(full).mtimeMs;
  if (!isDir || depth === 0) return newest;
  for (const child of fs.readdirSync(full, { withFileTypes: true })) {
    try {
      newest = Math.max(newest, newestMtime(path.join(full, child.name), child.isDirectory(), depth - 1));
    } catch { /* gone meanwhile */ }
  }
  return newest;
}

/**
 * Deletes everything marked (ledger folders that still carry the marker, ledger files, marked folders under jobs/ the
 * ledger missed) and the leftovers in os/ older than a day, in one batch. With [auto] it runs only once the whole root
 * has grown to [threshold] (owner rule: at 1 GB the marked junk goes); [measure] sizes the root (directory entries only).
 */
function sweep(root, { auto = false, threshold = thresholdBytes(), now = Date.now(), remove = removeAll, measure = target => cachedSize(target, threshold, now) } = {}) {
  const ledger = readLedger(root);
  const total = ledger.reduce((sum, entry) => sum + entry.bytes, 0);
  const folders = new Set();
  const files = new Set();
  for (const entry of ledger) {
    if (!deletable(root, entry)) continue;
    (fs.statSync(entry.path).isDirectory() ? folders : files).add(path.resolve(entry.path));
  }
  const jobs = path.join(root, 'jobs');
  if (fs.existsSync(jobs)) {
    for (const entry of fs.readdirSync(jobs, { withFileTypes: true })) {
      const full = path.join(jobs, entry.name);
      if (entry.isDirectory() && fs.existsSync(path.join(full, MARKER))) folders.add(full);
    }
  }
  const os = path.join(root, 'os');
  if (fs.existsSync(os)) {
    for (const entry of fs.readdirSync(os, { withFileTypes: true })) {
      const full = path.join(os, entry.name);
      try {
        if (now - newestMtime(full, entry.isDirectory()) > DAY_MS) (entry.isDirectory() ? folders : files).add(full);
      } catch { /* gone meanwhile */ }
    }
  }
  const idle = { swept: 0, bytes: 0, total };
  if (!folders.size && !files.size) return idle; // nothing could go: skip walking the (possibly many GB) root
  if (auto && measure(root) < threshold) return idle;
  remove([...folders]);
  try { fs.rmSync(path.join(root, SIZE_CACHE), { force: true }); } catch { /* next measurement overwrites it */ }
  for (const file of files) {
    try { fs.rmSync(file, { force: true }); } catch { /* in use: the next sweep */ }
  }
  const left = ledger.filter(entry => fs.existsSync(entry.path));
  writeLedger(root, left);
  const bytes = total - left.reduce((sum, entry) => sum + entry.bytes, 0);
  return { swept: folders.size + files.size, bytes, total };
}

function status(root, threshold = thresholdBytes()) {
  const ledger = readLedger(root);
  return { root, marked: ledger.length, bytes: ledger.reduce((sum, entry) => sum + entry.bytes, 0), threshold };
}

const mb = bytes => `${(bytes / 1024 / 1024).toFixed(1)} MB`;

function main(argv = process.argv.slice(2), stdout = process.stdout, stderr = process.stderr, env = process.env) {
  const [command, ...rest] = argv;
  try {
    if (!command || command === '--help' || command === '-h') {
      stdout.write(`${usage()}\n`);
      return command ? 0 : 2;
    }
    const root = rootOf(env);
    fs.mkdirSync(path.join(root, 'jobs'), { recursive: true });
    fs.mkdirSync(path.join(root, 'os'), { recursive: true });
    const threshold = thresholdBytes(env);
    if (command === 'new') {
      stdout.write(`${newJob(root, rest[0])}\n`);
    } else if (command === 'done') {
      if (!rest.length) throw new Error('done needs at least one folder');
      const total = markDone(root, rest);
      stdout.write(`marked ${rest.length}; marked total ${mb(total)}\n`);
      const result = sweep(root, { auto: true, threshold });
      if (result.swept) stdout.write(`the root reached ${mb(threshold)}: swept ${result.swept} item(s), ${mb(result.bytes)}\n`);
    } else if (command === 'sweep') {
      const result = sweep(root, { auto: rest.includes('--auto'), threshold });
      stdout.write(`swept ${result.swept} folder(s), ${mb(result.bytes)} (marked total was ${mb(result.total)})\n`);
    } else if (command === 'status') {
      const s = status(root, threshold);
      stdout.write(`${s.root}: ${s.marked} marked, ${mb(s.bytes)} of ${mb(s.threshold)}\n`);
    } else {
      throw new Error(`unknown command ${command}`);
    }
    return 0;
  } catch (error) {
    stderr.write(`[junk] ${error.message}\n`);
    return 2;
  }
}

if (require.main === module) process.exitCode = main();

module.exports = { main, rootOf, thresholdBytes, inside, sizeOf, cachedSize, readLedger, newJob, markDone, deletable, removeAll, sweep, status, MARKER, LEDGER };
