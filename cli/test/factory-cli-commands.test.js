'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const BIN = path.join(__dirname, '..', 'bin', 'infra.js');
function invoke(args) {
  const result = spawnSync(process.execPath, [BIN, ...args], { encoding: 'utf8', windowsHide: true });
  return { ...result, json: result.stdout ? JSON.parse(result.stdout) : null };
}
function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'factory cli space-'));
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: 'cli-app', bin: 'index.js' }));
  return root;
}

function installCertifiableArtifactGraph(root) {
  const nodes = [
    ['intent', 'intent', 'artifacts/intent.md'],
    ['requirement', 'requirement', 'artifacts/requirement.md'],
    ['spec', 'spec', 'artifacts/spec.md'],
    ['adr', 'adr', 'artifacts/adr.md'],
    ['module', 'module', 'artifacts/module.js'],
    ['test', 'test', 'artifacts/module.test.js'],
    ['evidence', 'evidence', 'artifacts/evidence.md'],
    ['release', 'release', 'artifacts/release.md'],
  ].map(([id, type, artifactPath]) => ({ id, type, path: artifactPath }));
  const edges = [
    ['intent', 'requirement', 'defines'],
    ['requirement', 'spec', 'specified-by'],
    ['requirement', 'adr', 'governed-by'],
    ['spec', 'module', 'implemented-by'],
    ['module', 'test', 'verified-by'],
    ['test', 'evidence', 'produces'],
    ['evidence', 'release', 'qualifies'],
  ].map(([from, to, type]) => ({ from, to, type }));
  fs.mkdirSync(path.join(root, 'artifacts'), { recursive: true });
  for (const node of nodes) fs.writeFileSync(path.join(root, node.path), `${node.type}\n`);
  fs.writeFileSync(path.join(root, 'factory', 'artifacts.json'), JSON.stringify({
    schemaVersion: '1.0.0', nodes, edges,
  }));
}

test('factory CLI supports init, detect, plan, status, explain and verify JSON envelopes', () => {
  const root = fixture();
  let result = invoke(['init', '--project', root, '--profile', 'cli', '--json']);
  assert.equal(result.status, 0);
  assert.equal(result.json.command, 'init');

  result = invoke(['detect', '--project', root, '--write', '--json']);
  assert.equal(result.status, 0);
  assert.equal(result.json.data.components[0].family, 'node');

  result = invoke(['plan', '--project', root, '--run-id', 'cli-run', '--json']);
  assert.equal(result.status, 0);
  assert.equal(result.json.data.plan.runId, 'cli-run');

  result = invoke(['status', '--project', root, '--run', 'cli-run', '--json']);
  assert.equal(result.json.data.workflow.ready[0], 'intake');

  result = invoke(['explain', '--project', root, '--run', 'cli-run', '--step', 'browser-e2e', '--json']);
  assert.equal(result.json.data.step.applicable, false);

  result = invoke(['verify', '--project', root, '--run', 'cli-run', '--json']);
  assert.equal(result.status, 1);
  assert.equal(result.json.status, 'FAIL');
});

test('factory CLI rejects caller no-ops and executes a bound builtin provider', () => {
  const root = fixture();
  invoke(['init', '--project', root, '--profile', 'cli', '--json']);
  installCertifiableArtifactGraph(root);
  invoke(['plan', '--project', root, '--run-id', 'run-step', '--json']);
  const rejected = invoke([
    'run', '--project', root, '--run', 'run-step', '--step', 'intake', '--json', '--',
    process.execPath, '-e', 'process.stdout.write("done")',
  ]);
  assert.equal(rejected.status, 1);
  assert.match(rejected.json.diagnostics[0].message, /reject caller argv/);

  const result = invoke(['run', '--project', root, '--run', 'run-step', '--step', 'intake', '--json']);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.json.data.evidence.status, 'PASS');
});

test('factory CLI fails closed on invalid usage while legacy usage stays compatible', () => {
  const bad = spawnSync(process.execPath, [BIN, 'init', '--project'], { encoding: 'utf8' });
  assert.equal(bad.status, 3);
  const legacy = spawnSync(process.execPath, [BIN, 'unknown-legacy-command'], { encoding: 'utf8' });
  assert.equal(legacy.status, 0);
  assert.match(legacy.stdout, /usage:/);
});

