#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const memo = require('../cli/lib/node-test-memo');
const trace = require('../cli/lib/test-trace');
const { coverageTable, mergeLcov } = require('../cli/lib/lcov');

const ROOT_TEST_DIRS = Object.freeze([
  path.join('cli', 'test'),
  'tests',
]);
// The quality gate's coverage job: every CLI test (cli/test) but the CLI command suite, which spawns the whole CLI many
// times. Only the factory-* tests used to count, yet the table lists every module infra.js loads, so modules tested by
// their own suites (validate, doctor, clean, impacted...) read 15-30 % and the total 79.48 %; with all CLI tests it is
// the real figure (95.18 % on 2026-10-30). Each file is measured on its own and memoized, so only an edit costs time.
const GATE_COVERAGE_EXCLUDED = 'factory-cli-commands.test.js';
// The tracer preload is not part of the code under measurement. An explicit --test-coverage-exclude REPLACES Node's
// default (the test files and test/ folders), so those defaults are listed again: without them the 2026-10-30 table
// counted the test files themselves and read 87.56 % where the same run measures 79.48 %.
const COVERAGE_EXCLUDE = [
  '--test-coverage-exclude=cli/lib/test-trace-preload.js',
  '--test-coverage-exclude=**/test/**',
  '--test-coverage-exclude=**/*.test.{js,cjs,mjs}',
  '--test-coverage-exclude=**/*{-,_}test.{js,cjs,mjs}',
  '--test-coverage-exclude=**/test-*.{js,cjs,mjs}',
];

function discoverRootNodeTests(root) {
  const discovered = [];
  for (const relativeDirectory of ROOT_TEST_DIRS) {
    const directory = path.join(root, relativeDirectory);
    if (!fs.existsSync(directory)) continue;
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      if (entry.isFile() && entry.name.endsWith('.test.js')) {
        discovered.push(path.join(relativeDirectory, entry.name));
      }
    }
  }
  return discovered.sort((left, right) => left.localeCompare(right, 'en'));
}

function discoverGateCoverageTests(root) {
  return discoverRootNodeTests(root).filter(file => {
    const name = path.basename(file);
    return path.dirname(file) === path.join('cli', 'test') && name !== GATE_COVERAGE_EXCLUDED;
  });
}

function buildNodeTestArgs(tests, coverage = false) {
  return ['--test', ...(coverage ? ['--experimental-test-coverage'] : []), ...tests];
}

function main(argv = process.argv.slice(2)) {
  const modes = ['--coverage', '--coverage-gate'];
  if (argv.length > 1 || (argv.length === 1 && !modes.includes(argv[0]))) {
    process.stderr.write('usage: run_node_tests.js [--coverage | --coverage-gate]\n');
    return 2;
  }
  const root = path.resolve(__dirname, '..');
  const tests = argv[0] === '--coverage-gate' ? discoverGateCoverageTests(root) : discoverRootNodeTests(root);
  if (tests.length === 0) {
    process.stderr.write('No City Fabric Node tests were discovered\n');
    return 2;
  }
  const cached = process.env.INFRA_NODE_TEST_CACHE !== '0';
  // ADR-0021: every test file is run on its own under the read tracer and its pass is stored with the inputs it
  // read; INFRA_NODE_TEST_CACHE=0 forces everything to run and stores nothing.
  if (argv[0]) return runCoverage(root, tests, cached);
  return runPlain(root, tests, cached);
}

function repositoryRoots(root) {
  const roots = [root];
  try { roots.push(fs.realpathSync.native(root)); } catch { /* the plain root still works */ }
  return roots;
}

function jobCount(env = process.env) {
  const configured = Number.parseInt(env.INFRA_NODE_TEST_JOBS || '', 10);
  return configured > 0 ? configured : Math.max(1, os.availableParallelism() - 1);
}

