'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { cleanDocker, cleanMain, cleanTargets, lastUsed, loadConfig, maybeAutoClean, sizeOf } = require('../lib/clean');

function tree(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'clean-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

function target(root, name, { ageHours = 0, incremental = false } = {}) {
  const dir = path.join(root, name);
  fs.mkdirSync(path.join(dir, 'debug', 'deps'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'debug', 'deps', 'lib.rlib'), Buffer.alloc(2048));
  if (incremental) {
    fs.mkdirSync(path.join(dir, 'debug', 'incremental', 'x'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'debug', 'incremental', 'x', 'q.bin'), Buffer.alloc(1024));
  }
  const when = new Date(Date.now() - ageHours * 3600_000);
  for (const item of [path.join(dir, 'debug', 'deps'), path.join(dir, 'debug'), dir]) fs.utimesSync(item, when, when);
  return dir;
}

test('stale targets are removed, recent ones lose only incremental caches, others are untouched', t => {
  const root = tree(t);
  const stale = target(root, 'pc-target-old', { ageHours: 100 });
  const recent = target(root, 'pc-target-new', { ageHours: 5, incremental: true });
  const running = target(root, 'pc-target-running', { ageHours: 0, incremental: true });
  const kept = target(root, 'keep-me', { ageHours: 100 });
  fs.mkdirSync(path.join(root, 'notes'));
  const busy = target(root, 'busy', { ageHours: 100 });
  const dry = cleanTargets({ roots: [root, path.join(root, 'missing')], keep: ['keep-me'], idleHours: 48, dryRun: true, busy: dir => dir === busy });
  assert.deepEqual(dry.map(item => [item.action, path.basename(item.dir)]).sort(), [['drop-incremental', 'incremental'], ['remove', 'pc-target-old']]);
  assert.ok(fs.existsSync(stale));
  const applied = cleanTargets({ roots: [root], keep: ['keep-me'], idleHours: 48, busy: dir => dir === busy });
  assert.equal(fs.existsSync(stale), false);
  assert.equal(fs.existsSync(path.join(recent, 'debug', 'incremental')), false);
  assert.ok(fs.existsSync(path.join(recent, 'debug', 'deps', 'lib.rlib')));
  assert.ok(fs.existsSync(path.join(running, 'debug', 'incremental')));
  assert.ok(fs.existsSync(kept) && fs.existsSync(busy) && fs.existsSync(path.join(root, 'notes')));
  assert.ok(applied.find(item => item.action === 'remove').bytes >= 2048);
  assert.equal(lastUsed(path.join(root, 'notes')), 0);
  assert.equal(sizeOf(path.join(root, 'missing')), 0);
});

test('config is read from the state directory with defaults', t => {
  const state = tree(t);
  assert.deepEqual(loadConfig({ INFRA_CLEAN_DIR: state }), { roots: [], keep: [], idleHours: 48, intervalHours: 6 });
  fs.writeFileSync(path.join(state, 'clean.json'), JSON.stringify({ roots: ['r'], keep: ['k'], idleHours: 12, intervalHours: 1 }));
  assert.deepEqual(loadConfig({ INFRA_CLEAN_DIR: state }), { roots: ['r'], keep: ['k'], idleHours: 12, intervalHours: 1 });
});

test('auto clean launches at most once per interval and only when configured and enabled', t => {
  const state = tree(t);
  const env = { INFRA_CLEAN_DIR: state };
  let launches = 0;
  const launch = () => { launches += 1; };
  assert.equal(maybeAutoClean({ env, launch }), false);
  fs.writeFileSync(path.join(state, 'clean.json'), JSON.stringify({ roots: [state], intervalHours: 6 }));
  assert.equal(maybeAutoClean({ env, launch }), true);
  assert.equal(maybeAutoClean({ env, launch }), false);
  assert.equal(maybeAutoClean({ env, launch, now: Date.now() + 7 * 3600_000 }), true);
  assert.equal(maybeAutoClean({ env: { ...env, INFRA_AUTO_CLEAN: '0' }, launch, now: Date.now() + 20 * 3600_000 }), false);
  assert.equal(launches, 2);
});

test('docker clean prunes caches and removes only stopped one-off test databases', () => {
  const calls = [];
  const run = (command, args) => {
    calls.push(args.join(' '));
    return args[0] === 'ps' ? { status: 0, stdout: 'abc\ndef\n' } : { status: 0 };
  };
  const results = cleanDocker(run);
  assert.deepEqual(calls, ['builder prune -f --filter until=24h', 'image prune -f',
    'ps -a -q --filter label=infra.testdb=1 --filter status=exited', 'rm -v abc def']);
  assert.equal(results.length, 3);
  const none = cleanDocker((command, args) => (args[0] === 'ps' ? { status: 0, stdout: '' } : { status: 1 }));
  assert.deepEqual(none.map(item => item[1]), [1, 1]);
});

test('cleanMain validates scope, reports and honours dry runs', t => {
  const state = tree(t);
  const root = path.join(state, 'targets');
  fs.mkdirSync(root);
  target(root, 'old', { ageHours: 100 });
  fs.writeFileSync(path.join(state, 'clean.json'), JSON.stringify({ roots: [root] }));
  const out = [];
  const err = [];
  const io = { env: { INFRA_CLEAN_DIR: state }, out: line => out.push(line), err: line => err.push(line), run: () => ({ status: 0, stdout: '' }) };
  assert.equal(cleanMain(['bogus'], io), 2);
  assert.equal(cleanMain(['targets', '--dry-run', '--idle-hours', '1'], io), 0);
  assert.ok(out.some(line => /remove .*old/.test(line)));
  assert.ok(fs.existsSync(path.join(root, 'old')));
  assert.equal(cleanMain(['all', '--quiet'], io), 0);
  assert.equal(fs.existsSync(path.join(root, 'old')), false);
  assert.ok(out.some(line => /targets: 1 action/.test(line)));
  assert.equal(cleanMain(['docker'], io), 0);
  assert.ok(out.some(line => /docker builder prune: ok/.test(line)));
  const empty = { ...io, env: { INFRA_CLEAN_DIR: path.join(state, 'none') } };
  assert.equal(cleanMain(['targets'], empty), 0);
  assert.match(err.at(-1), /no roots configured/);
});
