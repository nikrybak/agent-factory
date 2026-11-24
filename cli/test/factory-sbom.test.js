const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { collectSources, generateSbom } = require('../lib/factory/sbom');

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'factory-sbom-'));
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: 'demo', version: '1.0.0', dependencies: { zed: '^2.0.0', alpha: '1.2.3' }, devDependencies: { testy: '~4.0.0' } }));
  fs.writeFileSync(path.join(root, 'requirements.txt'), 'requests==2.32.0\n# ignored\nflask>=3.0\n');
  fs.writeFileSync(path.join(root, 'go.mod'), 'module example.test/demo\n\nrequire example.test/lib v1.2.0\n');
  fs.writeFileSync(path.join(root, 'Cargo.lock'), '[[package]]\nname = "serde"\nversion = "1.0.200"\n');
  return root;
}

test('SBOM is deterministic, sorted, CycloneDX-like, and hashes every source manifest', () => {
  const root = fixture();
  const first = generateSbom(root);
  const second = generateSbom(root);
  assert.deepEqual(first, second);
  assert.equal(first.bomFormat, 'CycloneDX');
  assert.equal(first.specVersion, '1.5');
  assert.deepEqual(first.components.map(item => item.name), [...first.components.map(item => item.name)].sort());
  assert.ok(first.components.some(item => item.name === 'alpha' && item.version === '1.2.3'));
  assert.ok(first.components.some(item => item.name === 'requests' && item.version === '2.32.0'));
  assert.ok(first.components.some(item => item.name === 'example.test/lib' && item.version === 'v1.2.0'));
  assert.ok(first.components.some(item => item.name === 'serde' && item.version === '1.0.200'));
  assert.ok(first.metadata.sources.every(source => /^[a-f0-9]{64}$/.test(source.sha256)));
});

test('SBOM changes when a manifest is tampered with and does not execute project code', () => {
  const root = fixture();
  fs.writeFileSync(path.join(root, 'postinstall.js'), 'require("node:fs").writeFileSync("PWNED", "yes")');
  const first = generateSbom(root);
  fs.writeFileSync(path.join(root, 'requirements.txt'), 'requests==2.33.0\n');
  const second = generateSbom(root);
  assert.notDeepEqual(first, second);
  assert.equal(fs.existsSync(path.join(root, 'PWNED')), false);
});

test('SBOM rejects roots that do not exist', () => {
  assert.throws(() => generateSbom(path.join(os.tmpdir(), 'definitely-missing-factory-root')), /root/i);
});

test('SBOM inventories representative lock and manifest formats without a runtime', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'factory-sbom-formats-'));
  const files = {
    'composer.lock': JSON.stringify({ packages: [{ name: 'vendor/lib', version: '2.0.0' }] }),
    'pyproject.toml': '[project]\ndependencies = ["fastapi>=0.110"]\n',
    'Pipfile.lock': JSON.stringify({ default: { django: { version: '==5.0.0' } } }),
    'Cargo.toml': '[dependencies]\ntokio = "1.37"\n',
    'packages.lock.json': JSON.stringify({ dependencies: { net8: { Newtonsoft: { resolved: '13.0.3' } } } }),
    'pom.xml': '<dependencies><dependency><groupId>org.demo</groupId><artifactId>core</artifactId><version>1.2</version></dependency></dependencies>',
    'build.gradle': 'implementation "org.slf4j:slf4j-api:2.0.13"',
    Gemfile: "gem 'rails', '7.1.0'\n",
    'poetry.lock': '[[package]]\nname = "uvicorn"\nversion = "0.30.0"\n',
  };
  for (const [name, contents] of Object.entries(files)) fs.writeFileSync(path.join(root, name), contents);
  const names = new Set(generateSbom(root).components.map(item => item.name));
  for (const expected of ['vendor/lib', 'fastapi', 'django', 'tokio', 'Newtonsoft', 'org.demo:core', 'org.slf4j:slf4j-api', 'rails', 'uvicorn']) assert.ok(names.has(expected), expected);
});

test('SBOM reads PEP 621 dependencies without treating Python metadata or scripts as packages', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'factory-sbom-pep621-'));
  fs.writeFileSync(path.join(root, 'pyproject.toml'), [
    '[project]',
    'name = "worlio-content"',
    'version = "0.1.0"',
    'requires-python = ">=3.11"',
    'dependencies = ["jsonschema>=4.23", "regex[unicode]~=2026.1"]',
    '',
    '[project.optional-dependencies]',
    'test = ["pytest==9.0.2"]',
    '',
    '[project.scripts]',
    'worlio-content = "worlio_content_pipeline.cli:main"',
    '',
  ].join('\n'));

  const components = generateSbom(root).components;
  const names = new Set(components.map(item => item.name));
  assert.equal(names.has('jsonschema'), true);
  assert.equal(names.has('regex'), true);
  assert.equal(names.has('pytest'), true);
  assert.equal(components.find(item => item.name === 'pytest').scope, 'optional');
  assert.equal(names.has('requires-python'), false);
  assert.equal(names.has('worlio-content'), false);
});

