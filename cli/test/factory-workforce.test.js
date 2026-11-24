'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const catalog = require('../../factory/catalog/roles.json');
const { validateRoleCatalog, routeWorkforce } = require('../lib/factory/workforce');

function clone(value) { return JSON.parse(JSON.stringify(value)); }

test('validates a complete neutral workforce catalog with at least 24 typed roles', () => {
  assert.equal(validateRoleCatalog(catalog), true);
  assert.ok(catalog.roles.length >= 24);
  for (const role of catalog.roles) {
    for (const field of ['capabilities', 'requiredContext', 'deliverables', 'handoff', 'evidence']) assert.ok(role[field].length, `${role.id}.${field}`);
    assert.ok(role.authority.actions.length);
  }
});

test('role validation fails closed for duplicate ids, incomplete contracts and dangling conflicts', () => {
  const duplicate = clone(catalog); duplicate.roles[1].id = duplicate.roles[0].id;
  assert.throws(() => validateRoleCatalog(duplicate), /duplicate role id/);
  const incomplete = clone(catalog); delete incomplete.roles[0].evidence;
  assert.throws(() => validateRoleCatalog(incomplete), /evidence/);
  const dangling = clone(catalog); dangling.roles[0].conflictsWith = ['missing-role'];
  assert.throws(() => validateRoleCatalog(dangling), /unknown role/);
});

test('routes the deterministic minimal workforce from applicable plan steps and capabilities', () => {
  const plan = { steps: [
    { id: 'intake' }, { id: 'plan' }, { id: 'architecture' }, { id: 'implementation' },
    { id: 'tests' }, { id: 'browser-e2e', applicable: true }, { id: 'api-contract', applicable: false },
    { id: 'security' }, { id: 'docs' }, { id: 'quality' }, { id: 'release-checkpoint' },
  ] };
  const first = routeWorkforce({ catalog, plan, detection: { capabilities: ['browser'] } });
  const second = routeWorkforce({ catalog, plan, detection: { capabilities: ['browser'] } });
  assert.deepEqual(first, second);
  assert.equal(first.status, 'ready');
  const ids = first.roles.map(role => role.id);
  assert.ok(ids.includes('it-orchestrator'));
  assert.ok(ids.includes('frontend-engineer'));
  assert.ok(ids.includes('e2e-test-engineer'));
  assert.ok(!ids.includes('api-engineer'));
  assert.equal(ids.length, new Set(ids).size);
});

test('unknown workflow steps and separation-of-duty conflicts block routing', () => {
  const unknown = routeWorkforce({ catalog, plan: { steps: [{ id: 'unmapped-gate' }] }, detection: {} });
  assert.equal(unknown.status, 'blocked');
  assert.equal(unknown.gaps[0].code, 'unrouted-step');

  const conflicting = clone(catalog);
  const release = conflicting.roles.find(role => role.id === 'devops-release-engineer');
  release.conflictsWith.push('backend-engineer');
  const routed = routeWorkforce({ catalog: conflicting, plan: { steps: [{ id: 'implementation' }, { id: 'release-checkpoint' }] }, detection: {} });
  assert.equal(routed.status, 'blocked');
  assert.equal(routed.conflicts[0].code, 'separation-of-duty');
});
