'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const memo = require('../lib/node-test-memo');
const trace = require('../lib/test-trace');
const runner = require('../../scripts/run_node_tests');

const { closure, createContext, findResult, planNodeTests, recordPass, recordResult, resolveLocal, testKey } = memo;

function project(t) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'node-memo-')));
  const cache = fs.mkdtempSync(path.join(os.tmpdir(), 'node-memo-cache-'));
  t.after(() => { fs.rmSync(root, { recursive: true, force: true }); fs.rmSync(cache, { recursive: true, force: true }); });
  const write = (file, text) => {
    fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    fs.writeFileSync(path.join(root, file), text);
  };
  write('lib/a.js', "module.exports = require('./b');");
  write('lib/b.js', 'module.exports = 1;');
  write('lib/data.json', '{}');
  write('lib/dir/index.js', "module.exports = require('../data.json');");
  write('lib/reads-repo.js', "module.exports = require('node:path').join(__dirname, 'x');");
  write('test/pure.test.js', "require('../lib/a'); require('../lib/dir'); require('node:fs');");
  write('test/bound.test.js', "require('../lib/reads-repo');");
  write('test/whole.test.js', "// node-test-memo: whole-tree\nrequire('../lib/reads-repo');");
  write('docs/readme.md', 'v1');
  const env = { INFRA_NODE_TEST_CACHE_DIR: cache };
  return { root, cache, write, env, context: () => createContext(root, { env }) };
}

/** Run one script under the tracer exactly as the runner does and return what recordPass needs. */
function tracedRun(root, file, extraEnv = {}) {
  const dir = trace.newTraceDir();
  const startedAt = Date.now();
  const result = spawnSync(process.execPath, [file], {
    cwd: root, env: trace.traceEnv(dir, [root], { ...process.env, ...extraEnv }), encoding: 'utf8',
  });
  const events = trace.parseTrace(dir);
  fs.rmSync(dir, { recursive: true, force: true });
  return { result, events, startedAt, staticFiles: closure(path.join(root, file)), ms: 1, treeFile: file };
}

function recordRun(t, ctx, root, file, label = 'file', extraEnv = {}) {
  const run = tracedRun(root, file, extraEnv);
  assert.equal(run.result.status, 0, run.result.stderr);
  return recordPass(ctx, label, file, run);
}

test('closure follows relative requires through files, json and index modules', t => {
  const { root } = project(t);
  const files = closure(path.join(root, 'test/pure.test.js')).map(file => path.relative(root, file).replace(/\\/g, '/'));
  assert.deepEqual(files, ['lib/a.js', 'lib/b.js', 'lib/data.json', 'lib/dir/index.js', 'test/pure.test.js']);
  assert.equal(resolveLocal(path.join(root, 'test/x.js'), '../missing'), null);
});

test('tree keys: pure files follow their closure, bound ones the code tree, whole-tree readers the whole tree', t => {
  const { root, write } = project(t);
  let tree = 'tree-1';
  let code = 'code-1';
  const treeHash = () => tree;
  const codeHash = () => code;
  const pure = testKey(root, 'test/pure.test.js', { codeHash, treeHash });
  const bound = testKey(root, 'test/bound.test.js', { codeHash, treeHash });
  const whole = testKey(root, 'test/whole.test.js', { codeHash, treeHash });
  assert.equal(pure.bound, false);
  assert.equal(bound.bound, true);
  assert.equal(testKey(root, 'test/pure.test.js', { codeHash, treeHash, forceBound: true }).bound, true);
  tree = 'tree-2';
  assert.equal(testKey(root, 'test/bound.test.js', { codeHash, treeHash }).key, bound.key, 'journal-only change');
  assert.notEqual(testKey(root, 'test/whole.test.js', { codeHash, treeHash }).key, whole.key, 'whole-tree reader');
  code = 'code-2';
  assert.equal(testKey(root, 'test/pure.test.js', { codeHash, treeHash }).key, pure.key);
  assert.notEqual(testKey(root, 'test/bound.test.js', { codeHash, treeHash }).key, bound.key);
  write('lib/b.js', 'module.exports = 2;');
  assert.notEqual(testKey(root, 'test/pure.test.js', { codeHash, treeHash }).key, pure.key);
  assert.notEqual(testKey(root, 'test/pure.test.js', { treeHash, nodeVersion: 'v0' }).key, testKey(root, 'test/pure.test.js', { treeHash }).key);
  assert.equal(typeof testKey(root, 'test/bound.test.js').key, 'string');
});