test('SBOM reads common JavaScript and language lockfile variants', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'factory-sbom-locks-'));
  const files = {
    'package-lock.json': JSON.stringify({ packages: { 'node_modules/lodash': { version: '4.17.21' } }, dependencies: { chalk: { version: '5.3.0', dev: true } } }),
    'yarn.lock': 'left-pad@^1.3.0:\n  version "1.3.0"\n',
    'pnpm-lock.yaml': "packages:\n  '/kleur@4.1.5':\n    resolution: {}\n",
    'composer.json': JSON.stringify({ require: { php: '^8.3', 'acme/core': '^1.0' }, 'require-dev': { 'phpunit/phpunit': '^11' } }),
    'requirements.txt': 'httpx[http2]~=0.27\n',
    'go.mod': 'module demo\nrequire (\n  golang.org/x/text v0.15.0 // indirect\n)\n',
    'Cargo.lock': '[[package]]\nname = "anyhow"\nversion = "1.0.86"\n',
    'demo.csproj': '<Project><ItemGroup><PackageReference Include="Serilog" Version="3.1.1" /></ItemGroup></Project>',
    'Gemfile.lock': 'GEM\n  specs:\n    rack (3.0.10)\n',
  };
  for (const [name, contents] of Object.entries(files)) fs.writeFileSync(path.join(root, name), contents);
  const names = new Set(generateSbom(root).components.map(item => item.name));
  for (const expected of ['lodash', 'chalk', 'left-pad', 'kleur', 'acme/core', 'phpunit/phpunit', 'httpx', 'golang.org/x/text', 'anyhow', 'Serilog', 'rack']) assert.ok(names.has(expected), expected);
});

test('SBOM inventories the complete Gradle dependency lock with production scopes', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'factory-sbom-gradle-lock-'));
  fs.writeFileSync(path.join(root, 'gradle.lockfile'), [
    '# generated dependency lock',
    'io.ktor:ktor-server-core-jvm:3.5.2=compileClasspath,runtimeClasspath,testRuntimeClasspath',
    'org.junit.jupiter:junit-jupiter:6.0.3=testCompileClasspath,testRuntimeClasspath',
    'io.github.java-diff-utils:java-diff-utils:4.12=kotlinInternalAbiValidation',
    '',
  ].join('\n'));

  const sbom = generateSbom(root);
  const ktor = sbom.components.find(item => item.name === 'io.ktor:ktor-server-core-jvm');
  const junit = sbom.components.find(item => item.name === 'org.junit.jupiter:junit-jupiter');
  const abiTool = sbom.components.find(item => item.name === 'io.github.java-diff-utils:java-diff-utils');
  assert.equal(ktor.version, '3.5.2');
  assert.equal(ktor.scope, 'required');
  assert.equal(junit.scope, 'development');
  assert.equal(abiTool.scope, 'development');
  assert.equal(sbom.metadata.sources.some(source => source.path === 'gradle.lockfile'), true);
});

test('SBOM ignores child application repositories but includes registry and child knowledge', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'factory-sbom-child-'));
  const checkout = path.join(root, 'app_entry_root', 'worlio', 'preview-client');
  const knowledge = path.join(root, 'app_entry_root', 'worlio', '_project');
  const registry = path.join(root, 'app_entry_root', '_registry');
  fs.mkdirSync(checkout, { recursive: true });
  fs.mkdirSync(knowledge, { recursive: true });
  fs.mkdirSync(registry, { recursive: true });
  fs.mkdirSync(path.join(root, '.claude', 'skills', 'generated'), { recursive: true });
  fs.mkdirSync(path.join(root, 'skills', 'canonical'), { recursive: true });
  fs.writeFileSync(path.join(registry, 'registry.json'), '{"projects":[]}');
  fs.writeFileSync(path.join(checkout, 'package.json'), JSON.stringify({ dependencies: { ignored: '9.9.9' } }));
  fs.writeFileSync(path.join(knowledge, 'requirements.txt'), 'tracked-knowledge==1.0.0\n');
  fs.writeFileSync(path.join(registry, 'package.json'), JSON.stringify({ dependencies: { registry_tool: '2.0.0' } }));
  fs.writeFileSync(path.join(root, '.claude', 'skills', 'generated', 'package.json'), JSON.stringify({ dependencies: { ignored_mirror: '3.0.0' } }));
  fs.writeFileSync(path.join(root, 'skills', 'canonical', 'package.json'), JSON.stringify({ dependencies: { tracked_canon: '4.0.0' } }));

  const relativeSources = collectSources(root).map(file => path.relative(root, file).split(path.sep).join('/'));
  assert.deepEqual(relativeSources, [
    'app_entry_root/_registry/package.json',
    'app_entry_root/worlio/_project/requirements.txt',
    'skills/canonical/package.json',
  ]);
  const names = new Set(generateSbom(root).components.map(item => item.name));
  assert.equal(names.has('ignored'), false);
  assert.equal(names.has('tracked-knowledge'), true);
  assert.equal(names.has('registry_tool'), true);
  assert.equal(names.has('ignored_mirror'), false);
  assert.equal(names.has('tracked_canon'), true);
});

