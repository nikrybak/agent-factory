const { test } = require('node:test');
const assert = require('node:assert/strict');
const { validateEvalSuite, evaluateAssertions } = require('../lib/factory/evals');

const suite = {
  schemaVersion: '1.0.0', threshold: 100,
  cases: [
    { id: 'trace-pass', path: 'trace.status', operator: 'equals', expected: 'PASS' },
    { id: 'coverage', path: 'trace.coverage', operator: 'gte', expected: 100 },
    { id: 'role', path: 'roles', operator: 'includes', expected: 'qa-lead' },
  ],
};

test('eval suite validates and scores deterministic golden assertions', () => {
  assert.deepEqual(validateEvalSuite(suite), []);
  const report = evaluateAssertions(suite, { trace: { status: 'PASS', coverage: 100 }, roles: ['qa-lead'] });
  assert.equal(report.status, 'PASS');
  assert.equal(report.score, 100);
  assert.deepEqual(report.results.map(item => item.id), ['coverage', 'role', 'trace-pass']);
});

test('eval suite fails closed for invalid operators, missing facts and threshold misses', () => {
  assert.ok(validateEvalSuite({ ...suite, cases: [{ id: 'bad', path: '__proto__.x', operator: 'magic', expected: true }] }).length >= 2);
  const report = evaluateAssertions(suite, { trace: { status: 'FAIL', coverage: 99 }, roles: [] });
  assert.equal(report.status, 'FAIL');
  assert.equal(report.score, 0);
  assert.equal(report.results.every(item => item.pass === false), true);
});