test('direct adapters planning resolves projectRoot to the one detected component directory', t => {
  const root = fixture();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  assert.equal(invoke(['init', '--project', root, '--profile', 'cli', '--json']).status, 0);
  const unityRoot = path.join(root, 'preview-client');
  fs.mkdirSync(path.join(unityRoot, 'ProjectSettings'), { recursive: true });
  fs.writeFileSync(path.join(unityRoot, 'ProjectSettings', 'ProjectVersion.txt'), 'm_EditorVersion: 6000.5.9f1\n');
  const catalogPath = path.join(root, 'factory', 'catalog', 'adapters.json');
  const catalog = JSON.parse(fs.readFileSync(catalogPath, 'utf8'));
  const unity = catalog.adapters.find(adapter => adapter.family === 'unity');
  unity.operations.test.argv[unity.operations.test.argv.indexOf('-projectPath') + 1] = '${projectRoot}';
  fs.writeFileSync(catalogPath, JSON.stringify(catalog, null, 2));

  const result = invoke(['adapters', '--project', root, '--family', 'unity', '--operation', 'test', '--json']);
  assert.equal(result.status, 0, result.stderr);
  const argv = result.json.data.plans[0].argv;
  assert.equal(argv[argv.indexOf('-projectPath') + 1], fs.realpathSync.native(unityRoot));
  assert.equal(JSON.stringify(catalog).includes(fs.realpathSync.native(unityRoot)), false);

  const missing = invoke(['adapters', '--project', root, '--family', 'python', '--operation', 'test', '--json']);
  assert.notEqual(missing.status, 0);
  assert.equal(missing.json.data.status, 'blocked');
  assert.equal(missing.json.data.gaps[0].code, 'component-missing');
});

test('Factory JSON and human errors never expose shaped credential canaries', () => {
  const canary = 'factory-cli-error-canary';
  const missing = path.join(os.tmpdir(), `token=${canary}`);
  const json = invoke(['status', '--project', missing, '--json']);
  assert.equal(json.status, 1);
  assert.equal(json.stdout.includes(canary), false);
  assert.equal(json.json.status, 'FAIL');

  const human = spawnSync(process.execPath, [BIN, 'status', '--project', missing], {
    encoding: 'utf8', windowsHide: true,
  });
  assert.equal(human.status, 1);
  assert.equal(human.stderr.includes(canary), false);
  assert.match(human.stderr, /^\[infra\] /);
});

test('Factory City CLI exposes an internally consistent aggregate certification envelope', t => {
  // Hermetic: a clean checkout (CI) has no local run, so the project and its run are created here.
  const root = fixture();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  assert.equal(invoke(['init', '--project', root, '--profile', 'cli', '--json']).status, 0);
  installCertifiableArtifactGraph(root);

  const withoutRun = invoke(['certify', '--project', root, '--json']);
  assert.equal(withoutRun.status, 1);
  assert.equal(withoutRun.json.status, 'FAIL');
  assert.match(withoutRun.json.diagnostics[0].message, /no factory run exists/);

  assert.equal(invoke(['plan', '--project', root, '--run-id', 'city-envelope', '--json']).status, 0);
  const result = invoke(['certify', '--project', root, '--run', 'city-envelope', '--json']);
  assert.equal(result.json.command, 'certify');
  assert.equal(result.json.status, result.json.data.status);
  assert.equal(result.status, result.json.status === 'COMPLETE' ? 0 : 1, result.stderr);
  assert.match(result.json.data.treeHash, /^[a-f0-9]{64}$/);
  assert.match(result.json.data.certificationIdentityDigest, /^[a-f0-9]{64}$/);
  assert.match(result.json.data.layoutInputDigest, /^[a-f0-9]{64}$/);
  assert.ok(Array.isArray(result.json.data.gaps));
});

test('stage-sensitive CLI commands fail closed on missing evidence, wrong stage, and unscoped writes', t => {
  const root = fixture();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  assert.equal(invoke(['init', '--project', root, '--profile', 'cli', '--json']).status, 0);
  installCertifiableArtifactGraph(root);
  assert.equal(invoke(['plan', '--project', root, '--run-id', 'certification-flow', '--json']).status, 0);

  const missing = invoke(['attest', '--project', root, '--json']);
  assert.equal(missing.status, 1, missing.stderr);
  assert.equal(missing.json.status, 'FAIL');
  assert.ok(missing.json.data.verification.reasons.includes('PROVENANCE_EVIDENCE_MISSING'));

  const beforeRecord = invoke(['observe', '--project', root, '--json']);
  assert.equal(beforeRecord.status, 0, beforeRecord.stderr || beforeRecord.stdout);
  assert.equal(beforeRecord.json.status, 'ADVISORY');
  assert.equal(beforeRecord.json.data.advisory, true);
  assert.equal(beforeRecord.json.data.trusted, false);

  const unscopedRecord = invoke(['observe', '--project', root, '--record', '--json']);
  assert.equal(unscopedRecord.status, 1);
  assert.match(unscopedRecord.json.diagnostics[0].message, /trusted observability-stage assessment/);

  const scopedRecord = invoke(['observe', '--project', root, '--run', 'certification-flow', '--record', '--json']);
  assert.equal(scopedRecord.status, 1);
  assert.match(scopedRecord.json.diagnostics[0].message, /trusted observability-stage assessment/);

  const wrongStageEval = invoke(['eval', '--project', root, '--run', 'certification-flow', '--json']);
  assert.equal(wrongStageEval.status, 1);
  assert.ok(wrongStageEval.json.data.workflowStage.gaps.some(gap => gap.code === 'WORKFLOW_STAGE_NOT_READY'));

  const outward = invoke([
    'release-plan', '--project', root, '--run', 'certification-flow', '--action', 'release', '--json',
  ]);
  assert.equal(outward.status, 1);
  assert.equal(outward.json.data.status, 'BLOCKED');
  assert.match(outward.json.data.reason, /certification is incomplete|workflow stage/);
});
