'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  assertChildKey, assertRelativePath, childPaths, findBaseRoot, initMarket, isBaseRoot, listProjects, marketPaths, normalizeRegistry, readRegistry,
  PACKAGES_DIR, resolveProject, resolveProjectKey, scanProjects, storeLocales, validateDeclaredCapabilityPacks, versionDirName,
} = require('../lib/project');

const CITY_ROOT = path.resolve(__dirname, '..', '..');

function makeBase(projects = []) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'city-fabric-project-'));
  fs.mkdirSync(path.join(root, 'cli', 'bin'), { recursive: true });
  fs.writeFileSync(path.join(root, 'cli', 'bin', 'infra.js'), '// stub\n');
  fs.writeFileSync(path.join(root, 'AGENTS.md'), '# Project Agent Contract\nFactory City\n');
  fs.mkdirSync(path.join(root, 'app_entry_root', '_registry'), { recursive: true });
  fs.writeFileSync(path.join(root, 'app_entry_root', '_registry', 'registry.json'), JSON.stringify({ schemaVersion: '1.0.0', projects }, null, 2));
  return root;
}

test('finds a Factory City base upward from a child path', t => {
  const root = makeBase();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const deep = path.join(root, 'app_entry_root', 'orders', 'client', 'src');
  fs.mkdirSync(deep, { recursive: true });
  assert.equal(findBaseRoot(deep), root);
  assert.equal(resolveProject(deep).scope, 'child');
});

test('does not confuse a non-City Factory sibling with a base root', t => {
  const root = makeBase();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(path.join(root, 'AGENTS.md'), '# Project Agent Contract\nBitrix24\n');
  assert.equal(findBaseRoot(root), null);
  assert.equal(resolveProject(root).scope, 'unknown');
});

test('base and registered child resolve to distinct knowledge roots', t => {
  const project = {
    key: 'orders', presentLocally: false,
    app: { active: 'v1', versions: [{ id: 'v1' }] },
    runtime: { ai: { mode: 'advisory', capabilityPacks: ['factory-city'] }, platforms: ['android', 'ios'] },
  };
  const root = makeBase([project]);
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, 'app_entry_root', 'orders', '_project'), { recursive: true });
  const base = resolveProject(root);
  const child = resolveProject(path.join(root, 'app_entry_root', 'orders', '_project'));
  assert.equal(base.scope, 'base');
  assert.equal(base.knowledgeRoot, root);
  assert.equal(child.scope, 'child');
  assert.equal(child.key, 'orders');
  assert.equal(child.knowledgeRoot, path.join(root, 'app_entry_root', 'orders', '_project'));
  assert.equal(child.appRoot, path.join(root, 'app_entry_root', 'orders', 'orders-v1'));
  assert.equal(child.runtime.ai.mode, 'advisory');
});

test('versioned output names are key-derived and deterministic', t => {
  const root = makeBase([
    { key: 'solo', app: { active: 'v1', versions: [{ id: 'v1' }] } },
    { key: 'duo', app: { active: 'v2', versions: [{ id: 'v1' }, { id: 'v2', path: 'duo-v2' }] } },
    { key: 'idle' },
  ]);
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  assert.equal(
    childPaths(root, 'solo').outputRoot,
    path.join(root, 'app_entry_root', 'solo', '_output', 'solo-v1'),
  );
  assert.equal(
    childPaths(root, 'duo').outputRoot,
    path.join(root, 'app_entry_root', 'duo', '_output', 'duo-v2'),
  );
  assert.equal(
    childPaths(root, 'duo', 'v1').outputRoot,
    path.join(root, 'app_entry_root', 'duo', '_output', 'duo-v1'),
  );
  assert.equal(childPaths(root, 'duo', 'v1').appRoot, path.join(root, 'app_entry_root', 'duo', 'duo-v1'));
  assert.equal(childPaths(root, 'idle').outputRoot, path.join(root, 'app_entry_root', 'idle', '_output', 'idle'));
  assert.equal(childPaths(root, 'idle').appRoot, null);
  assert.throws(() => childPaths(root, 'duo', 'v9'), /has no version: v9/);
  assert.throws(() => childPaths(root, 'duo', 'latest'), /version id such as v1/);
});