test('SBOM inventories authored Unity packages and excludes Unity generated state', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'factory-sbom-unity-'));
  fs.mkdirSync(path.join(root, 'ProjectSettings'), { recursive: true });
  fs.mkdirSync(path.join(root, 'Packages'), { recursive: true });
  fs.mkdirSync(path.join(root, 'Assets', 'Plugins', 'Android'), { recursive: true });
  fs.mkdirSync(path.join(root, 'Library', 'PackageCache', 'cached'), { recursive: true });
  fs.mkdirSync(path.join(root, 'Builds', 'Android'), { recursive: true });
  fs.writeFileSync(path.join(root, 'ProjectSettings', 'ProjectVersion.txt'), 'm_EditorVersion: 6000.5.9f1\n');
  fs.writeFileSync(path.join(root, 'Packages', 'manifest.json'), JSON.stringify({
    dependencies: { 'com.unity.inputsystem': '1.14.2' },
  }));
  fs.writeFileSync(path.join(root, 'Packages', 'packages-lock.json'), JSON.stringify({
    dependencies: { 'com.unity.modules.ui': { version: '1.0.0', depth: 0 } },
  }));
  fs.writeFileSync(path.join(root, 'Assets', 'Plugins', 'Android', 'build.gradle'), "implementation 'androidx.core:core:1.17.0'\n");
  fs.writeFileSync(path.join(root, 'Library', 'PackageCache', 'cached', 'package.json'), JSON.stringify({ dependencies: { cached: '9.9.9' } }));
  fs.writeFileSync(path.join(root, 'Builds', 'Android', 'build.gradle'), "implementation 'generated:build:9.9.9'\n");

  const sbom = generateSbom(root);
  const names = new Set(sbom.components.map(item => item.name));
  const sources = sbom.metadata.sources.map(source => source.path);

  assert.equal(names.has('com.unity.inputsystem'), true);
  assert.equal(names.has('com.unity.modules.ui'), true);
  assert.equal(names.has('androidx.core:core'), true);
  assert.equal(names.has('cached'), false);
  assert.equal(names.has('generated:build'), false);
  assert.equal(sources.some(source => source.startsWith('Library/')), false);
  assert.equal(sources.some(source => source.startsWith('Builds/')), false);
});

test('SBOM inventories nested Unity packages without traversing nested generated state', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'factory-sbom-nested-unity-'));
  const unity = path.join(root, 'apps', 'mobile');
  fs.mkdirSync(path.join(unity, 'ProjectSettings'), { recursive: true });
  fs.mkdirSync(path.join(unity, 'Packages'), { recursive: true });
  fs.mkdirSync(path.join(unity, 'Library', 'PackageCache', 'cached'), { recursive: true });
  fs.mkdirSync(path.join(root, 'services', 'api'), { recursive: true });
  fs.writeFileSync(path.join(unity, 'ProjectSettings', 'ProjectVersion.txt'), 'm_EditorVersion: 6000.5.9f1\n');
  fs.writeFileSync(path.join(unity, 'Packages', 'manifest.json'), JSON.stringify({
    dependencies: { 'com.unity.localization': '1.5.9' },
  }));
  fs.writeFileSync(path.join(unity, 'Library', 'PackageCache', 'cached', 'package.json'), JSON.stringify({
    dependencies: { generated: '9.9.9' },
  }));
  fs.writeFileSync(path.join(root, 'services', 'api', 'requirements.txt'), 'ktor-helper==1.0.0\n');

  const sbom = generateSbom(root);
  const names = new Set(sbom.components.map(item => item.name));
  const sources = sbom.metadata.sources.map(source => source.path);
  assert.equal(names.has('com.unity.localization'), true);
  assert.equal(names.has('generated'), false);
  assert.equal(names.has('ktor-helper'), true);
  assert.equal(sources.some(source => source.startsWith('apps/mobile/Library/')), false);
  assert.equal(sources.includes('apps/mobile/Packages/manifest.json'), true);
});

test('the SBOM never lists tool state: agent worktrees and harness state are other checkouts', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'factory-sbom-workspace-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  for (const relative of ['', '.claude/worktrees/agent-1', '.claude/state']) {
    fs.mkdirSync(path.join(root, relative), { recursive: true });
    fs.writeFileSync(path.join(root, relative, 'package.json'), JSON.stringify({ dependencies: { [relative ? 'copy' : 'real']: '1.0.0' } }));
  }
  assert.deepEqual(collectSources(root).map(file => path.relative(root, file)), ['package.json']);
  assert.deepEqual(generateSbom(root).components.map(item => item.name), ['real']);
});
