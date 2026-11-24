const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const crypto = require('node:crypto');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');

const { buildSafeEnv, redactArgv, runStep } = require('../lib/factory/runner');
const { hashValue } = require('../lib/factory/hash');
const { createLaunchBinding } = require('../lib/factory/launcher');
const { loadToolchainTrust } = require('../lib/factory/toolchain-trust');
const {
  FILESYSTEM_BOUNDARY_VERSION, FILESYSTEM_CAPABILITY_DIGEST,
} = require('../lib/factory/filesystem-boundary');
const { REDACTION_POLICY_VERSION } = require('../lib/factory/redaction');

function fakeSpawn(result, capture) {
  return (command, args, options) => {
    capture.push({ command, args, options });
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.kill = () => {};
    process.nextTick(() => {
      if (result.stdout) child.stdout.emit('data', Buffer.from(result.stdout));
      if (result.stderr) child.stderr.emit('data', Buffer.from(result.stderr));
      child.emit('close', result.code, null);
    });
    return child;
  };
}

function boundStep(id, argv, cwd = '.', launchOptions = {}, timeoutMs) {
  const providerId = `provider-${id}`;
  const command = {
    id: `node-root:${id}`, targetId: `node-root:${id}`,
    componentId: 'node-root', adapterId: 'node-core',
    operation: id, argv, cwd, requiredAuthority: null,
    ...(timeoutMs === undefined ? {} : { timeoutMs }),
  };
  command.launchBinding = createLaunchBinding(argv, launchOptions);
  command.commandHash = hashValue({
    providerId, id: command.id, targetId: command.targetId,
    componentId: command.componentId, adapterId: command.adapterId,
    operation: command.operation, argv, cwd,
    launchDigest: command.launchBinding.launchDigest,
    ...(timeoutMs === undefined ? {} : { timeoutMs }),
  });
  const binding = {
    schemaVersion: '1.1.0', redactionPolicyVersion: REDACTION_POLICY_VERSION,
    filesystemBoundaryVersion: FILESYSTEM_BOUNDARY_VERSION,
    filesystemCapabilityDigest: FILESYSTEM_CAPABILITY_DIGEST,
    providerId, kind: 'composite', operation: null,
    operations: [{ name: id, selector: { componentIds: ['node-root'] } }],
    targets: [{
      id: command.targetId, componentId: command.componentId, adapterId: command.adapterId,
      operation: command.operation, kind: 'command', commandIds: [command.id],
    }],
    commands: [command], commandAggregateHash: hashValue([command.commandHash]),
    catalogDigests: { workflow: 'a'.repeat(64), providers: 'b'.repeat(64), adapters: 'c'.repeat(64) },
  };
  binding.targetAggregateHash = hashValue(binding.targets);
  binding.bindingDigest = hashValue(binding);
  return { id, evidenceBinding: binding };
}

test('runStep revalidates local tool trust after the child exits before sealing PASS', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'factory-runner-trust-'));
  const executable = path.join(root, process.platform === 'win32' ? 'helper.exe' : 'helper');
  fs.copyFileSync(process.execPath, executable);
  if (process.platform !== 'win32') fs.chmodSync(executable, 0o755);
  const executableDigest = crypto.createHash('sha256').update(fs.readFileSync(executable)).digest('hex');
  fs.mkdirSync(path.join(root, '.factory'));
  const trustPath = path.join(root, '.factory', 'toolchain-trust.json');
  fs.writeFileSync(trustPath, JSON.stringify({
    schemaVersion: '1.0.0',
    platformFamily: process.platform === 'win32' ? 'win32' : 'posix',
    entries: [{ logicalExecutable: 'helper', sha256: [executableDigest] }],
  }));
  const step = boundStep('trusted', [executable], '.', {
    projectRoot: root, toolchainTrust: loadToolchainTrust(root),
  });
  const spawnImpl = (command, args, options) => {
    const child = fakeSpawn({ code: 0 }, [])(command, args, options);
    fs.appendFileSync(trustPath, os.EOL);
    return child;
  };
  await assert.rejects(
    () => runStep(step, { root, planHash: 'plan', spawnImpl }),
    error => error.code === 'FACTORY_TOOLCHAIN_TRUST_CHANGED'
      && !error.message.includes(root),
  );
});

