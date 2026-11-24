'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { spawnSync } = require('node:child_process');
const { cacheRoot, digests, hashFiles, isCached, plan, record, testcacheMain, trackedFiles } = require('../lib/testcache');

function write(root, file, text) {
  fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
  fs.writeFileSync(path.join(root, file), text);
}

function workspace(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'testcache-'));
  const cache = fs.mkdtempSync(path.join(os.tmpdir(), 'testcache-store-'));
  t.after(() => { fs.rmSync(root, { recursive: true, force: true }); fs.rmSync(cache, { recursive: true, force: true }); });
  for (const [file, text] of Object.entries({
    'Cargo.toml': '[workspace]', 'Cargo.lock': 'v1', 'openapi/openapi.yaml': 'v1', 'README.md': 'docs',
    'crates/core/src/lib.rs': 'core', 'crates/api/src/lib.rs': 'api', 'bins/player/src/main.rs': 'player', 'crates/tool/src/lib.rs': 'tool',
  })) write(root, file, text);
  spawnSync('git', ['-C', root, 'init', '-q', '-b', 'dev']);
  spawnSync('git', ['-C', root, '-c', 'user.name=t', '-c', 'user.email=t@t', 'add', '-A']);
  spawnSync('git', ['-C', root, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', 'base']);
  return { root, env: { ...process.env, INFRA_TESTCACHE_DIR: cache } };
}

// Fake cargo metadata (core <- api <- player, tool alone) and rustc; git runs for real.
function runner(root, rustc = 'rustc 1.99.0') {
  const pkg = (name, dir, deps) => ({
    name, manifest_path: path.join(root, dir, 'Cargo.toml'),
    dependencies: deps.map(dep => ({ name: dep, path: path.join(root, dep === 'core' ? 'crates/core' : 'crates/api') })),
  });
  const metadata = { workspace_root: root, packages: [pkg('core', 'crates/core', []), pkg('api', 'crates/api', ['core']), pkg('player', 'bins/player', ['api']), pkg('tool', 'crates/tool', [])] };
  return (command, args, options) => {
    if (command === 'cargo') return { status: 0, stdout: JSON.stringify(metadata), stderr: '' };
    if (command === 'rustc') return rustc ? { status: 0, stdout: rustc } : { status: 1, stdout: '' };
    return spawnSync(command, args, options);
  };
}

function fakeExec(code, calls) {
  return (command, args) => {
    calls.push([command, ...args]);
    const child = new EventEmitter();
    setImmediate(() => (code === 'error' ? child.emit('error', new Error('spawn failed')) : child.emit('exit', code, null)));
    return child;
  };
}

test('digests change with own files, dependencies and shared inputs, but not with docs', t => {
  const { root, env } = workspace(t);
  const run = runner(root);
  const first = plan(root, { all: true, env, run }).digests;
  write(root, 'README.md', 'more docs');
  write(root, 'docs/x.md', 'docs');
  assert.deepEqual(plan(root, { all: true, env, run }).digests, first);
  write(root, 'crates/api/src/lib.rs', 'api v2');
  const afterApi = plan(root, { all: true, env, run }).digests;
  assert.equal(afterApi.get('core'), first.get('core'));
  assert.equal(afterApi.get('tool'), first.get('tool'));
  assert.notEqual(afterApi.get('api'), first.get('api'));
  assert.notEqual(afterApi.get('player'), first.get('player'));
  write(root, 'openapi/openapi.yaml', 'v2');
  const afterShared = plan(root, { all: true, env, run }).digests;
  assert.notEqual(afterShared.get('tool'), afterApi.get('tool'));
  const otherToolchain = plan(root, { all: true, env, run: runner(root, 'rustc 2.0') }).digests;
  assert.notEqual(otherToolchain.get('core'), afterShared.get('core'));
  const unknownToolchain = plan(root, { all: true, env, run: runner(root, null) }).digests;
  assert.notEqual(unknownToolchain.get('core'), afterShared.get('core'));
  const otherArgs = plan(root, { all: true, env, run, extra: ['--', '--ignored'] }).digests;
  assert.notEqual(otherArgs.get('core'), afterShared.get('core'));
});

test('passing runs are recorded and skipped next time; failures record nothing', async t => {
  const { root, env } = workspace(t);
  const run = runner(root);
  const out = [];
  const calls = [];
  const io = { cwd: root, env, out: line => out.push(line), err: () => {}, run };
  assert.equal(await testcacheMain(['cargo', '--all'], { ...io, exec: fakeExec(1, calls) }), 1);
  assert.deepEqual(calls[0], ['cargo', 'nextest', 'run', '-p', 'core', '-p', 'api', '-p', 'player', '-p', 'tool']);
  assert.equal(await testcacheMain(['cargo', '--all'], { ...io, exec: fakeExec(0, calls) }), 0);
  assert.ok(out.some(line => /recorded 4 passing/.test(line)));
  assert.equal(await testcacheMain(['cargo', '--all'], { ...io, exec: fakeExec(0, calls) }), 0);
  assert.equal(calls.length, 2);
  assert.ok(out.some(line => /4 already proven, 0 to run/.test(line)));
  write(root, 'crates/core/src/lib.rs', 'core v2');
  assert.equal(await testcacheMain(['cargo', '--all', '--runner', 'nextest'], { ...io, exec: fakeExec(0, calls) }), 0);
  assert.deepEqual(calls[2], ['cargo', 'nextest', 'run', '-p', 'core', '-p', 'api', '-p', 'player']);
  assert.ok(out.some(line => /skipped: tool/.test(line)));
});

test('impacted selection, test runner, extra args, dry run and errors', async t => {
  const { root, env } = workspace(t);
  const run = runner(root);
  write(root, 'crates/tool/src/lib.rs', 'tool v2');
  const out = [];
  const err = [];
  const calls = [];
  const io = { cwd: root, env, out: line => out.push(line), err: line => err.push(line), run, exec: fakeExec(0, calls) };
  assert.equal(await testcacheMain(['cargo', '--runner', 'test', '--dry-run', '--', '--', '--nocapture'], io), 0);
  assert.equal(calls.length, 0);
  assert.ok(out.some(line => line === '[testcache] $ cargo test -p tool -- --nocapture'));
  assert.equal(await testcacheMain(['cargo', '--runner', 'bogus'], io), 2);
  assert.equal(await testcacheMain(['npm'], io), 2);
  assert.equal(await testcacheMain(['cargo', '--base', 'missing-ref'], io), 1);
  assert.match(err.at(-1), /\[testcache\]/);
  assert.equal(await testcacheMain(['cargo'], { ...io, exec: fakeExec('error', calls) }), 127);
  const clean = workspace(t);
  const cleanOut = [];
  assert.equal(await testcacheMain(['cargo'], { cwd: clean.root, env: clean.env, out: line => cleanOut.push(line), err: () => {}, run: runner(clean.root) }), 0);
  assert.ok(cleanOut.some(line => /0 selected of 4/.test(line)));
});

test('helpers: tracked files, hashing, markers, cache root and cycles', t => {
  const { root, env } = workspace(t);
  assert.ok(trackedFiles(root).includes('crates/core/src/lib.rs'));
  assert.throws(() => trackedFiles(path.join(root, 'nope')), /git ls-files failed/);
  assert.notEqual(hashFiles(root, ['missing.txt']), hashFiles(root, ['Cargo.lock']));
  record(env.INFRA_TESTCACHE_DIR, 'ab'.repeat(32), { package: 'x' });
  assert.equal(isCached(env.INFRA_TESTCACHE_DIR, 'ab'.repeat(32)), true);
  assert.equal(isCached(env.INFRA_TESTCACHE_DIR, 'cd'.repeat(32)), false);
  assert.match(cacheRoot({}), /testcache$/);
  const cyclic = [{ name: 'a', dir: 'a', deps: ['b'] }, { name: 'b', dir: 'b', deps: ['a'] }];
  assert.throws(() => digests(root, cyclic, [], 'ctx'), /dependency cycle/);
});
