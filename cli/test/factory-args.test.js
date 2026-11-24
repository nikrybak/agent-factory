'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  ArgsError,
  NEW_COMMANDS,
  parseFactoryArgs,
} = require('../lib/factory/args');

test('parseFactoryArgs strictly parses global and command options', () => {
  const parsed = parseFactoryArgs([
    'detect', '--project', 'C:\\work tree', '--json', '--dry-run',
    '--max-depth=4', '--write',
  ]);

  assert.deepEqual(parsed, {
    kind: 'factory',
    command: 'detect',
    options: {
      project: 'C:\\work tree',
      json: true,
      dryRun: true,
      maxDepth: 4,
      write: true,
    },
  });
});

test('parseFactoryArgs supports every new command', () => {
  for (const command of NEW_COMMANDS) {
    assert.equal(parseFactoryArgs([command]).command, command);
  }
});

test('parseFactoryArgs preserves legacy commands as opaque argv', () => {
  const argv = ['sync', '--check', '--from'];
  assert.deepEqual(parseFactoryArgs(argv), {
    kind: 'legacy',
    command: 'sync',
    argv,
  });
});

test('parseFactoryArgs rejects unknown options for a new command', () => {
  assert.throws(
    () => parseFactoryArgs(['status', '--write']),
    error => error instanceof ArgsError && error.code === 'USAGE' && /--write/.test(error.message),
  );
});

test('parseFactoryArgs rejects command options used on the wrong command', () => {
  assert.throws(
    () => parseFactoryArgs(['run', '--max-depth', '2']),
    /not valid for command 'run'/,
  );
});

test('parseFactoryArgs rejects missing values, duplicates, and positionals', () => {
  assert.throws(() => parseFactoryArgs(['init', '--project']), /requires a value/);
  assert.throws(() => parseFactoryArgs(['init', '--project=']), /requires a value/);
  assert.throws(() => parseFactoryArgs(['init', '--json=true']), /does not accept a value/);
  assert.throws(
    () => parseFactoryArgs(['init', '--project', '.', '--project', 'elsewhere']),
    /specified more than once/,
  );
  assert.throws(() => parseFactoryArgs(['plan', 'surprise']), /unexpected positional/);
});

test('parseFactoryArgs validates bounded integer options', () => {
  assert.throws(() => parseFactoryArgs(['detect', '--max-depth', '0']), /positive integer/);
  assert.throws(() => parseFactoryArgs(['detect', '--max-depth', '1.5']), /positive integer/);
  assert.equal(parseFactoryArgs(['detect', '--max-depth', '20']).options.maxDepth, 20);
  assert.throws(() => parseFactoryArgs(['detect', '--max-depth', '21']), /at most 20/);
  assert.throws(
    () => parseFactoryArgs(['detect', '--max-depth', '99999999999999999999']),
    /safe positive integer/,
  );
});

test('parseFactoryArgs rejects unknown or absent commands', () => {
  assert.throws(() => parseFactoryArgs(null), /argv must be an array/);
  assert.throws(() => parseFactoryArgs([]), /command is required/);
  assert.throws(() => parseFactoryArgs(['destroy']), /unknown command/);
  assert.throws(() => parseFactoryArgs(['status', '--mystery']), /unknown option/);
});

test('run accepts a command only as argv after the separator', () => {
  const parsed = parseFactoryArgs([
    'run', '--project', 'C:\\work tree', '--step', 'tests', '--',
    'node', '--test', 'file with spaces.test.js',
  ]);
  assert.deepEqual(parsed.options.commandArgv, [
    'node', '--test', 'file with spaces.test.js',
  ]);
  assert.throws(() => parseFactoryArgs(['run', '--step', 'tests', 'node --test']), /unexpected positional/);
  assert.throws(() => parseFactoryArgs(['status', '--', 'node']), /only valid for command 'run'/);
});

test('stage-sensitive commands accept an additive explicit run selector', () => {
  for (const command of ['attest', 'eval', 'observe', 'control', 'release-plan', 'certify']) {
    assert.equal(parseFactoryArgs([command, '--run', 'governed-run']).options.run, 'governed-run');
  }
});
