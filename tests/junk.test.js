'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const junk = require('../scripts/junk');

/** A Windows path on [letter] built from parts (no drive literals in the sources: the base forbids machine paths). */
const at = (letter, ...parts) => path.win32.join(`${letter}:\\`, ...parts);

function scratch(t) {
  const base = fs.mkdtempSync(path.join(process.env.DEV_TEMP || os.tmpdir(), 'junk-test-'));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const root = path.join(base, 'dev', 'tmp');
  fs.mkdirSync(root, { recursive: true });
  return root;
}

function capture() {
  const chunks = [];
  return { write: chunk => chunks.push(String(chunk)), text: () => chunks.join('') };
}

function fill(folder, bytes) {
  fs.mkdirSync(path.join(folder, 'deep'), { recursive: true });
  fs.writeFileSync(path.join(folder, 'deep', 'blob.bin'), Buffer.alloc(bytes));
}

test('the root is DEV_TEMP, never missing, never too shallow, never on the system drive', () => {
  assert.throws(() => junk.rootOf({}), /DEV_TEMP is not set/);
  assert.throws(() => junk.rootOf({ DEV_TEMP: path.parse(process.cwd()).root }), /too shallow/);
  assert.throws(() => junk.rootOf({ DEV_TEMP: at('C', 'Users', 'x', 'temp'), SystemDrive: 'C:' }), /system drive/);
  assert.equal(junk.rootOf({ DEV_TEMP: at('V', 'dev', 'tmp'), SystemDrive: 'C:' }), path.resolve(at('V', 'dev', 'tmp')));
  assert.equal(junk.thresholdBytes({}), 1024 * 1024 * 1024);
  assert.equal(junk.thresholdBytes({ DEV_TEMP_SWEEP_MB: '2' }), 2 * 1024 * 1024);
  assert.throws(() => junk.thresholdBytes({ DEV_TEMP_SWEEP_MB: '-1' }), /positive/);
});

test('a job folder is fresh, named by its label, under jobs/', t => {
  const root = scratch(t);
  const a = junk.newJob(root, 'Loader Render!');
  const b = junk.newJob(root, 'Loader Render!');
  assert.notEqual(a, b);
  assert.equal(path.dirname(a), path.join(root, 'jobs'));
  assert.match(path.basename(a), /^loader-render-\d{8}-\d{6}-[a-z0-9]+$/);
  assert.match(path.basename(junk.newJob(root, '***')), /^job-/);
});

test('marking records the size once, takes files too, and refuses anything outside the root', t => {
  const root = scratch(t);
  const a = junk.newJob(root, 'a');
  fill(a, 3000);
  const log = path.join(root, 'run.log');
  fs.writeFileSync(log, 'x'.repeat(200));
  assert.equal(junk.sizeOf(a), 3000);
  assert.equal(junk.markDone(root, [a]), 3000);
  assert.equal(junk.markDone(root, [a, log]), 3200, 'a folder marked twice counts once; a file adds its size');
  assert.ok(fs.existsSync(path.join(a, junk.MARKER)));
  assert.throws(() => junk.markDone(root, [path.dirname(root)]), /outside/);
  assert.throws(() => junk.markDone(root, [path.join(root, 'jobs', 'missing')]), /does not exist/);
  assert.equal(junk.status(root, 10).bytes, 3200);
});

test('once the root reaches the threshold everything marked goes at once; nothing unmarked, nothing outside', t => {
  const root = scratch(t);
  const marked = junk.newJob(root, 'marked');
  const working = junk.newJob(root, 'working');
  fill(marked, 500);
  fill(working, 500);
  const log = path.join(root, 'old.log');
  fs.writeFileSync(log, 'x');
  junk.markDone(root, [marked, log]);
  const unmarkedOld = path.join(root, 'old-unmarked');
  fill(unmarkedOld, 10);
  const strayMarked = path.join(root, 'jobs', 'not-in-ledger');
  fs.mkdirSync(strayMarked, { recursive: true });
  fs.writeFileSync(path.join(strayMarked, junk.MARKER), '');
  const osDir = path.join(root, 'os');
  fs.mkdirSync(path.join(osDir, 'old-dir'), { recursive: true });
  fs.writeFileSync(path.join(osDir, 'old.tmp'), 'x');
  fs.writeFileSync(path.join(osDir, 'fresh.tmp'), 'x');
  const old = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000);
  fs.utimesSync(path.join(osDir, 'old-dir'), old, old);
  fs.utimesSync(path.join(osDir, 'old.tmp'), old, old);
  // a tool's long-lived temp root: old itself, but something inside was touched today (the sccache server's tmp.* folder)
  fs.mkdirSync(path.join(osDir, 'tmp.server', 'job'), { recursive: true });
  fs.writeFileSync(path.join(osDir, 'tmp.server', 'job', 'live.o'), 'x');
  fs.utimesSync(path.join(osDir, 'tmp.server'), old, old);

  assert.deepEqual(junk.sweep(root, { auto: true, threshold: 1_000_000 }), { swept: 0, bytes: 0, total: 501 });
  assert.ok(fs.existsSync(marked), 'below the threshold nothing goes');

  const result = junk.sweep(root, { auto: true, threshold: 1000 });
  assert.equal(result.bytes, 501);
  assert.ok(!fs.existsSync(marked) && !fs.existsSync(strayMarked) && !fs.existsSync(log));
  assert.ok(fs.existsSync(working) && fs.existsSync(unmarkedOld), 'nothing without a mark is ever deleted');
  assert.ok(!fs.existsSync(path.join(osDir, 'old-dir')) && !fs.existsSync(path.join(osDir, 'old.tmp')));
  assert.ok(fs.existsSync(path.join(osDir, 'fresh.tmp')));
  assert.ok(fs.existsSync(path.join(osDir, 'tmp.server')), 'a folder with something fresh inside stays');
  assert.deepEqual(junk.readLedger(root), []);
});