/** How a family of test files is run and memoized; Node files by default, Python modules in run_python_tests.js. */
const NODE_FILES = Object.freeze({
  label: 'file',
  title: 'node-tests',
  command: file => ({ executable: process.execPath, args: ['--test', file] }),
  staticFiles: (root, file) => memo.closure(path.join(root, file)),
});

/** Run one test file under the tracer; resolves with the exit status, output and parsed trace events. */
function runTraced(root, args, traced, executable = process.execPath) {
  return new Promise(resolve => {
    const dir = traced ? trace.newTraceDir() : null;
    const startedAt = Date.now();
    // NODE_TEST_CONTEXT is set inside a running test; kept, it would turn this run into a silent child of that one.
    const { NODE_TEST_CONTEXT: inherited, ...clean } = process.env;
    void inherited;
    const env = traced ? trace.traceEnv(dir, repositoryRoots(root), clean) : clean;
    const child = spawn(executable, args, { cwd: root, env, shell: false, stdio: ['ignore', 'pipe', 'pipe'] });
    const chunks = [];
    child.stdout.on('data', chunk => chunks.push(chunk));
    child.stderr.on('data', chunk => chunks.push(chunk));
    const finish = (status, error) => {
      const events = dir ? trace.parseTrace(dir) : [];
      if (dir) fs.rmSync(dir, { recursive: true, force: true });
      resolve({ status, error, output: Buffer.concat(chunks).toString('utf8'), events, startedAt, ms: Date.now() - startedAt });
    };
    child.on('error', error => finish(2, error));
    child.on('close', code => finish(code ?? 2));
  });
}

function slash(file) {
  return file.replace(/\\/g, '/');
}

/** `work(item)` over `items` on jobCount() parallel workers. */
async function inPool(items, work) {
  let cursor = 0;
  const worker = async () => {
    while (cursor < items.length) {
      const item = items[cursor];
      cursor += 1;
      await work(item);
    }
  };
  await Promise.all(Array.from({ length: Math.min(jobCount(), items.length) }, worker));
}

function isWholeTree(root, file) {
  return memo.WHOLE_TREE.test(fs.readFileSync(path.join(root, file), 'utf8'));
}

async function runPlain(root, tests, cached, write = text => process.stdout.write(text), family = NODE_FILES) {
  const plan = cached ? memo.planNodeTests(root, tests, { label: family.label }) : null;
  const selected = plan ? plan.pending : tests;
  if (plan) write(`[${family.title}] ${plan.proven.length} of ${tests.length} file(s) already proven, ${selected.length} to run\n`);
  if (selected.length === 0) {
    plan?.context.saveHashes();
    return 0;
  }
  if (plan) {
    // tree keys describe the tree as it was before the run: compute them now, not after the tests have run
    plan.context.codeHash();
    if (selected.some(file => isWholeTree(root, file))) plan.context.treeHash();
  }
  const started = Date.now();
  const failed = [];
  await inPool(selected, async file => {
    const { executable, args } = family.command(file);
    const result = await runTraced(root, args, cached, executable);
    if (result.error) process.stderr.write(`${result.error.message}\n`);
    if (result.status === 0) {
      let stored = 'not stored';
      if (plan) {
        const mode = memo.recordPass(plan.context, family.label, file, {
          events: result.events,
          staticFiles: family.staticFiles(root, file),
          startedAt: result.startedAt,
          ms: result.ms,
          treeFile: file,
          wholeTree: isWholeTree(root, file),
        });
        stored = mode ? `stored ${mode}` : 'not stored (inputs changed while it ran)';
      }
      write(`ok   ${slash(file)} ${(result.ms / 1000).toFixed(1)}s (${stored})\n`);
    } else {
      failed.push(file);
      write(`FAIL ${slash(file)} ${(result.ms / 1000).toFixed(1)}s\n${result.output}\n`);
    }
  });
  write(`[${family.title}] ${selected.length - failed.length} passed, ${failed.length} failed in ${((Date.now() - started) / 1000).toFixed(1)}s\n`);
  if (failed.length) write(`[${family.title}] failed files:\n${failed.map(file => `  ${slash(file)}`).join('\n')}\n`);
  plan?.context.saveHashes();
  return failed.length ? 1 : 0;
}

