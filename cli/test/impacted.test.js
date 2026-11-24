'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const {
  cargoArgs, cargoMembers, changedFiles, closure, flavors, gradleModules, impacted, impactedMain, owner, select,
} = require('../lib/impacted');

function git(repo, ...args) {
  const result = spawnSync('git', ['-C', repo, ...args], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout;
}

function repo(t, files) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'impacted-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  for (const [file, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    fs.writeFileSync(path.join(root, file), text);
  }
  git(root, 'init', '-q', '-b', 'dev');
  git(root, '-c', 'user.name=t', '-c', 'user.email=t@t', 'add', '-A');
  git(root, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', 'base');
  return root;
}

function write(root, file, text) {
  fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
  fs.writeFileSync(path.join(root, file), text);
}

// Fake `cargo metadata --no-deps`: core <- api <- player, and an unrelated tool.
function fakeCargo(root) {
  const pkg = (name, dir, deps) => ({
    name,
    manifest_path: path.join(root, dir, 'Cargo.toml'),
    dependencies: deps.map(dep => ({ name: dep, path: path.join(root, dep === 'core' ? 'crates/core' : `crates/${dep}`) }))
      .concat([{ name: 'serde' }]),
  });
  const metadata = {
    workspace_root: root,
    packages: [pkg('core', 'crates/core', []), pkg('api', 'crates/api', ['core']), pkg('player', 'bins/player', ['api']), pkg('tool', 'crates/tool', [])],
  };
  return () => ({ status: 0, stdout: JSON.stringify(metadata), stderr: '' });
}

test('changed files include committed, staged, unstaged and untracked work', t => {
  const root = repo(t, { 'a.txt': '1', 'b.txt': '1' });
  git(root, 'checkout', '-q', '-b', 'feature');
  write(root, 'a.txt', '2');
  git(root, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qam', 'a');
  write(root, 'b.txt', '2');
  write(root, 'new/c.txt', 'x');
  assert.deepEqual(changedFiles(root, 'dev'), ['a.txt', 'b.txt', 'new/c.txt']);
  assert.deepEqual(changedFiles(root), ['b.txt', 'new/c.txt']);
  assert.throws(() => changedFiles(root, 'missing-ref'), /git diff/);
  assert.deepEqual(changedFiles(path.join(root, 'new')), ['c.txt']);
});

test('cargo selection follows reverse path dependencies and widens on shared inputs', t => {
  const root = repo(t, { 'Cargo.toml': '[workspace]', 'crates/core/src/lib.rs': '', 'crates/tool/src/lib.rs': '' });
  const members = cargoMembers(root, fakeCargo(root));
  assert.deepEqual(members.find(m => m.name === 'player').deps, ['api']);
  assert.deepEqual(select(['crates/core/src/lib.rs'], members, [/^Cargo\.lock$/]), { all: false, members: ['core', 'api', 'player'] });
  assert.deepEqual(select(['crates/tool/src/x.rs'], members, [/^Cargo\.lock$/]).members, ['tool']);
  assert.deepEqual(select(['docs/readme.md'], members, [/^Cargo\.lock$/]).members, []);
  assert.equal(select(['Cargo.lock'], members, [/^Cargo\.lock$/]).all, true);
  assert.equal(select([], [], []), null);
  write(root, 'crates/api/src/lib.rs', 'changed');
  const report = impacted(root, { run: fakeCargo(root) });
  assert.deepEqual(report.cargo.members, ['api', 'player']);
  assert.equal(cargoArgs(report.cargo), '-p api -p player');
  assert.equal(cargoArgs({ all: true, members: [] }), '--workspace');
  assert.equal(cargoArgs(null), null);
  assert.throws(() => cargoMembers(root, () => ({ status: 101, stderr: 'no cargo' })), /cargo metadata failed/);
});

test('owner picks the deepest member and closure is stable', () => {
  const members = [{ name: 'root', dir: '', deps: [] }, { name: 'a', dir: 'crates/a', deps: [] }, { name: 'b', dir: 'crates/a/b', deps: ['a'] }];
  assert.equal(owner('crates/a/b/src/x.rs', members).name, 'b');
  assert.equal(owner('crates/a/src/x.rs', members).name, 'a');
  assert.equal(owner('README.md', members).name, 'root');
  assert.deepEqual(closure(['a'], members), ['a', 'b']);
  assert.deepEqual(select(['README.md'], [{ name: 'only', dir: '', deps: [] }], []).members, ['only']);
});

test('gradle modules, project dependencies and android flavors are detected', t => {
  const root = repo(t, {
    'settings.gradle.kts': 'rootProject.name = "x"\ninclude(":app", ":core:net")\ninclude ":sdk"\n',
    'app/build.gradle.kts': 'dependencies { implementation(project(":core:net")); implementation(project(path = ":sdk")) }',
    'core/net/build.gradle.kts': '',
    'sdk/build.gradle': '',
  });
  const modules = gradleModules(root);
  assert.deepEqual(modules.map(m => m.name), [':app', ':core:net', ':sdk']);
  assert.deepEqual(modules[0].deps, [':core:net', ':sdk']);
  assert.deepEqual(select(['core/net/src/main/java/A.java'], modules, []).members, [':app', ':core:net']);
  assert.deepEqual(flavors(['app/src/main/A.java', 'app/src/huawei/B.java', 'app/src/testRustore/C.java', 'app/src/test/D.java', 'x.md']),
    ['huawei', 'rustore', 'shared']);
  assert.deepEqual(gradleModules(fs.mkdtempSync(path.join(os.tmpdir(), 'no-gradle-'))), []);
});

test('impactedMain prints text, json and errors', t => {
  const root = repo(t, { 'Cargo.toml': '[workspace]', 'crates/core/src/lib.rs': '' });
  write(root, 'crates/core/src/lib.rs', 'changed');
  write(root, 'app/src/google/X.java', 'x');
  const out = [];
  const err = [];
  const io = { cwd: root, out: line => out.push(line), err: line => err.push(line), run: fakeCargo(root) };
  assert.equal(impactedMain([], io), 0);
  assert.ok(out.some(line => line === 'cargo: -p core -p api -p player'));
  assert.ok(out.some(line => /android source sets: google/.test(line)));
  assert.equal(impactedMain(['--json'], io), 0);
  assert.equal(JSON.parse(out.at(-1)).cargoArgs, '-p core -p api -p player');
  assert.equal(impactedMain(['--help'], io), 0);
  assert.equal(impactedMain(['--base', 'nope'], io), 1);
  assert.match(err.at(-1), /\[impacted\]/);
  const plain = repo(t, { 'readme.md': 'x' });
  const plainOut = [];
  assert.equal(impactedMain([], { cwd: plain, out: line => plainOut.push(line), err: () => {} }), 0);
  assert.deepEqual(plainOut, ['[impacted] 0 changed file(s)']);
});