test('a ledger entry that lost its marker, or points outside the root, is never deleted', t => {
  const root = scratch(t);
  const folder = junk.newJob(root, 'unmarked-later');
  junk.markDone(root, [folder]);
  fs.rmSync(path.join(folder, junk.MARKER));
  assert.equal(junk.deletable(root, { path: folder, bytes: 0 }), false);
  assert.equal(junk.deletable(root, { path: path.dirname(root), bytes: 0 }), false);
  junk.sweep(root, { threshold: 1 });
  assert.ok(fs.existsSync(folder));
});

test('on Windows the folders go in rd batches through cmd, nothing is read', () => {
  const calls = [];
  const many = Array.from({ length: 400 }, (_, i) => at('V', 'dev', 'tmp', 'jobs', `folder-with-a-long-name-${i}`));
  junk.removeAll(many, 'win32', (command, args) => calls.push({ command, args }));
  assert.ok(calls.length > 1, 'a long list is split into batches under the command line limit');
  assert.ok(calls.every(call => call.command === 'cmd.exe' && call.args[2].length < 7100));
  assert.equal(calls.map(call => call.args[2].split(' & ').length).reduce((a, b) => a + b, 0), 400);
  assert.ok(calls[0].args[2].startsWith(`rd /s /q "${many[0]}"`));
  junk.removeAll([], 'win32', () => assert.fail('no call for nothing'));
});

test('the command line: new, done (sweeps once the root is full), sweep, status, errors', t => {
  const root = scratch(t);
  const env = { DEV_TEMP: root, DEV_TEMP_SWEEP_MB: '0.001' };
  const created = capture();
  assert.equal(junk.main(['new', 'render'], created, capture(), env), 0);
  const folder = created.text().trim();
  fill(folder, 5000);
  const done = capture();
  assert.equal(junk.main(['done', folder], done, capture(), env), 0);
  assert.match(done.text(), /swept 1 item/);
  assert.ok(!fs.existsSync(folder));
  const status = capture();
  assert.equal(junk.main(['status'], status, capture(), env), 0);
  assert.match(status.text(), /0 marked/);
  assert.equal(junk.main(['sweep', '--auto'], capture(), capture(), env), 0);
  assert.equal(junk.main(['sweep'], capture(), capture(), env), 0);
  const err = capture();
  assert.equal(junk.main(['done'], capture(), err, env), 2);
  assert.match(err.text(), /at least one folder/);
  assert.equal(junk.main(['bogus'], capture(), capture(), env), 2);
  assert.equal(junk.main(['status'], capture(), capture(), {}), 2);
  assert.equal(junk.main([], capture(), capture(), env), 2);
  assert.equal(junk.main(['--help'], capture(), capture(), env), 0);
});

test('cachedSize reuses a fresh measurement well below the threshold and re-measures near it, when stale or unreadable', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'junk-size-'));
  fs.writeFileSync(path.join(root, 'a.bin'), Buffer.alloc(1000));
  const first = junk.cachedSize(root, 1_000_000, 1_000);
  assert.ok(first >= 1000);
  fs.writeFileSync(path.join(root, 'b.bin'), Buffer.alloc(5000));
  assert.equal(junk.cachedSize(root, 1_000_000, 2_000), first, 'fresh and far below the threshold: cached');
  assert.ok(junk.cachedSize(root, 1_000_000, 1_000 + 6 * 60 * 1000) >= first + 5000, 'stale: measured again');
  assert.ok(junk.cachedSize(root, 6_000, 1_000 + 6 * 60 * 1000 + 1) >= first + 5000, 'near the threshold: measured again');
  fs.writeFileSync(path.join(root, 'c.bin'), Buffer.alloc(5000));
  const over = junk.cachedSize(root, 1_000, 10 * 60 * 1000);
  assert.equal(junk.cachedSize(root, 1_000, 10 * 60 * 1000 + 1000), over, 'fresh and over the threshold: cached');
  fs.writeFileSync(path.join(root, '.size-cache.json'), 'not json');
  assert.ok(junk.cachedSize(root, 1_000_000, 5) >= first + 5000, 'unreadable cache: measured again');
  fs.rmSync(root, { recursive: true, force: true });
});

test('sweep --auto does not walk the root when nothing marked could go', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'junk-idle-'));
  let measured = 0;
  const result = junk.sweep(root, { auto: true, threshold: 1, measure: () => { measured += 1; return 10; } });
  assert.deepEqual(result, { swept: 0, bytes: 0, total: 0 });
  assert.equal(measured, 0);
  fs.rmSync(root, { recursive: true, force: true });
});
