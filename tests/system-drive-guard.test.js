'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { PassThrough } = require('node:stream');

const guard = require('../scripts/system-drive-guard');

/** A Windows path on [letter] built from parts (no drive literals in the sources: the base forbids machine paths). */
const at = (letter, ...parts) => path.win32.join(`${letter}:\\`, ...parts);
const slashed = target => target.split('\\').join('/');

const env = { SystemDrive: 'C:', USERPROFILE: at('C', 'Users', 'Owner'), DEV_TEMP: at('V', 'dev', 'tmp') };
const write = file_path => ({ tool_name: 'Write', tool_input: { file_path } });

test('a write to the system drive is denied, in every spelling of the path', () => {
  for (const target of [at('C', 'Users', 'Owner', 'AppData', 'Local', 'Temp', 'claude', 'x.png'), slashed(at('c', 'temp', 'a.txt')), '/c/data/x.log']) {
    assert.match(guard.verdict(write(target), env), /forbidden.*dev.tmp/s, target);
  }
  assert.match(guard.verdict({ tool_name: 'Edit', tool_input: { file_path: at('C', 'a.txt') } }, env), /forbidden/);
  assert.match(guard.verdict({ tool_name: 'NotebookEdit', tool_input: { notebook_path: at('C', 'n.ipynb') } }, env), /forbidden/);
});

test("the agent's own configuration and memory stay writable; other drives and tools are untouched", () => {
  assert.equal(guard.verdict(write(at('C', 'Users', 'Owner', '.claude', 'rules', 'x.md')), env), null);
  assert.equal(guard.verdict(write(slashed(at('c', 'Users', 'Owner', '.claude', 'projects', 'p', 'memory', 'm.md'))), env), null);
  assert.equal(guard.verdict(write(at('C', 'Users', 'Owner', '.claude')), env), null);
  assert.match(guard.verdict(write(at('C', 'Users', 'Owner', '.claudex', 'x')), env), /forbidden/, 'a look-alike folder is not the agent folder');
  assert.equal(guard.verdict(write(at('V', 'dev', 'tmp', 'jobs', 'a.png')), env), null);
  assert.equal(guard.verdict(write(slashed(at('w', 'code', 'x.js'))), env), null);
  assert.equal(guard.verdict(write('relative/file.js'), env), null);
  assert.equal(guard.verdict({ tool_name: 'Bash', tool_input: { command: `echo > ${at('C', 'x')}` } }, env), null);
  assert.equal(guard.verdict(null, env), null);
  assert.equal(guard.verdict(write(at('C', 'x')), { SystemDrive: 'D:' }), null, 'only the real system drive is guarded');
  assert.match(guard.verdict(write(at('C', 'x')), {}), /DEV_TEMP/);
});

function run(input) {
  const stdin = new PassThrough();
  const chunks = [];
  const stdout = { write: chunk => chunks.push(String(chunk)) };
  guard.main(stdin, stdout, env);
  stdin.end(input);
  return new Promise(resolve => stdin.on('end', () => setImmediate(() => resolve(chunks.join('')))));
}

test('as a hook it prints a deny decision, and stays silent on allowed or broken input', async () => {
  const denied = JSON.parse(await run(JSON.stringify(write(at('C', 'temp', 'x.txt')))));
  assert.equal(denied.hookSpecificOutput.permissionDecision, 'deny');
  assert.equal(denied.hookSpecificOutput.hookEventName, 'PreToolUse');
  assert.equal(await run(JSON.stringify(write(at('V', 'dev', 'tmp', 'x.txt')))), '');
  assert.equal(await run('not json'), '');
  assert.equal(await run(''), '');
});