test('a pass is reused until a file it read changes, and only for the tests that read it', t => {
  const { root, write, env, context } = project(t);
  write('lib/x.js', 'module.exports = 1;');
  write('docs/a.md', 'a1');
  write('docs/b.md', 'b1');
  write('test/readsA.test.js', "require('../lib/x'); require('node:fs').readFileSync(require('node:path').join(__dirname, '..', 'docs', 'a.md'));");
  write('test/readsB.test.js', "require('node:fs').readFileSync(require('node:path').join(__dirname, '..', 'docs', 'b.md'));");
  const files = ['test/readsA.test.js', 'test/readsB.test.js'];
  assert.deepEqual(planNodeTests(root, files, { env }).pending.sort(), files);
  for (const file of files) assert.equal(recordRun(t, context(), root, file), 'trace');
  assert.deepEqual(planNodeTests(root, files, { env }).pending, []);

  write('docs/readme.md', 'unrelated edit');
  write('docs/operations/MEMORY.md', 'journal edit');
  assert.deepEqual(planNodeTests(root, files, { env }).pending, [], 'files nobody read');

  write('docs/a.md', 'a2');
  assert.deepEqual(planNodeTests(root, files, { env }).pending, ['test/readsA.test.js']);
  write('docs/a.md', 'a1');
  assert.deepEqual(planNodeTests(root, files, { env }).pending, [], 'the stored variant matches again');

  write('lib/x.js', 'module.exports = 2;');
  assert.deepEqual(planNodeTests(root, files, { env }).pending, ['test/readsA.test.js'], 'a loaded module');
  recordRun(t, context(), root, 'test/readsA.test.js');
  write('lib/x.js', 'module.exports = 1;');
  assert.deepEqual(planNodeTests(root, files, { env }).pending, [], 'both variants are kept');
});

test('a probe of an absent path and a directory listing are inputs too', t => {
  const { root, write, env, context } = project(t);
  write('docs/list/one.md', '1');
  write('test/probe.test.js', "require('node:fs').existsSync(require('node:path').join(__dirname, '..', 'docs', 'new.md'));");
  write('test/list.test.js', "require('node:fs').readdirSync(require('node:path').join(__dirname, '..', 'docs', 'list'));");
  const files = ['test/probe.test.js', 'test/list.test.js'];
  for (const file of files) recordRun(t, context(), root, file);
  write('docs/list/one.md', 'edited, same listing');
  assert.deepEqual(planNodeTests(root, files, { env }).pending, []);
  write('docs/new.md', 'now it exists');
  assert.deepEqual(planNodeTests(root, files, { env }).pending, ['test/probe.test.js']);
  write('docs/list/two.md', '2');
  assert.deepEqual(planNodeTests(root, files, { env }).pending, files);
});

test('python: pathlib probes, reads and listings are traced like node ones (absent file, read_text, iterdir)', t => {
  const python = process.env.INFRA_TEST_PYTHON || (process.platform === 'win32' ? 'python' : 'python3');
  if (spawnSync(python, ['--version'], { encoding: 'utf8' }).status !== 0) { t.skip('no python on this machine'); return; }
  const { root, write } = project(t);
  write('docs/list/one.md', '1');
  write('test/probe_test.py', [
    'from pathlib import Path',
    'root = Path(__file__).resolve().parent.parent',
    "assert not (root / 'docs' / 'absent.md').exists()",
    "(root / 'docs' / 'readme.md').read_text()",
    "list((root / 'docs' / 'list').iterdir())",
  ].join('\n'));
  const dir = trace.newTraceDir();
  const result = spawnSync(python, [path.join(root, 'test', 'probe_test.py')], {
    cwd: root, env: trace.traceEnv(dir, [root], process.env), encoding: 'utf8',
  });
  const events = trace.parseTrace(dir);
  fs.rmSync(dir, { recursive: true, force: true });
  assert.equal(result.status, 0, result.stderr);
  const inputs = trace.analyzeTrace(events, []).inputs.map(item => item.path);
  for (const expected of ['docs/absent.md', 'docs/readme.md', 'docs/list']) {
    assert.ok(inputs.includes(expected), `${expected} is an input (got ${JSON.stringify(inputs)})`);
  }
});