test('registered child can be resolved directly by key without a guessed path', t => {
  const root = makeBase([{
    key: 'ios-client', app: { active: 'v2', versions: [{ id: 'v1' }, { id: 'v2' }] },
  }]);
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const resolved = resolveProjectKey(root, 'ios-client', 'v1');
  assert.equal(resolved.scope, 'child');
  assert.equal(resolved.key, 'ios-client');
  assert.equal(resolved.version, 'v1');
  assert.equal(resolved.appRoot, path.join(root, 'app_entry_root', 'ios-client', 'ios-client-v1'));
  assert.throws(() => resolveProjectKey(root, 'unknown'), /not registered/);
});

test('registry rejects invalid keys, duplicate versions and escaping paths', () => {
  assert.throws(() => normalizeRegistry({ schemaVersion: '1.0.0', projects: [{ key: 'Bad_Key' }] }), /kebab-case/);
  assert.throws(() => normalizeRegistry({ schemaVersion: '1.0.0', projects: [
    { key: 'same', app: { active: 'v1', versions: [{ id: 'v1' }] } },
    { key: 'same', app: { active: 'v1', versions: [{ id: 'v1' }] } },
  ] }), /duplicate key/);
  assert.throws(() => assertRelativePath('../outside', 'app.path'), /must not contain/);
  assert.throws(() => assertRelativePath('C:\\Users\\owner', 'app.path'), /relative path/);
  assert.throws(() => normalizeRegistry({ schemaVersion: '1.0.0', projects: [{
    key: 'versions', app: { active: 'v1', versions: [{ id: 'v1' }, { id: 'v1' }] },
  }] }), /duplicate id/);
});

test('declared runtime capability packs must exist in the local generated canon when available', t => {
  const root = makeBase([{
    key: 'mobile', app: { active: 'v1', versions: [{ id: 'v1' }] },
    runtime: { ai: { mode: 'advisory', capabilityPacks: ['mobile-android'] } },
  }]);
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, 'skills'), { recursive: true });
  fs.writeFileSync(path.join(root, 'skills', 'REGISTRY.json'), JSON.stringify({
    skills: [{ directory: 'android-mobile-frontend-design', pack: 'mobile-android' }],
  }));
  assert.equal(readRegistry(root).projects[0].key, 'mobile');
  fs.writeFileSync(path.join(root, 'skills', 'REGISTRY.json'), JSON.stringify({ skills: [] }));
  assert.throws(() => readRegistry(root), /unavailable local capability/);
  assert.throws(() => validateDeclaredCapabilityPacks(root, {
    projects: [{ capabilityPacks: ['missing'], runtime: null }],
  }), /unavailable local capability/);
});

test('scan detects unregistered folders and false local-presence claims', t => {
  const root = makeBase([{ key: 'remote', presentLocally: true, app: { active: 'v1', versions: [{ id: 'v1' }] } }]);
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, 'app_entry_root', 'stray'), { recursive: true });
  const drift = scanProjects(root);
  assert.deepEqual(drift.map(item => item.key), ['remote', 'stray']);
});

test('scan rejects every child artifact outside the resolver-owned output root', t => {
  const root = makeBase([{ key: 'worlio', app: { active: 'v1', versions: [{ id: 'v1' }] } }]);
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, 'app_entry_root', 'worlio', '_project'), { recursive: true });
  fs.mkdirSync(path.join(root, 'app_entry_root', 'worlio', '_output', 'worlio-v1'), { recursive: true });
  assert.deepEqual(scanProjects(root), []);

  fs.writeFileSync(path.join(root, 'app_entry_root', 'worlio', '_output', 'loose.png'), 'loose');
  fs.mkdirSync(path.join(root, '_output', 'worlio'), { recursive: true });
  fs.mkdirSync(path.join(root, 'app_entry_root', '_output', 'worlio'), { recursive: true });

  assert.deepEqual(
    scanProjects(root).map(item => item.problem).sort(),
    [
      `legacy child output exists outside its child directory: ${path.join('_output', 'worlio')}`,
      `legacy child output exists outside its child directory: ${path.join('app_entry_root', '_output', 'worlio')}`,
      'output exists outside resolver-owned root: app_entry_root/worlio/_output/loose.png',
    ].sort(),
  );
});

