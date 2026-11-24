const { test } = require('node:test');
const assert = require('node:assert/strict');
const { buildControlReport } = require('../lib/factory/control');

test('control tower is complete only when every mandatory district passes', () => {
  const report = buildControlReport({ trace: { status: 'PASS' }, workforce: { status: 'PASS' }, trust: { status: 'PASS' } }, { total: 3, failed: 0 });
  assert.equal(report.status, 'COMPLETE');
  assert.deepEqual(report.blocking, []);
  assert.equal(report.health.districtsPassing, 3);
});

test('control tower returns exhaustive sorted blockers', () => {
  const report = buildControlReport({ trust: { status: 'FAIL', gaps: [{ code: 'denied' }] }, trace: null }, { total: 1, failed: 1 });
  assert.equal(report.status, 'FAIL');
  assert.deepEqual(report.blocking.map(item => item.district), ['trace', 'trust']);
});