test('paths the run created before reading them are outputs, not inputs', t => {
  const { root, write, env, context } = project(t);
  write('test/out.test.js', [
    "const fs = require('node:fs'); const path = require('node:path');",
    "const out = path.join(__dirname, '..', 'out');",
    'fs.mkdirSync(out, { recursive: true });',
    "fs.writeFileSync(path.join(out, 'result.txt'), String(Date.now()));",
    "fs.readFileSync(path.join(out, 'result.txt'), 'utf8');",
  ].join('\n'));
  assert.equal(recordRun(t, context(), root, 'test/out.test.js'), 'trace');
  assert.deepEqual(planNodeTests(root, ['test/out.test.js'], { env }).pending, []);
  write('out/result.txt', 'changed by somebody else');
  assert.deepEqual(planNodeTests(root, ['test/out.test.js'], { env }).pending, [], 'its own output is not an input');
});

test('node children are followed even when the test replaces their environment', t => {
  const { root, write, env, context } = project(t);
  write('docs/child.md', 'c1');
  write('lib/child.js', "require('node:fs').readFileSync(require('node:path').join(__dirname, '..', 'docs', 'child.md'));");
  write('test/parent.test.js', [
    "const { spawnSync } = require('node:child_process'); const path = require('node:path');",
    "const r = spawnSync(process.execPath, [path.join(__dirname, '..', 'lib', 'child.js')], { env: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot } });",
    'if (r.status !== 0) process.exit(1);',
  ].join('\n'));
  assert.equal(recordRun(t, context(), root, 'test/parent.test.js'), 'trace');
  assert.deepEqual(planNodeTests(root, ['test/parent.test.js'], { env }).pending, []);
  write('docs/child.md', 'c2');
  assert.deepEqual(planNodeTests(root, ['test/parent.test.js'], { env }).pending, ['test/parent.test.js']);
});

test('a program other than node started in the repository falls back to the tree key', t => {
  const { root, write, env, context } = project(t);
  write('test/git.test.js', "require('node:child_process').spawnSync('git', ['--version'], { cwd: require('node:path').join(__dirname, '..') });");
  assert.equal(recordRun(t, context(), root, 'test/git.test.js'), 'tree');
  assert.deepEqual(planNodeTests(root, ['test/git.test.js'], { env }).pending, []);
  write('docs/operations/MEMORY.md', 'journals are not part of the code tree');
  assert.deepEqual(planNodeTests(root, ['test/git.test.js'], { env }).pending, []);
  write('docs/readme.md', 'any other edit');
  assert.deepEqual(planNodeTests(root, ['test/git.test.js'], { env }).pending, ['test/git.test.js']);
});

test('a program that never started read nothing: a run that probes a missing command stays traceable', t => {
  const { root, write, context } = project(t);
  write('test/missing.test.js', [
    "const { spawn, spawnSync, execFileSync } = require('node:child_process');",
    "spawnSync('definitely-not-a-command-xyz', ['--x']);",
    "try { execFileSync('definitely-not-a-command-xyz'); } catch (error) { if (error.code !== 'ENOENT') throw error; }",
    "spawn('definitely-not-a-command-xyz').on('error', () => {});",
  ].join('\n'));
  assert.equal(recordRun(t, context(), root, 'test/missing.test.js'), 'trace');
  write('test/started.test.js', "require('node:child_process').spawn('git', ['--version']).on('error', () => {});");
  assert.equal(recordRun(t, context(), root, 'test/started.test.js'), 'tree', 'a program that did start stays opaque');
});

test('a watch is a read of the watched path: outside the repository it is nothing, inside it is an input', t => {
  const { root, write, env, context } = project(t);
  write('docs/watched/one.md', '1');
  write('test/watch.test.js', [
    "const fs = require('node:fs'); const os = require('node:os'); const path = require('node:path');",
    "const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'memo-watch-'));",
    'fs.watch(outside).close();',
    "fs.watch(path.join(__dirname, '..', 'docs', 'watched')).close();",
    'fs.rmSync(outside, { recursive: true, force: true });',
  ].join('\n'));
  assert.equal(recordRun(t, context(), root, 'test/watch.test.js'), 'trace');
  assert.deepEqual(planNodeTests(root, ['test/watch.test.js'], { env }).pending, []);
  write('docs/watched/two.md', '2');
  assert.deepEqual(planNodeTests(root, ['test/watch.test.js'], { env }).pending, ['test/watch.test.js']);
});