test('scan permits every registered version output and rejects an unversioned alias', t => {
  const root = makeBase([{
    key: 'duo',
    app: { active: 'v2', versions: [{ id: 'v1' }, { id: 'v2' }] },
  }]);
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, 'app_entry_root', 'duo', '_project'), { recursive: true });
  fs.mkdirSync(path.join(root, 'app_entry_root', 'duo', '_output', 'duo-v1'), { recursive: true });
  fs.mkdirSync(path.join(root, 'app_entry_root', 'duo', '_output', 'duo-v2'), { recursive: true });
  assert.deepEqual(scanProjects(root), []);

  fs.mkdirSync(path.join(root, 'app_entry_root', 'duo', '_output', 'duo'), { recursive: true });
  assert.match(scanProjects(root)[0].problem, /outside resolver-owned root/);
});

test('scan rejects loose child-root artifacts', t => {
  const root = makeBase([{ key: 'worlio', app: { active: 'v1', versions: [{ id: 'v1' }] } }]);
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, 'app_entry_root', 'worlio', '_project'), { recursive: true });
  fs.writeFileSync(path.join(root, 'app_entry_root', 'worlio', 'screen.png'), 'artifact');

  assert.match(scanProjects(root)[0].problem, /loose entry exists directly in child root/);
});

test('scan rejects an output root that escapes its child through a link', t => {
  const root = makeBase([{ key: 'worlio', app: { active: 'v1', versions: [{ id: 'v1' }] } }]);
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'city-fabric-output-outside-'));
  t.after(() => {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(outside, { recursive: true, force: true });
  });
  fs.mkdirSync(path.join(root, 'app_entry_root', 'worlio', '_project'), { recursive: true });
  fs.mkdirSync(path.join(root, 'app_entry_root', 'worlio', '_output'), { recursive: true });
  try {
    fs.symlinkSync(outside, path.join(root, 'app_entry_root', 'worlio', '_output', 'worlio-v1'), 'junction');
  } catch (error) {
    if (error.code === 'EPERM' || error.code === 'EACCES') {
      t.skip(`link creation unavailable: ${error.code}`);
      return;
    }
    throw error;
  }

  assert.match(scanProjects(root)[0].problem, /escapes its child container through a link/);
});

test('empty registry is valid and malformed JSON is explicit', t => {
  const root = makeBase();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  assert.deepEqual(readRegistry(root).projects, []);
  fs.writeFileSync(path.join(root, 'app_entry_root', '_registry', 'registry.json'), '{ nope');
  assert.throws(() => readRegistry(root), /registry unreadable/);
});

test('checked-in City Fabric registry resolves the Worlio child to its versioned layout without requiring a local checkout', { skip: 'needs the full private monorepo (child registry, skill canon)' }, () => {
  const registry = readRegistry(CITY_ROOT);
  // The invariant, not the roll call: every registered child derives its directory from its key and
  // version, and none of them claims to be checked out here. Asserting the list itself made adding a
  // game break this test, which says nothing about the layout it is meant to protect.
  for (const project of registry.projects) {
    assert.ok(project.app?.active, `${project.key} declares an active version`);
    assert.equal(project.presentLocally ?? false, false, `${project.key} is not claimed as a local checkout`);
    for (const version of project.app.versions) {
      assert.equal(version.path, `${project.key}-${version.id}`);
    }
    assert.ok(project.app.versions.some(version => version.id === project.app.active));
  }
  assert.deepEqual(
    ['worlio', 'billing-center', 'player-center'].filter(key => registry.projects.some(p => p.key === key)),
    ['worlio', 'billing-center', 'player-center'],
    'the three children this test resolves below are registered',
  );
  const childRoot = path.join(CITY_ROOT, 'app_entry_root', 'worlio');
  const worlio = resolveProjectKey(CITY_ROOT, 'worlio');
  assert.equal(worlio.knowledgeRoot, path.join(childRoot, '_project'));
  assert.equal(worlio.appRoot, path.join(childRoot, 'worlio-v1'));
  assert.equal(worlio.outputRoot, path.join(childRoot, '_output', 'worlio-v1'));
  assert.equal(worlio.marketRoot, path.join(childRoot, '_project', 'market'));
  assert.equal(worlio.marketOutputRoot, path.join(childRoot, '_output', 'worlio-v1', 'market'));
  assert.deepEqual(worlio.market.stores, ['google-play', 'app-store']);
  assert.equal(worlio.market.locales.length, 17);
  assert.throws(() => resolveProjectKey(CITY_ROOT, 'not-onboarded'), /not registered/);
});

