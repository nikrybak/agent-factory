'use strict';
/** @implements REQ-CITY-011 Immutable governed execution of complete evidence bindings. */

const childProcess = require('node:child_process');
const path = require('node:path');
const { createEvidence } = require('./evidence');
const { assertRuntimeSelection, executeBuiltinProvider } = require('./evidence-providers');
const { hashValue } = require('./hash');
const { computeCertificationIdentity } = require('./identity');
const { resolveLaunch } = require('./launcher');
const {
  DEFAULT_MAX_OUTPUT_BYTES, compileRedactionPolicy, createRedactingCollector,
  redactArgv, redactValue,
} = require('./redaction');
const { resolveWithinRoot } = require('./store');

const SAFE_ENV_KEYS = [
  'PATH', 'Path', 'PATHEXT', 'SystemRoot', 'WINDIR', 'COMSPEC', 'TEMP', 'TMP',
  'HOME', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'PROGRAMDATA',
  // Docker Desktop locates its buildx/compose CLI plugins through these
  // Windows program-root variables. They are machine paths, not credentials.
  'ProgramFiles', 'ProgramFiles(x86)', 'CommonProgramFiles',
  'ANDROID_HOME', 'ANDROID_SDK_ROOT', 'CI', 'TERM', 'NO_COLOR',
];
function buildSafeEnv(source = process.env, explicit = {}) {
  const result = {};
  for (const key of SAFE_ENV_KEYS) if (source[key] !== undefined) result[key] = source[key];
  for (const [key, value] of Object.entries(explicit || {})) result[key] = value;
  return result;
}

