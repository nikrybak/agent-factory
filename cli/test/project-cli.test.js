'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const CLI = path.join(__dirname, '..', 'bin', 'infra.js');

function makeBase() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'city-fabric-project-cli-'));
  fs.mkdirSync(path.join(root, 'cli', 'bin'), { recursive: true });
  fs.writeFileSync(path.join(root, 'cli', 'bin', 'infra.js'), '// marker\n');
  fs.writeFileSync(path.join(root, 'AGENTS.md'), '# Project Agent Contract\nFactory City\n');
  const child = path.join(root, 'app_entry_root', 'mobile-client');
  fs.mkdirSync(path.join(child, '_project'), { recursive: true });
  fs.mkdirSync(path.join(root, 'app_entry_root', '_registry'), { recursive: true });
  fs.writeFileSync(path.join(root, 'app_entry_root', '_registry', 'registry.json'), JSON.stringify({
    schemaVersion: '1.0.0',
    projects: [{
      key: 'mobile-client', presentLocally: false,
      app: { active: 'v1', versions: [{ id: 'v1' }] },
      market: { stores: ['google-play'], locales: ['en-GB', 'ru-RU'] },
      runtime: { ai: { mode: 'advisory', capabilityPacks: ['unity-mobile-game'] }, platforms: ['android', 'ios'] },
    }],
  }, null, 2));
  return { root, child };
}

function run(root, args) {
  return spawnSync(process.execPath, [CLI, 'project', ...args], { cwd: root, encoding: 'utf8' });
}

test('project CLI resolves, lists, derives paths and scans by key', t => {
  const { root, child } = makeBase();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const resolved = run(root, ['resolve', '--cwd', child, '--json']);
  assert.equal(resolved.status, 0, resolved.stderr);
  const context = JSON.parse(resolved.stdout);
  assert.equal(context.key, 'mobile-client');
  assert.equal(context.runtime.platforms[1], 'ios');

  const byKey = run(root, ['resolve', 'mobile-client', '--cwd', root, '--json']);
  assert.equal(byKey.status, 0, byKey.stderr);
  assert.equal(JSON.parse(byKey.stdout).key, 'mobile-client');

  const listed = run(root, ['list', '--cwd', child]);
  assert.equal(listed.status, 0, listed.stderr);
  assert.equal(JSON.parse(listed.stdout)[0].key, 'mobile-client');

  const paths = run(root, ['paths', 'mobile-client', '--cwd', child]);
  assert.equal(paths.status, 0, paths.stderr);
  assert.equal(
    JSON.parse(paths.stdout).outputRoot,
    path.join(root, 'app_entry_root', 'mobile-client', '_output', 'mobile-client-v1'),
  );

  const drifted = run(root, ['scan', '--cwd', child]);
  assert.notEqual(drifted.status, 0);
  assert.match(drifted.stderr, /market text directories are absent for google-play: en-GB, ru-RU/);

  const market = run(root, ['market', 'mobile-client', '--init', '--json', '--cwd', child]);
  assert.equal(market.status, 0, market.stderr);
  const created = JSON.parse(market.stdout);
  assert.equal(created.targets.length, 2);
  assert.ok(created.created.includes(path.join(child, '_project', 'market', 'google-play', 'ru-RU', '.gitkeep')));

  const human = run(root, ['market', 'mobile-client', '--cwd', child]);
  assert.equal(human.status, 0, human.stderr);
  assert.match(human.stdout, /market mobile-client v1: 1 store\(s\) × 2 locale\(s\)/);
  assert.doesNotMatch(human.stdout, /created/);

  const scanned = run(root, ['scan', '--cwd', child]);
  assert.equal(scanned.status, 0, scanned.stderr);
  assert.match(scanned.stdout, /matches local child layout/);
});

test('project CLI rejects a paths query for an unknown key', t => {
  const { root } = makeBase();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const result = run(root, ['paths', 'missing']);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /not registered/);
});

test('project CLI market requires a key and a declared market', t => {
  const { root } = makeBase();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const usage = run(root, ['market']);
  assert.notEqual(usage.status, 0);
  assert.match(usage.stderr, /usage: infra project market <key>/);
  const unknown = run(root, ['market', 'missing']);
  assert.notEqual(unknown.status, 0);
  assert.match(unknown.stderr, /not registered/);
  const badVersion = run(root, ['market', 'mobile-client', '--version', 'v7']);
  assert.notEqual(badVersion.status, 0);
  assert.match(badVersion.stderr, /has no version: v7/);
});

test('project CLI fails closed when the registry is malformed', t => {
  const { root } = makeBase();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(path.join(root, 'app_entry_root', '_registry', 'registry.json'), '{ nope');
  const result = run(root, ['resolve', 'mobile-client', '--cwd', root]);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /registry unreadable/);
});

test('project CLI resolves a working directory inside a shared package', t => {
  const { root } = makeBase();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const packageRoot = path.join(root, 'app_entry_root', 'packages', 'nrg-shield');
  fs.mkdirSync(path.join(packageRoot, 'src'), { recursive: true });
  const json = run(root, ['resolve', '--cwd', path.join(packageRoot, 'src'), '--json']);
  assert.equal(json.status, 0, json.stderr);
  const context = JSON.parse(json.stdout);
  assert.equal(context.scope, 'package');
  assert.equal(context.packageName, 'nrg-shield');
  assert.equal(context.packageRoot, packageRoot);

  const text = run(root, ['resolve', '--cwd', packageRoot]);
  assert.equal(text.status, 0, text.stderr);
  assert.match(text.stdout, /project scope: package \(package nrg-shield\)/);
  assert.match(text.stdout, /package root: /);

});