test('version directories are always <key>-<version> and app.path is retired', () => {
  assert.equal(versionDirName('worlio', 'v2'), 'worlio-v2');
  const registry = normalizeRegistry({ schemaVersion: '1.0.0', projects: [
    { key: 'game', app: { active: 'v1', versions: [{ id: 'v1', path: 'game-v1', note: 'first' }] } },
  ] });
  assert.deepEqual(registry.projects[0].app.versions, [{ id: 'v1', path: 'game-v1', note: 'first' }]);
  const reject = (app, pattern) => assert.throws(
    () => normalizeRegistry({ schemaVersion: '1.0.0', projects: [{ key: 'game', app }] }),
    pattern,
  );
  reject({ path: 'client' }, /app\.path is retired; declare app\.versions so code lives in game-v1/);
  reject({ active: 'v1', versions: [{ id: 'v1', path: 'client' }] }, /path must be game-v1/);
  reject({ active: 'v1', versions: [{ id: 'v1', path: '../game-v1' }] }, /must not contain/);
  reject({ active: 'v1', versions: [] }, /at least one version/);
  reject({ active: 'v1' }, /at least one version/);
  reject({ active: 'v2', versions: [{ id: 'v1' }] }, /does not name a declared version/);
  reject({ versions: [{ id: 'v1' }] }, /active must be a version id/);
  reject({ active: '1', versions: [{ id: '1' }] }, /version id such as v1/);
  reject({ active: 'v1', versions: [{ id: 'v1' }], back: { path: '_output/api' } }, /reserved child directory/);
  reject({ active: 'v1', versions: [{ id: 'v1' }], back: { path: 'game-v1' } }, /reserved child directory/);
  reject({ active: 'v1', versions: [{ id: 'v1' }], extra: true }, /unknown property: extra/);
});

test('market declaration validates stores and BCP 47 locales', () => {
  const market = locales => normalizeRegistry({ schemaVersion: '1.0.0', projects: [
    { key: 'game', app: { active: 'v1', versions: [{ id: 'v1' }] }, market: { stores: ['google-play'], locales } },
  ] }).projects[0].market;
  assert.deepEqual(market(['en-GB', 'zh-Hans-CN', 'es-419', 'fil']).locales, ['en-GB', 'zh-Hans-CN', 'es-419', 'fil']);
  assert.throws(() => market(['en_GB']), /BCP 47/);
  assert.throws(() => market(['en-GB', 'en-GB']), /duplicate item: en-GB/);
  assert.throws(() => market([]), /must not be empty/);
  const reject = (value, pattern) => assert.throws(() => normalizeRegistry({ schemaVersion: '1.0.0', projects: [
    { key: 'game', market: value },
  ] }), pattern);
  reject({ stores: ['Google Play'], locales: ['en-GB'] }, /kebab-case/);
  reject({ stores: ['google-play'] }, /locales must be an array/);
  reject({ stores: ['google-play'], locales: ['en-GB'], urls: [] }, /unknown property: urls/);
  assert.equal(normalizeRegistry({ schemaVersion: '1.0.0', projects: [{ key: 'game' }] }).projects[0].market, null);
});

test('market extraLocales lists store-only locales and rejects undeclared stores and repeats', () => {
  const norm = market => normalizeRegistry({ schemaVersion: '1.0.0', projects: [
    { key: 'game', market },
  ] }).projects[0].market;
  const base = { stores: ['google-play', 'huawei-appgallery'], locales: ['en-US', 'ru-RU'] };
  assert.equal(norm(base).extraLocales, undefined);
  assert.equal(norm({ ...base, extraLocales: {} }).extraLocales, undefined);
  const withExtra = norm({ ...base, extraLocales: { 'google-play': ['nl-NL', 'cs-CZ'] } });
  assert.deepEqual(withExtra.extraLocales, { 'google-play': ['nl-NL', 'cs-CZ'] });
  assert.deepEqual(storeLocales(withExtra, 'google-play'), ['en-US', 'ru-RU', 'nl-NL', 'cs-CZ']);
  assert.deepEqual(storeLocales(withExtra, 'huawei-appgallery'), ['en-US', 'ru-RU']);
  assert.throws(() => norm({ ...base, extraLocales: { 'app-store': ['nl-NL'] } }), /store that is not declared: app-store/);
  assert.throws(() => norm({ ...base, extraLocales: { 'google-play': ['ru-RU'] } }), /repeats a shared locale: ru-RU/);
  assert.throws(() => norm({ ...base, extraLocales: { 'google-play': ['nl-NL', 'nl-NL'] } }), /duplicate item: nl-NL/);
  assert.throws(() => norm({ ...base, extraLocales: { 'google-play': ['nl_NL'] } }), /BCP 47/);
  assert.throws(() => norm({ ...base, extraLocales: { 'google-play': [] } }), /must not be empty/);
  assert.throws(() => norm({ ...base, extraLocales: ['nl-NL'] }), /extraLocales must be an object/);
});