test('a whole-tree reader is keyed by the complete tree even when its trace is clean', t => {
  const { root, write, env, context } = project(t);
  assert.equal(recordPass(context(), 'file', 'test/whole.test.js', { ...tracedRun(root, 'test/whole.test.js'), wholeTree: true }), 'tree');
  assert.deepEqual(planNodeTests(root, ['test/whole.test.js'], { env }).pending, []);
  write('docs/operations/MEMORY.md', 'snapshot 2');
  assert.deepEqual(planNodeTests(root, ['test/whole.test.js'], { env }).pending, ['test/whole.test.js']);
});

test('nothing is stored when an input was modified while the run was going', t => {
  const { root, context } = project(t);
  const run = tracedRun(root, 'test/pure.test.js');
  // as if the run had read everything a minute ago: the files are newer than their reads
  const earlier = { ...run, startedAt: run.startedAt - 60000, events: run.events.map(event => ({ ...event, time: event.time - 60000 })) };
  assert.equal(recordPass(context(), 'file', 'test/pure.test.js', earlier), null);
  assert.equal(memo.readEntry(context().dir, 'file', 'test/pure.test.js'), null);
});

test('a run that rewrites something it read is not stored', t => {
  const { root, write, context } = project(t);
  write('docs/state.json', '{"n":1}');
  write('test/rmw.test.js', [
    "const fs = require('node:fs'); const file = require('node:path').join(__dirname, '..', 'docs', 'state.json');",
    "fs.writeFileSync(file, JSON.stringify({ n: JSON.parse(fs.readFileSync(file, 'utf8')).n + 1 }));",
  ].join('\n'));
  assert.equal(recordRun(t, context(), root, 'test/rmw.test.js'), null);
});

test('only passes are stored and an unrelated node version never matches', t => {
  const { root, env, context } = project(t);
  recordRun(t, context(), root, 'test/pure.test.js');
  assert.deepEqual(planNodeTests(root, ['test/pure.test.js'], { env }).pending, []);
  assert.equal(memo.readEntry(context().dir, 'file', 'test/pure.test.js', 'v0.0.0'), null);
  assert.notEqual(memo.entryFile(context().dir, 'file', 'a.js'), memo.entryFile(context().dir, 'coverage', 'a.js'));
});

test('a stored result (the coverage report) is reused only while its inputs are unchanged', t => {
  const { root, write, context } = project(t);
  write('lib/cov.js', 'module.exports = 1;');
  write('test/cov.test.js', "require('../lib/cov');");
  const run = tracedRun(root, 'test/cov.test.js');
  assert.equal(findResult(context(), 'coverage', 'set-1', 'test/cov.test.js'), null);
  assert.equal(recordResult(context(), 'coverage', 'set-1', run, 'all files | 99 | 98 | 97 |'), 'trace');
  assert.equal(findResult(context(), 'coverage', 'set-1', 'test/cov.test.js'), 'all files | 99 | 98 | 97 |');
  write('docs/readme.md', 'unrelated');
  assert.equal(findResult(context(), 'coverage', 'set-1', 'test/cov.test.js'), 'all files | 99 | 98 | 97 |');
  write('lib/cov.js', 'module.exports = 2;');
  assert.equal(findResult(context(), 'coverage', 'set-1', 'test/cov.test.js'), null);
});

test('analyzeTrace drops outputs, keeps the earliest read and reports what it cannot follow', () => {
  const events = [
    { kind: 'R', time: 1, text: 'a.txt' },
    { kind: 'W', time: 2, text: 'a.txt' },
    { kind: 'R', time: 3, text: 'made/child.txt' },
    { kind: 'W', time: 2.5, text: 'made' },
    { kind: 'R', time: 1, text: 'made/early.txt' },
    { kind: 'D', time: 4, text: 'tree' },
    { kind: 'R', time: 5, text: 'tree' },
    { kind: 'S', time: 6, text: 'git' },
    { kind: 'X', time: 7, text: 'fs.watch' },
  ];
  const result = trace.analyzeTrace(events, ['lib\\x.js']);
  assert.deepEqual(result.inputs.map(item => [item.path, item.deep]),
    [['a.txt', false], ['lib/x.js', false], ['made/early.txt', false], ['tree', true]]);
  assert.deepEqual(result.opaque, ['S:git', 'X:fs.watch']);
});

