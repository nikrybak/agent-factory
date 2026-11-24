#!/usr/bin/env node
'use strict';

// Memoized runner of the root Python unit tests (ADR-0021, amended 2026-10-29): each tests/test_*.py module runs on its
// own under the read tracer and its pass is stored with the exact inputs it read (see cli/lib/node-test-memo.js),
// so a module is skipped while none of them changed. A module that starts a program the tracer cannot follow is
// keyed by the whole code tree instead. INFRA_NODE_TEST_CACHE=0 forces every module to run and stores nothing.

const fs = require('node:fs');
const path = require('node:path');
const { NODE_FILES, runPlain } = require('./run_node_tests');

function discoverPythonTests(root) {
  const directory = path.join(root, 'tests');
  if (!fs.existsSync(directory)) return [];
  return fs.readdirSync(directory, { withFileTypes: true })
    .filter(entry => entry.isFile() && /^test_.*\.py$/.test(entry.name))
    .map(entry => path.join('tests', entry.name))
    .sort((left, right) => left.localeCompare(right, 'en'));
}

function pythonFamily(env = process.env) {
  const executable = env.INFRA_TEST_PYTHON || (process.platform === 'win32' ? 'python' : 'python3');
  return Object.freeze({
    label: 'py',
    title: 'python-tests',
    command: file => ({
      executable,
      args: ['-m', 'unittest', 'discover', '-s', 'tests', '-p', path.basename(file)],
    }),
    staticFiles: (root, file) => [path.join(root, file)],
  });
}

async function main(argv = process.argv.slice(2)) {
  if (argv.length) {
    process.stderr.write('usage: run_python_tests.js (the interpreter comes from INFRA_TEST_PYTHON)\n');
    return 2;
  }
  const root = path.resolve(__dirname, '..');
  const tests = discoverPythonTests(root);
  if (tests.length === 0) {
    process.stderr.write('No Python unit tests were discovered\n');
    return 2;
  }
  return runPlain(root, tests, process.env.INFRA_NODE_TEST_CACHE !== '0', text => process.stdout.write(text), pythonFamily());
}

module.exports = { NODE_FILES, discoverPythonTests, main, pythonFamily };

if (require.main === module) {
  main().then(code => { process.exitCode = code; });
}
