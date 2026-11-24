'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  DEFAULTS, desiredSlots, dindArgs, jitLabels, loadConfig, reconcile, runnerArgs, runnersMain, selectRepos, slotName,
} = require('../lib/runners');

function stateDir(t, config) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'runners-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  if (config) fs.writeFileSync(path.join(dir, 'runners.json'), JSON.stringify(config));
  return dir;
}

test('the machine config overrides the defaults and places the runtime next to it', t => {
  const dir = stateDir(t, { owner: 'someone', maxSlotsPerRepo: 4 });
  const config = loadConfig({ INFRA_CLEAN_DIR: dir });
  assert.equal(config.owner, 'someone');
  assert.equal(config.maxSlotsPerRepo, 4);
  assert.equal(config.minSlotsPerRepo, DEFAULTS.minSlotsPerRepo);
  assert.deepEqual(config.labels, DEFAULTS.labels);
  assert.equal(config.runtimeDir, path.join(dir, 'runners'));
  const missing = loadConfig({ INFRA_CLEAN_DIR: stateDir(t) });
  assert.equal(missing.owner, null);
  assert.ok(Object.isFrozen(missing));
});

test('slots are named per repository and numbered', () => {
  assert.equal(slotName('Worlio', 1), 'ghr-worlio-1');
  assert.equal(slotName('vc_enterprise_it_infra', 2), 'ghr-vc-enterprise-it-infra-2');
  assert.deepEqual(desiredSlots(['b', 'A'], 2).map(s => s.name), ['ghr-a-1', 'ghr-a-2', 'ghr-b-1', 'ghr-b-2']);
  assert.deepEqual(desiredSlots([], 2), []);
  assert.deepEqual(desiredSlots(['a', 'b'], { a: 2 }).map(s => s.name), ['ghr-a-1', 'ghr-a-2'], 'per-repository counts');
});

test('runners carry the hosted labels so workflows stay unchanged', () => {
  const labels = jitLabels(DEFAULTS);
  for (const label of ['self-hosted', 'Linux', 'X64', 'ubuntu-latest', 'ubuntu-24.04', 'infra-local']) {
    assert.ok(labels.includes(label), label);
  }
  assert.equal(new Set(labels).size, labels.length);
});

test('a slot is a runner sharing the network and work volume of its own Docker daemon', () => {
  const slot = desiredSlots(['repo'], 1)[0];
  const dind = dindArgs(slot, DEFAULTS);
  assert.ok(dind.includes('--privileged'));
  assert.ok(dind.includes('ghr-repo-1-work:/home/runner/_work'));
  assert.ok(dind.includes('ghr-repo-1-docker:/var/lib/docker'), 'the image cache survives jobs');
  assert.ok(dind.includes('--group=123'));
  const runner = runnerArgs(slot, DEFAULTS);
  assert.equal(runner[runner.indexOf('--network') + 1], 'container:ghr-repo-1-dind');
  assert.ok(runner.includes('ghr-repo-1-work:/home/runner/_work'));
  assert.ok(runner.includes('ghr-repo-1-sock:/var/run'));
  assert.ok(!runner.includes('--privileged'), 'only the daemon is privileged');
  const jit = runner.indexOf('INFRA_RUNNER_JITCONFIG');
  assert.equal(runner[jit - 1], '-e');
  assert.ok(!runner.some(a => a.startsWith('INFRA_RUNNER_JITCONFIG=')), 'the registration never appears in argv');
  assert.equal(runner[runner.length - 1], DEFAULTS.image);
});