test('runStep executes argv with shell false and produces PASS evidence', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'factory-runner-'));
  fs.writeFileSync(path.join(root, 'source.js'), 'stable');
  const calls = [];
  const evidence = await runStep(
    boundStep('tests', ['node', '--test']),
    { root, attempt: 1, planHash: 'plan', spawnImpl: fakeSpawn({ code: 0, stdout: 'ok' }, calls) }
  );
  assert.equal(calls[0].options.shell, false);
  assert.equal(calls[0].command, process.execPath);
  assert.deepEqual(calls[0].args, ['--test']);
  assert.equal(evidence.status, 'PASS');
  assert.equal(
    evidence.components[0].launchDigest,
    evidence.command.commands[0].launchBinding.launchDigest,
  );
  assert.equal(evidence.redactionPolicyVersion, REDACTION_POLICY_VERSION);
  assert.equal(evidence.stdout, 'ok');
  assert.match(evidence.inputCertificationIdentityDigest, /^[a-f0-9]{64}$/);
  assert.equal(evidence.certificationIdentityDigest, evidence.inputCertificationIdentityDigest);
  assert.match(evidence.layoutInputDigest, /^[a-f0-9]{64}$/);
  const persisted = JSON.parse(JSON.stringify(evidence));
  const { assessEvidence } = require('../lib/factory/evidence');
  assert.equal(assessEvidence(persisted, {
    sourceTreeHash: persisted.sourceTreeHash,
    planHash: 'plan',
    now: new Date(persisted.finishedAt),
  }).fresh, true);
});

test('runStep fails when resolver context changes without a source-tree change', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'factory-runner-context-'));
  let changed = false;
  const identity = () => ({
    sourceTreeHash: 'a'.repeat(64),
    layoutInputDigest: changed ? 'c'.repeat(64) : 'b'.repeat(64),
    certificationIdentityDigest: changed ? 'e'.repeat(64) : 'd'.repeat(64),
  });
  const spawnImpl = (command, args, options) => {
    const child = fakeSpawn({ code: 0 }, [])(command, args, options);
    changed = true;
    return child;
  };
  const evidence = await runStep(
    boundStep('layout', ['node']),
    { root, planHash: 'plan', spawnImpl, certificationIdentityFn: identity },
  );
  assert.equal(evidence.status, 'FAIL');
  assert.equal(evidence.inputTreeHash, evidence.sourceTreeHash);
  assert.notEqual(evidence.inputCertificationIdentityDigest, evidence.certificationIdentityDigest);
  assert.match(evidence.reason, /certification input/);
});

test('runStep rejects legacy unbound steps and bound cwd traversal', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'factory-runner-'));
  await assert.rejects(() => runStep({ id: 'x', command: 'echo unsafe' }, { root }), /LEGACY_UNBOUND_PLAN/);
  await assert.rejects(
    () => runStep(boundStep('x', ['node'], '..'), { root }),
    /outside project root/
  );
});

test('runStep bounds output and fails when verification mutates the source tree', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'factory-runner-'));
  const source = path.join(root, 'source.js');
  fs.writeFileSync(source, 'before');
  const spawnImpl = (command, args, options) => {
    const child = fakeSpawn({ code: 0, stdout: 'abcdefghij' }, [])(command, args, options);
    fs.writeFileSync(source, 'after');
    return child;
  };
  const evidence = await runStep(
    boundStep('tests', ['node']),
    { root, attempt: 1, planHash: 'plan', spawnImpl, maxOutputBytes: 4 }
  );
  assert.equal(evidence.status, 'FAIL');
  assert.equal(evidence.outputTruncated, true);
  assert.equal(Buffer.byteLength(evidence.stdout), 4);
  assert.match(evidence.reason, /modified certification input/);
});

test('runStep records a timeout as FAIL and requests termination', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'factory-runner-'));
  fs.writeFileSync(path.join(root, 'source.js'), 'stable');
  let killed = false;
  const spawnImpl = () => {
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.kill = () => { killed = true; };
    return child;
  };
  const evidence = await runStep(
    boundStep('tests', ['node']),
    { root, planHash: 'plan', spawnImpl, timeoutMs: 5 }
  );
  assert.equal(evidence.status, 'FAIL');
  assert.equal(evidence.signal, 'TIMEOUT');
  assert.equal(killed, true);
});

test('runStep honors a sealed per-command timeout over the shorter runtime fallback', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'factory-runner-timeout-'));
  fs.writeFileSync(path.join(root, 'source.js'), 'stable');
  let killed = false;
  const spawnImpl = () => {
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.kill = () => { killed = true; };
    setTimeout(() => child.emit('close', 0, null), 20);
    return child;
  };
  const evidence = await runStep(
    boundStep('tests', ['node'], '.', {}, 1000),
    { root, planHash: 'plan', spawnImpl, timeoutMs: 5 },
  );
  assert.equal(evidence.status, 'PASS');
  assert.equal(evidence.command.commands[0].timeoutMs, 1000);
  assert.equal(killed, false);
});