function executeArgv(argv, options = {}) {
  if (!Array.isArray(argv) || argv.length === 0 || argv.some(value => typeof value !== 'string' || value.includes('\0')) || !argv[0]) {
    return Promise.reject(new Error('command must provide a non-empty argv string array without null bytes'));
  }
  const spawnImpl = options.spawnImpl || childProcess.spawn;
  const maxOutputBytes = options.maxOutputBytes || DEFAULT_MAX_OUTPUT_BYTES;
  const timeoutMs = options.timeoutMs || 10 * 60 * 1000;
  const runtimeEnv = buildSafeEnv(process.env, options.env);
  const policy = compileRedactionPolicy({ argv, env: runtimeEnv });
  return new Promise((resolve, reject) => {
    const stdout = createRedactingCollector({ policy, maxBytes: maxOutputBytes });
    const stderr = createRedactingCollector({ policy, maxBytes: maxOutputBytes });
    let settled = false;
    const started = Date.now();
    const child = spawnImpl(argv[0], argv.slice(1), {
      cwd: options.cwd,
      env: runtimeEnv,
      shell: false,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const timer = setTimeout(() => {
      if (settled) return;
      child.kill('SIGTERM');
      settled = true;
      const out = stdout.finish(); const err = stderr.finish();
      resolve({ exitCode: null, signal: 'TIMEOUT', stdout: out.text, stderr: err.text, outputTruncated: out.truncated || err.truncated, durationMs: Date.now() - started });
    }, timeoutMs);
    // Not unref'd: the timeout must fire even when the child holds no handle that keeps the loop
    // alive; close and error clear it.
    child.stdout.on('data', chunk => {
      stdout.write(chunk);
    });
    child.stderr.on('data', chunk => {
      stderr.write(chunk);
    });
    child.on('error', error => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(error);
    });
    child.on('close', (exitCode, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const out = stdout.finish(); const err = stderr.finish();
      resolve({ exitCode, signal, stdout: out.text, stderr: err.text, outputTruncated: out.truncated || err.truncated, durationMs: Date.now() - started });
    });
  });
}

function childRecord(command, result) {
  const status = result.exitCode === 0 && result.signal !== 'TIMEOUT' ? 'PASS' : 'FAIL';
  const child = {
    id: command.id,
    targetId: command.targetId,
    componentId: command.componentId,
    adapterId: command.adapterId,
    operation: command.operation,
    commandHash: command.commandHash,
    launchDigest: command.launchBinding.launchDigest,
    status,
    exitCode: result.exitCode,
    signal: result.signal,
    stdout: result.stdout,
    stderr: result.stderr,
    outputTruncated: result.outputTruncated,
    durationMs: result.durationMs,
  };
  child.digest = hashValue(child);
  return child;
}

function naChildRecord(target) {
  const child = {
    id: target.id,
    componentId: target.componentId,
    adapterId: target.adapterId,
    operation: target.operation,
    status: 'NA',
    reasonCode: target.reasonCode,
    reason: target.reason,
  };
  child.digest = hashValue(child);
  return child;
}

async function runStep(step, context = {}) {
  if (!step || typeof step.id !== 'string') throw new Error('step id is required');
  const binding = step.evidenceBinding || context.evidenceBinding;
  assertRuntimeSelection(binding, context.commandArgv);
  const root = path.resolve(context.root || process.cwd());
  const redactionPolicy = compileRedactionPolicy({
    argv: context.commandArgv || [], env: buildSafeEnv(process.env, context.env),
  });
  const identityFn = context.certificationIdentityFn || computeCertificationIdentity;
  const beforeIdentity = identityFn(root);
  const startedAt = new Date().toISOString();
  const components = [];
  if (binding.kind === 'na') {
    const finishedAt = new Date().toISOString();
    return createEvidence({
      stepId: step.id, attempt: context.attempt || 1, status: 'NA', reason: binding.naReason,
      providerId: binding.providerId, bindingDigest: binding.bindingDigest,
      commandHash: hashValue({ providerId: binding.providerId, operation: null }),
      planHash: context.planHash, sourceTreeHash: beforeIdentity.sourceTreeHash,
      inputTreeHash: beforeIdentity.sourceTreeHash,
      certificationIdentityDigest: beforeIdentity.certificationIdentityDigest,
      inputCertificationIdentityDigest: beforeIdentity.certificationIdentityDigest,
      layoutInputDigest: beforeIdentity.layoutInputDigest, startedAt, finishedAt,
      expiresAt: new Date(Date.parse(finishedAt) + (context.ttlMs || 24 * 60 * 60 * 1000)).toISOString(),
      components,
      componentAggregateHash: hashValue([]),
    });
  }
  if (binding.kind === 'builtin') {
    const result = redactValue(
      await executeBuiltinProvider(binding.operation, { ...context, root, plan: context.plan }),
      { policy: redactionPolicy },
    );
    const child = {
      id: `builtin:${binding.operation}`, operation: binding.operation, status: result.status,
      ...(result.reason ? { reason: result.reason } : {}),
      ...(result.metadata && typeof result.metadata === 'object' && !Array.isArray(result.metadata)
        ? { metadata: result.metadata } : {}),
    };
    child.digest = hashValue(child);
    components.push(child);
  } else {
    const commands = new Map(binding.commands.map(command => [command.id, command]));
    for (const target of binding.targets) {
      if (target.kind === 'na') {
        components.push(naChildRecord(target));
        continue;
      }
      for (const commandId of target.commandIds) {
        const command = commands.get(commandId);
        const cwd = resolveWithinRoot(root, command.cwd || '.', { allowRoot: true });
        const launchOptions = { ...(context.launcherOptions || {}), projectRoot: root };
        const launchArgv = resolveLaunch(command.argv, command.launchBinding, launchOptions);
        const result = await executeArgv(launchArgv, {
          cwd, env: context.env, maxOutputBytes: context.maxOutputBytes,
          timeoutMs: command.timeoutMs ?? context.timeoutMs, spawnImpl: context.spawnImpl,
        });
        resolveLaunch(command.argv, command.launchBinding, launchOptions);
        components.push(childRecord(command, result));
      }
    }
  }
  const finishedAt = new Date().toISOString();
  const afterIdentity = identityFn(root);
  const sourceMutated = beforeIdentity.sourceTreeHash !== afterIdentity.sourceTreeHash;
  const contextMutated = beforeIdentity.certificationIdentityDigest
    !== afterIdentity.certificationIdentityDigest;
  const mutated = sourceMutated || contextMutated;
  const failed = components.filter(component => component.status === 'FAIL');
  const reason = mutated ? 'verification command modified certification input' :
    (failed.length ? failed.map(component => component.reason || `${component.id} failed`).join('; ') : undefined);
  const status = failed.length === 0 && !mutated ? 'PASS' : 'FAIL';
  const ttlMs = context.ttlMs || 24 * 60 * 60 * 1000;
  const output = components.filter(component => component.commandHash);
  return createEvidence({
    stepId: step.id,
    attempt: context.attempt || 1,
    status,
    reason,
    redactionPolicyVersion: binding.redactionPolicyVersion,
    providerId: binding.providerId,
    bindingDigest: binding.bindingDigest,
    command: binding.kind === 'composite' ? {
      commands: binding.commands.map(command => ({
        ...command,
        argv: redactArgv(command.argv, compileRedactionPolicy({ argv: command.argv, env: context.env || {} })),
      })),
    } : { operation: binding.operation },
    commandHash: binding.targetAggregateHash || hashValue({ providerId: binding.providerId, operation: binding.operation }),
    componentAggregateHash: hashValue(components.map(component => component.digest)),
    components,
    planHash: context.planHash,
    sourceTreeHash: afterIdentity.sourceTreeHash,
    inputTreeHash: beforeIdentity.sourceTreeHash,
    certificationIdentityDigest: afterIdentity.certificationIdentityDigest,
    inputCertificationIdentityDigest: beforeIdentity.certificationIdentityDigest,
    layoutInputDigest: afterIdentity.layoutInputDigest,
    startedAt,
    finishedAt,
    expiresAt: new Date(Date.parse(finishedAt) + ttlMs).toISOString(),
    exitCode: output.length === 1 ? output[0].exitCode : null,
    signal: output.length === 1 ? output[0].signal : null,
    stdout: output.length === 1 ? output[0].stdout : '',
    stderr: output.length === 1 ? output[0].stderr : '',
    outputTruncated: output.some(component => component.outputTruncated),
    durationMs: components.reduce((sum, component) => sum + (component.durationMs || 0), 0),
  });
}

module.exports = { buildSafeEnv, executeArgv, redactArgv, runStep };