test('market paths give a store its extra locales and the others only the shared ones', t => {
  const root = makeBase([{
    key: 'game',
    app: { active: 'v1', versions: [{ id: 'v1' }] },
    market: { stores: ['google-play', 'huawei-appgallery'], locales: ['en-US'], extraLocales: { 'google-play': ['nl-NL'] } },
  }]);
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const childRoot = path.join(root, 'app_entry_root', 'game');
  fs.mkdirSync(path.join(childRoot, '_project'), { recursive: true });
  const plan = marketPaths(root, 'game');
  assert.deepEqual(plan.locales, ['en-US']);
  assert.deepEqual(plan.storeLocales, { 'google-play': ['en-US', 'nl-NL'], 'huawei-appgallery': ['en-US'] });
  assert.deepEqual(plan.targets.map(target => `${target.store}/${target.locale}`),
    ['google-play/en-US', 'google-play/nl-NL', 'huawei-appgallery/en-US']);
  const market = problems => problems.filter(item => /market text/.test(item.problem));
  assert.match(market(scanProjects(root))[0].problem, /absent for google-play: en-US, nl-NL/);
  initMarket(root, 'game');
  assert.equal(fs.existsSync(path.join(childRoot, '_project', 'market', 'google-play', 'nl-NL', '.gitkeep')), true);
  assert.equal(fs.existsSync(path.join(childRoot, '_project', 'market', 'huawei-appgallery', 'nl-NL')), false);
  assert.deepEqual(market(scanProjects(root)), []);
});

test('market paths expand every store and locale into tracked text and versioned captures', t => {
  const root = makeBase([{
    key: 'game',
    app: { active: 'v2', versions: [{ id: 'v1' }, { id: 'v2' }] },
    market: { stores: ['google-play', 'app-store'], locales: ['en-GB', 'ru-RU'] },
  }, { key: 'plain', app: { active: 'v1', versions: [{ id: 'v1' }] } }, {
    key: 'draft', market: { stores: ['google-play'], locales: ['en-GB'] },
  }]);
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const childRoot = path.join(root, 'app_entry_root', 'game');
  const plan = marketPaths(root, 'game');
  assert.equal(plan.version, 'v2');
  assert.equal(plan.targets.length, 4);
  assert.deepEqual(plan.targets[0], {
    store: 'google-play',
    locale: 'en-GB',
    textRoot: path.join(childRoot, '_project', 'market', 'google-play', 'en-GB'),
    outputRoot: path.join(childRoot, '_output', 'game-v2', 'market', 'google-play', 'en-GB'),
    screenshotsRoot: path.join(childRoot, '_output', 'game-v2', 'market', 'google-play', 'en-GB', 'screenshots'),
  });
  assert.equal(marketPaths(root, 'game', 'v1').targets[3].screenshotsRoot,
    path.join(childRoot, '_output', 'game-v1', 'market', 'app-store', 'ru-RU', 'screenshots'));
  assert.throws(() => marketPaths(root, 'plain'), /declares no market/);
  assert.throws(() => marketPaths(root, 'draft'), /requires an app version/);
  assert.throws(() => marketPaths(root, 'missing'), /not registered/);
  assert.throws(() => initMarket(root, 'game'), /child directory is absent/);
});