test('reconcile starts missing slots, recreates finished pods and removes strays', () => {
  const slots = desiredSlots(['a'], 2);
  assert.deepEqual(reconcile(slots, []).map(a => `${a.kind}:${a.slot ? a.slot.name : a.name}`),
    ['fresh:ghr-a-1', 'dind:ghr-a-1', 'runner:ghr-a-1', 'fresh:ghr-a-2', 'dind:ghr-a-2', 'runner:ghr-a-2']);
  const containers = [
    { name: 'ghr-a-1-dind', state: 'running' }, { name: 'ghr-a-1', state: 'running' },
    { name: 'ghr-a-2-dind', state: 'running' }, { name: 'ghr-a-2', state: 'exited' },
    { name: 'ghr-old-1', state: 'running' },
  ];
  assert.deepEqual(reconcile(slots, containers).map(a => `${a.kind}:${a.slot ? a.slot.name : a.name}`),
    ['remove:ghr-old-1', 'remove:ghr-a-2', 'remove:ghr-a-2-dind', 'fresh:ghr-a-2', 'dind:ghr-a-2', 'runner:ghr-a-2'],
    'a finished job takes its whole pod with it');
  const deadDaemon = [{ name: 'ghr-a-1-dind', state: 'exited' }, { name: 'ghr-a-1', state: 'running' }];
  assert.deepEqual(reconcile(slots.slice(0, 1), deadDaemon).map(a => `${a.kind}:${a.slot ? a.slot.name : a.name}`),
    ['remove:ghr-a-1', 'remove:ghr-a-1-dind', 'fresh:ghr-a-1', 'dind:ghr-a-1', 'runner:ghr-a-1']);
  assert.deepEqual(reconcile(slots, containers.slice(0, 2).concat([
    { name: 'ghr-a-2-dind', state: 'running' }, { name: 'ghr-a-2', state: 'running' }])), []);
});

test('only private, active repositories with workflows get runners', () => {
  const repos = [
    { name: 'app', private: true, workflows: 3 },
    { name: 'site', private: false, workflows: 2 },
    { name: 'old', private: true, archived: true, workflows: 1 },
    { name: 'empty', private: true, workflows: 0 },
    { name: 'skip', private: true, workflows: 1 },
  ];
  assert.deepEqual(selectRepos(repos, { ...DEFAULTS, exclude: ['skip'] }), ['app']);
  assert.deepEqual(selectRepos(repos, { ...DEFAULTS, repos: ['skip'] }), ['skip']);
});

test('an unknown subcommand prints the usage', async t => {
  const errors = [];
  t.mock.method(console, 'error', message => errors.push(message));
  assert.equal(await runnersMain(['nope'], { INFRA_CLEAN_DIR: stateDir(t) }), 2);
  assert.match(errors[0], /usage: infra runners/);
});

test('the route variable is a JSON runs-on target for the local runners', () => {
  const { LOCAL_TARGET, RUNNER_VARIABLE } = require('../lib/runners');
  assert.equal(RUNNER_VARIABLE, 'CI_RUNNER');
  assert.deepEqual(JSON.parse(LOCAL_TARGET), ['self-hosted', 'infra-local']);
  assert.ok(jitLabels(DEFAULTS).includes('infra-local'), 'every local runner matches the route');
});

test('slots follow waiting jobs within the per-repository and total limits', () => {
  const { slotCounts } = require('../lib/runners');
  const config = { ...DEFAULTS, minSlotsPerRepo: 1, maxSlotsPerRepo: 3, maxSlots: 5 };
  assert.deepEqual(slotCounts(['a', 'b'], {}, config), { a: 1, b: 1 }, 'one idle slot each');
  assert.deepEqual(slotCounts(['a', 'b'], { demand: { a: 1 }, warm: { a: [1] } }, config), { a: 2, b: 1 },
    'a waiting job next to a busy slot gets a second slot');
  assert.deepEqual(slotCounts(['a', 'b'], { demand: { a: 9 } }, config), { a: 3, b: 1 }, 'capped per repository');
  assert.deepEqual(slotCounts(['a', 'b', 'c'], { demand: { a: 9, b: 9 } }, config), { a: 2, b: 2, c: 1 },
    'the total is trimmed from the largest repository first');
  assert.deepEqual(slotCounts(['a'], { warm: { a: [3] } }, config), { a: 3 }, 'a warm slot is never removed');
  assert.deepEqual(slotCounts(['a', 'b'], { warm: { a: [1, 2, 3], b: [1, 2, 3] } }, config), { a: 3, b: 3 },
    'warm slots stay even above the total');
});
