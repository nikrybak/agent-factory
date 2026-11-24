'use strict';

const NEW_COMMANDS = Object.freeze([
  'init',
  'detect',
  'plan',
  'run',
  'status',
  'resume',
  'verify',
  'explain',
  'trace',
  'workforce',
  'adapters',
  'trust',
  'sbom',
  'attest',
  'eval',
  'observe',
  'control',
  'release-plan',
  'certify',
]);

const LEGACY_COMMANDS = new Set(['sync', 'validate', 'doctor']);
const GLOBAL_OPTIONS = new Set(['--project', '--json', '--dry-run']);
const COMMAND_OPTIONS = Object.freeze({
  init: new Set(['--profile', '--force']),
  detect: new Set(['--max-depth', '--write']),
  plan: new Set(['--goal', '--run-id']),
  run: new Set(['--run', '--step']),
  status: new Set(['--run']),
  resume: new Set(['--run', '--retry-failed']),
  verify: new Set(['--run']),
  explain: new Set(['--run', '--step', '--decision']),
  trace: new Set([]),
  workforce: new Set([]),
  adapters: new Set(['--family', '--operation']),
  trust: new Set(['--tool', '--tier']),
  sbom: new Set(['--write']),
  attest: new Set(['--run', '--private-key', '--public-key', '--write']),
  eval: new Set(['--run']),
  observe: new Set(['--run', '--record']),
  control: new Set(['--run']),
  'release-plan': new Set(['--run', '--action', '--family']),
  certify: new Set(['--run']),
});

const OPTION_DEFINITIONS = Object.freeze({
  '--project': { key: 'project', type: 'string' },
  '--json': { key: 'json', type: 'boolean' },
  '--dry-run': { key: 'dryRun', type: 'boolean' },
  '--profile': { key: 'profile', type: 'string' },
  '--force': { key: 'force', type: 'boolean' },
  '--max-depth': { key: 'maxDepth', type: 'positiveInteger', max: 20 },
  '--write': { key: 'write', type: 'boolean' },
  '--goal': { key: 'goal', type: 'string' },
  '--run-id': { key: 'runId', type: 'string' },
  '--run': { key: 'run', type: 'string' },
  '--step': { key: 'step', type: 'string' },
  '--retry-failed': { key: 'retryFailed', type: 'boolean' },
  '--decision': { key: 'decision', type: 'string' },
  '--family': { key: 'family', type: 'string' },
  '--operation': { key: 'operation', type: 'string' },
  '--tool': { key: 'tool', type: 'string' },
  '--tier': { key: 'tier', type: 'string' },
  '--private-key': { key: 'privateKey', type: 'string' },
  '--public-key': { key: 'publicKey', type: 'string' },
  '--record': { key: 'record', type: 'boolean' },
  '--action': { key: 'action', type: 'string' },
});

class ArgsError extends Error {
  constructor(message) {
    super(`[infra] ${message}`);
    this.name = 'ArgsError';
    this.code = 'USAGE';
  }
}

function splitOption(token) {
  const equals = token.indexOf('=');
  if (equals < 0) return { name: token, inlineValue: undefined };
  return { name: token.slice(0, equals), inlineValue: token.slice(equals + 1) };
}

function parseValue(name, definition, value) {
  if (value === undefined || value === '' || value.startsWith('--')) {
    throw new ArgsError(`option ${name} requires a value`);
  }
  if (definition.type === 'string') return value;
  // The closed option table contains only strings, booleans handled by the
  // caller, and bounded positive integers here.
  if (!/^\d+$/.test(value) || Number(value) < 1) {
    throw new ArgsError(`option ${name} must be a positive integer`);
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) {
    throw new ArgsError(`option ${name} must be a safe positive integer`);
  }
  if (definition.max && parsed > definition.max) {
    throw new ArgsError(`option ${name} must be at most ${definition.max}`);
  }
  return parsed;
}

function parseFactoryArgs(input) {
  if (!Array.isArray(input)) throw new TypeError('argv must be an array');
  const argv = input.slice();
  const command = argv[0];
  if (!command) throw new ArgsError('command is required');

  if (LEGACY_COMMANDS.has(command)) {
    return { kind: 'legacy', command, argv };
  }
  if (!NEW_COMMANDS.includes(command)) {
    throw new ArgsError(`unknown command '${command}'`);
  }

  const allowed = new Set([...GLOBAL_OPTIONS, ...COMMAND_OPTIONS[command]]);
  const options = {};
  const seen = new Set();

  for (let index = 1; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === '--') {
      if (command !== 'run') throw new ArgsError("command separator is only valid for command 'run'");
      const commandArgv = argv.slice(index + 1);
      if (!commandArgv.length) throw new ArgsError('run command argv is required after --');
      options.commandArgv = commandArgv;
      break;
    }
    if (typeof token !== 'string' || !token.startsWith('--')) {
      throw new ArgsError(`unexpected positional argument '${String(token)}'`);
    }

    const { name, inlineValue } = splitOption(token);
    const definition = OPTION_DEFINITIONS[name];
    if (!definition) throw new ArgsError(`unknown option '${name}'`);
    if (!allowed.has(name)) {
      throw new ArgsError(`option ${name} is not valid for command '${command}'`);
    }
    if (seen.has(definition.key)) {
      throw new ArgsError(`option ${name} was specified more than once`);
    }
    seen.add(definition.key);

    if (definition.type === 'boolean') {
      if (inlineValue !== undefined) {
        throw new ArgsError(`boolean option ${name} does not accept a value`);
      }
      options[definition.key] = true;
      continue;
    }

    const value = inlineValue === undefined ? argv[++index] : inlineValue;
    options[definition.key] = parseValue(name, definition, value);
  }

  return { kind: 'factory', command, options };
}

module.exports = {
  ArgsError,
  NEW_COMMANDS,
  parseArgs: parseFactoryArgs,
  parseFactoryArgs,
};