test('market init creates only missing directories and never overwrites listing text', t => {
  const root = makeBase([{
    key: 'game',
    app: { active: 'v1', versions: [{ id: 'v1' }] },
    market: { stores: ['google-play'], locales: ['en-GB', 'ru-RU'] },
  }]);
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const childRoot = path.join(root, 'app_entry_root', 'game');
  const existing = path.join(childRoot, '_project', 'market', 'google-play', 'en-GB', 'listing.md');
  fs.mkdirSync(path.dirname(existing), { recursive: true });
  fs.writeFileSync(existing, 'owner text');
  assert.match(
    scanProjects(root).map(item => item.problem).join('\n'),
    /market text directories are absent for google-play: ru-RU \(run infra project market game --init\)/,
  );

  const first = initMarket(root, 'game');
  assert.equal(fs.readFileSync(existing, 'utf8'), 'owner text');
  assert.equal(fs.existsSync(path.join(childRoot, '_project', 'market', 'google-play', 'en-GB', '.gitkeep')), false);
  assert.equal(fs.existsSync(path.join(childRoot, '_project', 'market', 'google-play', 'ru-RU', '.gitkeep')), true);
  assert.equal(fs.statSync(path.join(childRoot, '_output', 'game-v1', 'market', 'google-play', 'ru-RU', 'screenshots')).isDirectory(), true);
  assert.ok(first.created.length > 0);
  assert.deepEqual(scanProjects(root), []);
  assert.deepEqual(initMarket(root, 'game').created, []);
});

test('market init refuses a knowledge container that escapes the child through a link', t => {
  const root = makeBase([{
    key: 'game', app: { active: 'v1', versions: [{ id: 'v1' }] },
    market: { stores: ['google-play'], locales: ['en-GB'] },
  }]);
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'city-fabric-market-outside-'));
  t.after(() => {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(outside, { recursive: true, force: true });
  });
  fs.mkdirSync(path.join(root, 'app_entry_root', 'game'), { recursive: true });
  try {
    fs.symlinkSync(outside, path.join(root, 'app_entry_root', 'game', '_project'), 'junction');
  } catch (error) {
    if (error.code === 'EPERM' || error.code === 'EACCES') {
      t.skip(`link creation unavailable: ${error.code}`);
      return;
    }
    throw error;
  }
  assert.throws(() => initMarket(root, 'game'), /_project escapes its child directory through a link/);
  assert.deepEqual(fs.readdirSync(outside), []);
});

test('scan accepts the closed child layout but rejects code or files outside it', t => {
  const root = makeBase([{
    key: 'game', presentLocally: true,
    app: { active: 'v1', versions: [{ id: 'v1' }], back: { path: 'api-sidecar' } },
  }]);
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const childRoot = path.join(root, 'app_entry_root', 'game');
  for (const dir of ['_project', '_output', 'game-v1', 'api-sidecar', '.idea', '.factory']) {
    fs.mkdirSync(path.join(childRoot, dir), { recursive: true });
  }
  fs.writeFileSync(path.join(childRoot, '.DS_Store'), '');
  assert.deepEqual(scanProjects(root), []);

  fs.mkdirSync(path.join(childRoot, 'backend'));
  fs.mkdirSync(path.join(childRoot, '_scratch'));
  fs.mkdirSync(path.join(childRoot, 'factory'));
  fs.writeFileSync(path.join(childRoot, 'README.md'), '');
  fs.rmSync(path.join(childRoot, 'game-v1'), { recursive: true });
  assert.deepEqual(scanProjects(root).map(item => item.problem), [
    'directory outside the child layout: app_entry_root/game/_scratch/ (application code belongs in game-<version>/)',
    'directory outside the child layout: app_entry_root/game/backend/ (application code belongs in game-<version>/)',
    'directory outside the child layout: app_entry_root/game/factory/ (application code belongs in game-<version>/)',
    'loose entry exists directly in child root: app_entry_root/game/README.md',
    'registered app version is absent locally: app_entry_root/game/game-v1/',
  ]);
});

test('a working directory inside a version directory selects that version', t => {
  const root = makeBase([{ key: 'game', app: { active: 'v2', versions: [{ id: 'v1' }, { id: 'v2' }] } }]);
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const childRoot = path.join(root, 'app_entry_root', 'game');
  const inV1 = path.join(childRoot, 'game-v1', 'src');
  fs.mkdirSync(inV1, { recursive: true });
  fs.mkdirSync(path.join(childRoot, '_project'), { recursive: true });
  const fromV1 = resolveProject(inV1);
  assert.equal(fromV1.version, 'v1');
  assert.equal(fromV1.outputRoot, path.join(childRoot, '_output', 'game-v1'));
  assert.equal(resolveProject(path.join(childRoot, '_project')).version, 'v2');
  assert.equal(resolveProject(path.join(root, 'app_entry_root', 'Bad_Key')).inRegistry, false);
});

