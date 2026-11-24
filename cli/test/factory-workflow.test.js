const { test } = require('node:test');
const assert = require('node:assert/strict');

const { evaluateWorkflow, validateWorkflow } = require('../lib/factory/workflow');

const plan = {
  steps: [
    { id: 'plan', needs: [] },
    { id: 'tests', needs: ['plan'] },
    { id: 'browser', needs: ['tests'], applicable: false, naReason: 'no-browser-capability' },
    { id: 'quality', needs: ['tests', 'browser'] },
  ],
};

test('validateWorkflow rejects duplicate, missing dependencies and cycles', () => {
  assert.throws(() => validateWorkflow({ steps: [] }), /non-empty/);
  assert.throws(() => validateWorkflow({ steps: [{ id: '../bad' }] }), /invalid id/);
  assert.throws(() => validateWorkflow({ steps: [{ id: 'x' }, { id: 'x' }] }), /duplicate/);
  assert.throws(() => validateWorkflow({ steps: [{ id: 'x', needs: ['missing'] }] }), /unknown dependency/);
  assert.throws(
    () => validateWorkflow({ steps: [{ id: 'x', needs: ['y'] }, { id: 'y', needs: ['x'] }] }),
    /cycle/
  );
});

test('DAG exposes only dependency-ready work and blocks downstream on FAIL', () => {
  let state = evaluateWorkflow(plan, []);
  assert.deepEqual(state.ready, ['plan']);
  state = evaluateWorkflow(plan, [{ stepId: 'plan', status: 'PASS', fresh: true }]);
  assert.deepEqual(state.ready, ['tests']);
  state = evaluateWorkflow(plan, [
    { stepId: 'plan', status: 'PASS', fresh: true },
    { stepId: 'tests', status: 'FAIL', fresh: true },
  ]);
  assert.equal(state.steps.tests.state, 'FAIL');
  assert.equal(state.steps.browser.state, 'BLOCKED');
  assert.equal(state.runState, 'FAILED');
});

test('stale evidence becomes resumable and justified N/A satisfies a dependency', () => {
  let state = evaluateWorkflow(plan, [
    { stepId: 'plan', status: 'PASS', fresh: true },
    { stepId: 'tests', status: 'PASS', fresh: false },
  ]);
  assert.equal(state.steps.tests.state, 'STALE');
  assert.deepEqual(state.ready, ['tests']);

  state = evaluateWorkflow(plan, [
    { stepId: 'plan', status: 'PASS', fresh: true },
    { stepId: 'tests', status: 'PASS', fresh: true },
    { stepId: 'browser', status: 'NA', reason: 'no-browser-capability', fresh: true },
  ]);
  assert.deepEqual(state.ready, ['quality']);
  assert.equal(state.steps.browser.state, 'NA');
});

test('interrupted RUNNING checkpoint is returned to ready on resume', () => {
  const state = evaluateWorkflow(plan, [], {
    running: { stepId: 'plan', leaseExpiresAt: '2020-01-01T00:00:00.000Z' },
  }, new Date('2026-01-01T00:00:00.000Z'));
  assert.equal(state.steps.plan.state, 'INTERRUPTED');
  assert.deepEqual(state.ready, ['plan']);
});