test('the file hash cache reuses a hash only while size and mtime hold, and never trusts a file written just before a save', t => {
  const { root, write } = project(t);
  write('docs/a.md', 'one');
  const store = path.join(root, '.hash-cache.json');
  const file = path.join(root, 'docs', 'a.md');
  const old = new Date(Date.now() - 60_000);
  fs.utimesSync(file, old, old);
  const first = new trace.FileHashCache(store);
  const hash = first.hashOf(file, fs.statSync(file));
  first.save();
  // a reload reuses it without reading: prove it by giving the cache a stale content it could only have kept
  const second = new trace.FileHashCache(store);
  assert.equal(second.hashOf(file, fs.statSync(file)), hash);
  fs.writeFileSync(file, 'two!');
  fs.utimesSync(file, old, new Date(Date.now() - 50_000));
  assert.notEqual(new trace.FileHashCache(store).hashOf(file, fs.statSync(file)), hash, 'a new size or mtime is hashed again');
  // a file modified right before the save is dropped on load (same-tick writes keep size and mtime)
  const fresh = path.join(root, 'docs', 'b.md');
  write('docs/b.md', 'x');
  const racy = new trace.FileHashCache(store);
  racy.hashOf(fresh, fs.statSync(fresh));
  racy.save();
  assert.equal(new trace.FileHashCache(store).entries.has(fresh), false);
});

test('a write outside the repository never counts as a rewrite of the repository root it listed', () => {
  const events = [
    { kind: 'R', time: 1, text: '.' },
    { kind: 'W', time: 2, text: '@V:/dev/tmp/secret-tool-test-1/gradle.properties' },
  ];
  const result = trace.analyzeTrace(events, []);
  assert.equal(result.mutated, false, 'a temp folder of the test is not the root it read');
  assert.deepEqual(result.mutatedPaths, []);
  const inside = trace.analyzeTrace([{ kind: 'R', time: 1, text: '.' }, { kind: 'W', time: 2, text: 'out/x.txt' }], []);
  assert.equal(inside.mutated, true, 'a write inside the listed root still is');
  assert.deepEqual(inside.mutatedPaths, ['.']);
});

test('fingerprints tell files, listings, subtrees and absent paths apart', t => {
  const { root, write } = project(t);
  write('docs/sub/x.md', 'x');
  const first = new trace.Fingerprints(root);
  const file = first.of('docs/readme.md', false).fp;
  const listing = first.of('docs', false).fp;
  const subtree = first.of('docs', true).fp;
  assert.equal(first.of('docs/missing.md', false).fp, '-');
  write('docs/sub/x.md', 'y');
  const second = new trace.Fingerprints(root);
  assert.equal(second.of('docs/readme.md', false).fp, file);
  assert.equal(second.of('docs', false).fp, listing, 'a listing ignores content');
  assert.notEqual(second.of('docs', true).fp, subtree, 'a subtree does not');
  assert.equal(trace.snapshotMatches([['docs/readme.md', 0, file]], second), true);
  assert.equal(trace.snapshotMatches([], second), false);
});

test('a failing test file does not stop the passes of the others from being stored', async t => {
  const { root, write, cache } = project(t);
  write('cli/test/good.test.js', "require('node:test')('ok', () => {});");
  write('cli/test/bad.test.js', "require('node:test')('bad', () => { throw new Error('nope'); });");
  const tests = ['cli/test/bad.test.js', 'cli/test/good.test.js'];
  const previous = process.env.INFRA_NODE_TEST_CACHE_DIR;
  process.env.INFRA_NODE_TEST_CACHE_DIR = cache;
  try {
    const quiet = () => {};
    assert.equal(await runner.runPlain(root, tests, true, quiet), 1);
    const plan = planNodeTests(root, tests, { env: { INFRA_NODE_TEST_CACHE_DIR: cache } });
    assert.deepEqual(plan.proven, ['cli/test/good.test.js']);
    assert.deepEqual(plan.pending, ['cli/test/bad.test.js']);
    assert.equal(await runner.runPlain(root, tests, true, quiet), 1, 'the failure is never cached');
  } finally {
    if (previous === undefined) delete process.env.INFRA_NODE_TEST_CACHE_DIR; else process.env.INFRA_NODE_TEST_CACHE_DIR = previous;
  }
});