test('registry normalizes descriptive blocks and rejects malformed ones', () => {
  const normalized = normalizeRegistry({ schemaVersion: 1, projects: [{
    key: 'game', title: 'Game', summary: null, status: 'development',
    stack: { languages: ['kotlin'] }, ci: { provider: 'github' }, demo: { seed: 1 },
    neighbours: [{ path: 'docs/notes', what: 'design notes', actual: true }, { path: 'api', what: 'api' }],
    notes: ['first'], capabilityPacks: [],
  }] }).projects[0];
  assert.deepEqual(normalized.stack, { languages: ['kotlin'] });
  assert.deepEqual(normalized.neighbours, [
    { path: 'docs/notes', what: 'design notes', actual: true },
    { path: 'api', what: 'api' },
  ]);
  assert.deepEqual(normalized.notes, ['first']);
  const reject = (project, pattern) => assert.throws(
    () => normalizeRegistry({ schemaVersion: '1.0.0', projects: [{ key: 'game', ...project }] }),
    pattern,
  );
  reject({ neighbours: {} }, /neighbours must be an array/);
  reject({ neighbours: [{ path: 'api', what: 'api', actual: 'yes' }] }, /actual must be boolean/);
  reject({ stack: [] }, /stack must be an object/);
  reject({ presentLocally: 'yes' }, /presentLocally must be boolean/);
  reject({ notes: [''] }, /notes must be an array of non-empty strings/);
  assert.throws(() => normalizeRegistry({ schemaVersion: '2.0.0', projects: [] }), /schemaVersion must be 1.0.0/);
  assert.throws(() => normalizeRegistry({ schemaVersion: '1.0.0', projects: {} }), /projects must be an array/);
});

test('scan reports absent knowledge, versionless local claims and an escaping output container', t => {
  const root = makeBase([
    { key: 'bare', presentLocally: true },
    { key: 'linked', app: { active: 'v1', versions: [{ id: 'v1' }] } },
  ]);
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'city-fabric-container-outside-'));
  t.after(() => {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(outside, { recursive: true, force: true });
  });
  fs.mkdirSync(path.join(root, 'app_entry_root', 'bare'), { recursive: true });
  fs.mkdirSync(path.join(root, 'app_entry_root', 'linked', '_project'), { recursive: true });
  assert.deepEqual(scanProjects(root).map(item => item.problem), [
    'knowledge directory is absent: app_entry_root/bare/_project/',
    'presentLocally requires a registered app version',
  ]);
  try {
    fs.symlinkSync(outside, path.join(root, 'app_entry_root', 'linked', '_output'), 'junction');
  } catch (error) {
    if (error.code === 'EPERM' || error.code === 'EACCES') {
      t.skip(`link creation unavailable: ${error.code}`);
      return;
    }
    throw error;
  }
  assert.match(scanProjects(root).at(-1).problem, /output container escapes the child directory through a link/);
});

test('base root detection fails closed when AGENTS.md cannot be read as a file', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'city-fabric-agents-dir-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, 'AGENTS.md'));
  fs.mkdirSync(path.join(root, 'cli', 'bin'), { recursive: true });
  fs.writeFileSync(path.join(root, 'cli', 'bin', 'infra.js'), '');
  assert.equal(isBaseRoot(root), false);
});

test('registry covers optional runtime, sidecar and legacy version fields', () => {
  const [game] = normalizeRegistry({ version: 1, projects: [{
    key: 'game',
    app: { active: 'v1', versions: [{ id: 'v1', repo: 'origin', branch: 'dev' }], back: { path: 'api', repo: 'origin-api' } },
    runtime: { ai: { mode: 'governed', providerClasses: ['local'] }, platforms: ['android'] },
  }] }).projects;
  assert.deepEqual(game.app.back, { path: 'api', repo: 'origin-api' });
  assert.deepEqual(game.app.versions[0], { id: 'v1', path: 'game-v1', repo: 'origin', branch: 'dev' });
  assert.deepEqual(game.runtime.ai.providerClasses, ['local']);
  const reject = (project, pattern) => assert.throws(
    () => normalizeRegistry({ schemaVersion: '1.0.0', projects: [{ key: 'game', ...project }] }),
    pattern,
  );
  reject({ runtime: { ai: { mode: 'autonomous' } } }, /mode must be disabled, advisory or governed/);
  reject({ summary: 42 }, /summary must be a non-empty string/);
});

