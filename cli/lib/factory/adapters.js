'use strict';
/** @implements REQ-FK-011 Exact adapter selection and ordered non-shell operation contracts. */

const fs = require('node:fs');
const path = require('node:path');
const { resolveInside } = require('./paths');

const ID = /^[a-z][a-z0-9-]*$/;
const OPERATIONS = Object.freeze(['detect', 'install', 'lint', 'typecheck', 'test', 'coverage', 'build', 'security', 'package', 'e2e', 'deploy']);
const MUTATING_AUTHORITY = Object.freeze({ install: 'dependencyInstall', deploy: 'deploy' });
const SHELL_PROGRAMS = new Set(['sh', 'bash', 'zsh', 'cmd', 'cmd.exe', 'powershell', 'pwsh']);
const ABSOLUTE_PROGRAM = /^(?:[a-zA-Z]:|[/\\])/;
const MIN_COMMAND_TIMEOUT_MS = 1000;
const MAX_COMMAND_TIMEOUT_MS = 6 * 60 * 60 * 1000;

function validateCommandTimeout(timeoutMs, subject) {
  if (!Number.isInteger(timeoutMs) || timeoutMs < MIN_COMMAND_TIMEOUT_MS || timeoutMs > MAX_COMMAND_TIMEOUT_MS) {
    throw new Error(`${subject} timeoutMs must be an integer from ${MIN_COMMAND_TIMEOUT_MS} to ${MAX_COMMAND_TIMEOUT_MS}`);
  }
}

function validateArgv(argv, subject) {
  if (!Array.isArray(argv) || argv.length === 0 || argv.some(arg => typeof arg !== 'string' || !arg.length || /[\r\n\0]/.test(arg))) {
    throw new Error(`${subject} requires non-empty safe argv`);
  }
  if (ABSOLUTE_PROGRAM.test(argv[0])) throw new Error(`${subject} must not use an absolute executable path`);
  const program = argv[0].replaceAll('\\', '/').split('/').at(-1).toLowerCase();
  if (SHELL_PROGRAMS.has(program)) throw new Error(`${subject} must not invoke a shell`);
}

function operationCommands(operation, subject) {
  const hasArgv = Object.hasOwn(operation, 'argv');
  const hasCommands = Object.hasOwn(operation, 'commands');
  if (hasArgv === hasCommands) throw new Error(`${subject} requires exactly one of argv or commands`);
  if (hasArgv) {
    validateArgv(operation.argv, subject);
    if (Object.hasOwn(operation, 'timeoutMs')) validateCommandTimeout(operation.timeoutMs, subject);
    return [{ id: null, argv: operation.argv, ...(operation.timeoutMs === undefined ? {} : { timeoutMs: operation.timeoutMs }) }];
  }
  if (Object.hasOwn(operation, 'timeoutMs')) throw new Error(`${subject} timeoutMs must be declared on each command`);
  if (!Array.isArray(operation.commands) || !operation.commands.length) {
    throw new Error(`${subject} requires non-empty commands`);
  }
  const ids = new Set();
  return operation.commands.map(command => {
    if (!command || Object.keys(command).some(key => !['id', 'argv', 'timeoutMs'].includes(key))
      || !ID.test(command.id || '') || ids.has(command.id)) {
      throw new Error(`${subject} command id is invalid or duplicate: ${command && command.id}`);
    }
    ids.add(command.id);
    validateArgv(command.argv, `${subject}.${command.id}`);
    if (Object.hasOwn(command, 'timeoutMs')) validateCommandTimeout(command.timeoutMs, `${subject}.${command.id}`);
    return command;
  });
}