test('runStep propagates process spawn errors and rejects caller argv substitution', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'factory-runner-'));
  await assert.rejects(
    () => runStep(boundStep('x', ['node']), { root, commandArgv: ['node', '-e', ''] }),
    /does not match/
  );
  const spawnImpl = () => {
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.kill = () => {};
    process.nextTick(() => child.emit('error', new Error('spawn denied')));
    return child;
  };
  await assert.rejects(
    () => runStep(boundStep('x', ['node']), { root, spawnImpl }),
    /spawn denied/
  );
});

test('runner allowlists inherited environment and redacts secret argv in evidence', async () => {
  const env = buildSafeEnv({
    PATH: 'ok', HOME: 'home', APPDATA: 'roaming', LOCALAPPDATA: 'local',
    PROGRAMDATA: 'program-data', ProgramFiles: 'program-files',
    'ProgramFiles(x86)': 'program-files-x86', CommonProgramFiles: 'common-program-files',
    ANDROID_HOME: 'android-home',
    ANDROID_SDK_ROOT: 'android-sdk-root', TOP_SECRET: 'leak',
  });
  assert.equal(env.PATH, 'ok');
  assert.equal(env.APPDATA, 'roaming');
  assert.equal(env.LOCALAPPDATA, 'local');
  assert.equal(env.PROGRAMDATA, 'program-data');
  assert.equal(env.ProgramFiles, 'program-files');
  assert.equal(env['ProgramFiles(x86)'], 'program-files-x86');
  assert.equal(env.CommonProgramFiles, 'common-program-files');
  assert.equal(env.ANDROID_HOME, 'android-home');
  assert.equal(env.ANDROID_SDK_ROOT, 'android-sdk-root');
  assert.equal(env.TOP_SECRET, undefined);
  assert.deepEqual(
    redactArgv(['tool', '--token', 'live-value', '--password=hidden', '--name', 'safe']),
    ['tool', '--token', '<redacted>', '--password=<redacted>', '--name', 'safe']
  );

  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'factory-runner-'));
  fs.writeFileSync(path.join(root, 'source.js'), 'stable');
  const capture = [];
  const canary = 'runtime-secret-canary';
  const evidence = await runStep(
    boundStep('secure', ['node', '--version']),
    {
      root, env: { API_TOKEN: canary },
      spawnImpl: fakeSpawn({ code: 0, stdout: `prefix ${canary} suffix`, stderr: `token=${canary}` }, capture),
    }
  );
  assert.equal(capture[0].options.env.TOP_SECRET, undefined);
  assert.equal(capture[0].options.env.API_TOKEN, canary);
  assert.equal(JSON.stringify(evidence).includes(canary), false);
  assert.equal(evidence.stdout.includes('<redacted>'), true);
  assert.equal(evidence.stderr.includes('<redacted>'), true);
});

test('runner preserves metacharacter arguments as data and never enables a shell', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'factory-runner-metachar-'));
  fs.writeFileSync(path.join(root, 'source.js'), 'stable');
  const calls = [];
  const argv = ['node', 'value && echo unsafe', '$(unsafe)', 'semi;colon'];
  await runStep(boundStep('metachar', argv), {
    root, spawnImpl: fakeSpawn({ code: 0 }, calls),
  });
  assert.equal(calls[0].command, process.execPath);
  assert.deepEqual(calls[0].args, argv.slice(1));
  assert.equal(calls[0].options.shell, false);
});

test('runner rejects a resealed control-interpreter binding before spawn', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'factory-runner-shell-'));
  const step = boundStep('shell', ['node']);
  const binding = step.evidenceBinding;
  const command = binding.commands[0];
  const logicalExecutable = process.platform === 'win32' ? 'cmd.exe' : 'bash';
  command.argv = [logicalExecutable, '-c', 'unsafe'];
  command.launchBinding = {
    ...command.launchBinding, logicalExecutable,
  };
  delete command.launchBinding.launchDigest;
  command.launchBinding.launchDigest = hashValue(command.launchBinding);
  command.commandHash = hashValue({
    providerId: binding.providerId, componentId: command.componentId, adapterId: command.adapterId,
    operation: command.operation, argv: command.argv, cwd: command.cwd,
    launchDigest: command.launchBinding.launchDigest,
  });
  binding.commandAggregateHash = hashValue([command.commandHash]);
  delete binding.bindingDigest;
  binding.bindingDigest = hashValue(binding);
  let spawned = false;
  await assert.rejects(
    () => runStep(step, { root, spawnImpl: () => { spawned = true; throw new Error('must not spawn'); } }),
    /control interpreter launch is invalid/,
  );
  assert.equal(spawned, false);
});