test('listing and scanning a versionless child keep the key-named output root', t => {
  const root = makeBase([{ key: 'draft' }]);
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, 'app_entry_root', 'draft', '_project'), { recursive: true });
  fs.mkdirSync(path.join(root, 'app_entry_root', 'draft', '_output', 'draft'), { recursive: true });
  assert.deepEqual(scanProjects(root), []);
  fs.mkdirSync(path.join(root, 'app_entry_root', 'draft', '_output', 'draft-v1'), { recursive: true });
  assert.match(scanProjects(root)[0].problem, /outside resolver-owned root: app_entry_root\/draft\/_output\/draft-v1/);
  assert.deepEqual(listProjects(root), [{
    key: 'draft', title: null, status: null, presentLocally: false, activeVersion: null,
    versions: [], market: null, capabilityPacks: [], runtime: null,
  }]);
});

test('missing registry and namespace are an empty, drift-free base', t => {
  const root = makeBase();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.rmSync(path.join(root, 'app_entry_root'), { recursive: true });
  assert.deepEqual(readRegistry(root).projects, []);
  assert.deepEqual(scanProjects(root), []);
});

test('an unreadable or malformed local skill catalog fails registry validation', t => {
  const root = makeBase([{ key: 'mobile', capabilityPacks: ['mobile-android'] }]);
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, 'skills'), { recursive: true });
  fs.writeFileSync(path.join(root, 'skills', 'REGISTRY.json'), '{ nope');
  assert.throws(() => readRegistry(root), /REGISTRY.json is unreadable/);
  fs.writeFileSync(path.join(root, 'skills', 'REGISTRY.json'), '{}');
  assert.throws(() => readRegistry(root), /has no skills array/);
});

test('a working directory inside packages/<name> resolves to the package scope, never a child', t => {
  const root = makeBase([{ key: 'game', app: { active: 'v1', versions: [{ id: 'v1' }] } }]);
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const packageRoot = path.join(root, 'app_entry_root', PACKAGES_DIR, 'nrg-shield');
  const deep = path.join(packageRoot, 'android', 'src');
  fs.mkdirSync(deep, { recursive: true });
  const fromDeep = resolveProject(deep);
  assert.equal(fromDeep.scope, 'package');
  assert.equal(fromDeep.packageName, 'nrg-shield');
  assert.equal(fromDeep.packageRoot, packageRoot);
  assert.equal(fromDeep.knowledgeRoot, packageRoot);
  assert.equal(fromDeep.baseRoot, root);
  assert.equal(fromDeep.key, null);
  assert.equal(fromDeep.outputRoot, null);
  assert.equal(fromDeep.appRoot, null);
  assert.equal(fromDeep.inRegistry, false);
  assert.match(fromDeep.reason, /shared package app_entry_root\/packages\/nrg-shield\//);

  const container = resolveProject(path.join(root, 'app_entry_root', PACKAGES_DIR));
  assert.equal(container.scope, 'package');
  assert.equal(container.packageName, null);
  assert.equal(container.packageRoot, null);
  assert.equal(container.knowledgeRoot, null);

  assert.equal(resolveProject(path.join(root, 'app_entry_root', 'game')).scope, 'child');
});

test('scan does not report packages/ or its packages as unregistered children', t => {
  const root = makeBase([{ key: 'game', app: { active: 'v1', versions: [{ id: 'v1' }] } }]);
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, 'app_entry_root', 'game', '_project'), { recursive: true });
  fs.mkdirSync(path.join(root, 'app_entry_root', PACKAGES_DIR, 'nrg-shield', '.git'), { recursive: true });
  assert.deepEqual(scanProjects(root), []);
  fs.mkdirSync(path.join(root, 'app_entry_root', 'stray'), { recursive: true });
  assert.deepEqual(scanProjects(root).map(item => item.key), ['stray']);
});

test('the registry rejects packages as a child key because it is reserved', () => {
  assert.throws(() => assertChildKey('packages'), /"packages" is reserved for shared packages/);
  assert.equal(assertChildKey('packages-app'), 'packages-app');
  assert.throws(() => normalizeRegistry({ schemaVersion: '1.0.0', projects: [{ key: 'packages' }] }), /reserved for shared packages/);
});