function validateAdapterCatalog(catalog, options = {}) {
  if (!catalog || !['1.0.0', '1.1.0'].includes(catalog.schemaVersion) || !Array.isArray(catalog.adapters) || catalog.adapters.length === 0) {
    throw new Error('adapter catalog requires supported schemaVersion and adapters');
  }
  const ids = new Set(); const families = new Set();
  for (const adapter of catalog.adapters) {
    if (!adapter || !ID.test(adapter.id || '') || ids.has(adapter.id)) throw new Error(`invalid or duplicate adapter id: ${adapter && adapter.id}`);
    ids.add(adapter.id);
    if (!ID.test(adapter.family || '') || (catalog.schemaVersion === '1.0.0' && families.has(adapter.family))) throw new Error(`invalid or duplicate adapter family: ${adapter.family}`);
    families.add(adapter.family);
    if (!adapter.operations || typeof adapter.operations !== 'object' || Array.isArray(adapter.operations)) throw new Error(`adapter ${adapter.id} requires operations`);
    if (!adapter.operations.detect) throw new Error(`adapter ${adapter.id} must declare detect`);
    for (const [name, operation] of Object.entries(adapter.operations)) {
      if (!OPERATIONS.includes(name)) throw new Error(`adapter ${adapter.id} has unknown operation: ${name}`);
      if (!operation || typeof operation !== 'object') throw new Error(`adapter ${adapter.id}.${name} is invalid`);
      if (catalog.schemaVersion === '1.0.0' && !Object.hasOwn(operation, 'argv')) {
        throw new Error(`${adapter.id}.${name} requires legacy argv in schemaVersion 1.0.0`);
      }
      const allowedFields = catalog.schemaVersion === '1.0.0'
        ? ['argv', 'authority'] : ['argv', 'commands', 'authority', 'timeoutMs'];
      if (Object.keys(operation).some(key => !allowedFields.includes(key))) {
        throw new Error(`adapter ${adapter.id}.${name} has unknown fields`);
      }
      operationCommands(operation, `${adapter.id}.${name}`);
      if (operation.authority != null && typeof operation.authority !== 'string') throw new Error(`${adapter.id}.${name} authority must be a string`);
      if (MUTATING_AUTHORITY[name] && operation.authority !== MUTATING_AUTHORITY[name]) throw new Error(`${adapter.id}.${name} requires ${MUTATING_AUTHORITY[name]} authority`);
    }
    if (!Array.isArray(adapter.unsupported) || adapter.unsupported.some(name => !OPERATIONS.includes(name))
      || new Set(adapter.unsupported).size !== adapter.unsupported.length) throw new Error(`adapter ${adapter.id} requires valid unsupported operations`);
    for (const name of Object.keys(adapter.operations)) {
      if (adapter.unsupported.includes(name)) throw new Error(`adapter ${adapter.id} cannot support and reject ${name}`);
    }
    const declared = new Set([...Object.keys(adapter.operations), ...adapter.unsupported]);
    for (const operation of OPERATIONS) if (!declared.has(operation)) throw new Error(`adapter ${adapter.id} must explicitly support or reject ${operation}`);
  }
  for (const family of options.requiredFamilies || []) if (!families.has(family)) throw new Error(`adapter catalog missing detected family: ${family}`);
  return true;
}

function selectAdapters({ catalog, detection = {} }) {
  validateAdapterCatalog(catalog);
  const byId = new Map(catalog.adapters.map(adapter => [adapter.id, adapter]));
  const byFamily = new Map();
  for (const adapter of catalog.adapters) {
    if (!byFamily.has(adapter.family)) byFamily.set(adapter.family, []);
    byFamily.get(adapter.family).push(adapter);
  }
  const adapters = []; const gaps = [...(detection.gaps || [])];
  const selections = [];
  for (const component of [...(detection.components || [])].sort((left, right) =>
    `${left.id || left.family}:${left.root || '.'}`.localeCompare(`${right.id || right.family}:${right.root || '.'}`))) {
    const componentId = component.id || `${component.family}:${component.root || '.'}`;
    let adapter;
    if (component.adapterId) {
      adapter = byId.get(component.adapterId);
      if (!adapter || adapter.family !== component.family) {
        gaps.push({ code: 'invalid-component-adapter', subject: componentId, message: `Adapter ${component.adapterId} does not match ${component.family}` });
        continue;
      }
    } else {
      const candidates = byFamily.get(component.family) || [];
      if (candidates.length === 0) {
        gaps.push({ code: 'unsupported-stack-adapter', subject: componentId, message: `No adapter for detected family: ${component.family}` });
        continue;
      }
      if (candidates.length > 1) {
        gaps.push({ code: 'ambiguous-stack-adapter', subject: componentId, message: `Multiple adapters require adapterId for ${component.family}` });
        continue;
      }
      [adapter] = candidates;
    }
    selections.push({ componentId, adapterId: adapter.id });
    if (!adapters.some(item => item.id === adapter.id)) adapters.push(adapter);
  }
  adapters.sort((left, right) => left.id.localeCompare(right.id));
  return { status: gaps.length ? 'blocked' : 'ready', adapters, selections, gaps };
}