const COVERAGE_LABEL = 'coverage-lcov';

/** Node's flags for one file measured under coverage, its LCOV written to `lcov` and its results to stdout. */
function coverageFileArgs(file, lcov) {
  return [
    '--test', '--experimental-test-coverage', ...COVERAGE_EXCLUDE,
    '--test-reporter=lcov', `--test-reporter-destination=${lcov}`, '--test-reporter=spec', '--test-reporter-destination=stdout',
    file,
  ];
}

/**
 * Coverage per test file (ADR-0021, amendment 2026-10-30). Each file runs under coverage in a process of its own and
 * its LCOV is stored with the inputs it read; the table is merged from every file's LCOV (cli/lib/lcov.js), so after an
 * edit only the files that read it are measured again. Lines and functions equal one run over all the files; V8
 * reports branch blocks per execution and LCOV keeps no offsets, so the merged branch share differs; it read 88.41 %
 * against 89.62 % of one run over the same 66 files on 2026-10-30 (lines 94.98 against 95.00, functions equal).
 */
async function runCoverage(root, tests, cached, write = text => process.stdout.write(text)) {
  const context = cached ? memo.createContext(root) : null;
  const reports = new Map();
  const pending = [];
  for (const file of tests) {
    const found = context ? memo.findResult(context, COVERAGE_LABEL, file, file) : null;
    if (found === null) pending.push(file);
    else reports.set(file, found);
  }
  write(`[node-coverage] ${reports.size} of ${tests.length} file(s) already measured, ${pending.length} to run\n`);
  if (context && pending.length) {
    context.codeHash();
    if (pending.some(file => isWholeTree(root, file))) context.treeHash();
  }
  const started = Date.now();
  const failed = [];
  await inPool(pending, async file => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'infra-lcov-'));
    const lcov = path.join(dir, 'coverage.lcov');
    try {
      const result = await runTraced(root, coverageFileArgs(file, lcov), cached);
      if (result.error) process.stderr.write(`${result.error.message}\n`);
      const text = result.status === 0 && fs.existsSync(lcov) ? fs.readFileSync(lcov, 'utf8') : null;
      if (text === null) {
        failed.push(file);
        write(`FAIL ${slash(file)} ${(result.ms / 1000).toFixed(1)}s\n${result.output}\n`);
        return;
      }
      reports.set(file, text);
      const stored = context ? memo.recordResult(context, COVERAGE_LABEL, file, {
        events: result.events,
        staticFiles: NODE_FILES.staticFiles(root, file),
        startedAt: result.startedAt,
        ms: result.ms,
        treeFile: file,
        wholeTree: isWholeTree(root, file),
      }, text) : null;
      write(`ok   ${slash(file)} ${(result.ms / 1000).toFixed(1)}s (${stored ? `stored ${stored}` : 'not stored'})\n`);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
  context?.saveHashes();
  if (pending.length) write(`[node-coverage] ${pending.length - failed.length} measured, ${failed.length} failed in ${((Date.now() - started) / 1000).toFixed(1)}s\n`);
  if (failed.length) {
    write(`[node-coverage] failed files:\n${failed.map(file => `  ${slash(file)}`).join('\n')}\n`);
    return 1;
  }
  write(coverageTable(mergeLcov(tests.map(file => reports.get(file)))));
  return 0;
}

module.exports = {
  COVERAGE_EXCLUDE, NODE_FILES, buildNodeTestArgs, coverageFileArgs, discoverGateCoverageTests, discoverRootNodeTests, jobCount, main,
  runCoverage, runPlain,
  runTraced,
};

if (require.main === module) {
  Promise.resolve(main()).then(code => { process.exitCode = code; });
}