function canonicalAdapterProjectRoot(repositoryRoot, componentRoot = '.') {
  if (typeof repositoryRoot !== 'string' || !repositoryRoot || /[\r\n\0]/.test(repositoryRoot)
    || typeof componentRoot !== 'string' || !componentRoot || /[\r\n\0]/.test(componentRoot)) {
    throw new Error('adapter projectRoot context is missing or unsafe');
  }
  try {
    const resolved = resolveInside(repositoryRoot, componentRoot, { allowRoot: true });
    if (!fs.statSync(resolved).isDirectory()) throw new Error('not-directory');
    return fs.realpathSync.native(resolved);
  } catch {
    throw new Error('adapter projectRoot context is not a canonical in-repository directory');
  }
}

function expandAdapterArgv(argv, context = {}) {
  return argv.map(arg => {
    if (arg.includes('${projectRoot}') && arg !== '${projectRoot}') {
      throw new Error('adapter projectRoot placeholder must occupy one complete argv value');
    }
    const expanded = arg.replace(/\$\{([a-zA-Z][a-zA-Z0-9]*)\}/g, (_, key) => {
    if (typeof context[key] !== 'string' || !context[key]) throw new Error(`adapter context is missing: ${key}`);
    if (/[\r\n\0]/.test(context[key])) throw new Error(`adapter context is unsafe: ${key}`);
    return context[key];
    });
    if (expanded.includes('${')) throw new Error('adapter context placeholder is malformed');
    return expanded;
  });
}

function planAdapterOperation({ catalog, family, adapterId, operation, authority = {}, context = {} }) {
  validateAdapterCatalog(catalog);
  if (!OPERATIONS.includes(operation)) throw new Error(`unknown adapter operation: ${operation}`);
  const candidates = catalog.adapters.filter(item => item.family === family);
  const adapter = adapterId ? catalog.adapters.find(item => item.id === adapterId) : (candidates.length === 1 ? candidates[0] : null);
  if (adapterId && (!adapter || adapter.family !== family)) return { status: 'blocked', plans: [], gaps: [{ code: 'invalid-component-adapter', subject: adapterId, message: `Adapter ${adapterId} does not match ${family}` }] };
  if (!adapter && candidates.length > 1) return { status: 'blocked', plans: [], gaps: [{ code: 'ambiguous-stack-adapter', subject: family, message: `Multiple adapters require adapterId for ${family}` }] };
  if (!adapter) return { status: 'blocked', plans: [], gaps: [{ code: 'unsupported-stack-adapter', subject: family, message: `No adapter for family: ${family}` }] };
  const definition = adapter.operations[operation];
  if (!definition) return { status: 'blocked', plans: [], gaps: [{ code: 'unsupported-operation', subject: `${family}:${operation}`, message: `${family} does not support ${operation}` }] };
  if (definition.authority && authority[definition.authority] !== true) {
    return { status: 'blocked', plans: [], gaps: [{ code: 'authority-denied', subject: definition.authority, message: `${operation} requires ${definition.authority} authority` }] };
  }
  const commands = operationCommands(definition, `${adapter.id}.${operation}`);
  return {
    status: 'ready',
    plans: commands.map((command, index) => ({
      id: command.id ? `${adapter.id}:${operation}:${command.id}` : `${adapter.id}:${operation}`,
      sequence: index,
      adapterId: adapter.id, family, operation,
      argv: expandAdapterArgv(command.argv, context), cwd: context.root || '.', mutating: Boolean(definition.authority),
      ...(command.timeoutMs === undefined ? {} : { timeoutMs: command.timeoutMs }),
    })),
    gaps: [],
  };
}

module.exports = {
  MAX_COMMAND_TIMEOUT_MS, MIN_COMMAND_TIMEOUT_MS, OPERATIONS, canonicalAdapterProjectRoot,
  expandAdapterArgv, operationCommands,
  validateAdapterCatalog, selectAdapters, planAdapterOperation,
};
