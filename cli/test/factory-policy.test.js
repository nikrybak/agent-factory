const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { loadCatalogs, composeProfiles, evaluatePolicy } = require('../lib/factory/policy');

const catalogs = loadCatalogs(path.join(__dirname, '..', '..'));

test('profile composition unions gates and capabilities without weakening strictness', () => {
  const composed = composeProfiles(['web', 'api'], catalogs.profiles);
  assert.ok(composed.requiredGates.includes('browser-e2e'));
  assert.ok(composed.requiredGates.includes('api-contract'));
  assert.ok(composed.capabilities.includes('browser'));
  assert.equal(composed.minimumRisk, 'medium');
});

test('policy uses maximum declared, profile and derived risk and always requires security', () => {
  const result = evaluatePolicy({
    manifest: { profiles: ['web'], risk: { class: 'low', dataSensitivity: 'restricted', internetExposure: true, regulated: false }, capabilities: { required: [], optional: [] }, quality: { requiredGates: [], additionalChecks: [] }, authority: {} },
    detection: { components: [{ family: 'node' }], gaps: [] },
    catalogs,
  });
  assert.equal(result.effectiveRisk, 'critical');
  assert.ok(result.requiredGates.includes('security'));
  assert.ok(result.requiredGates.includes('architecture'));
  assert.ok(result.requiredGates.includes('browser-e2e'));
});

test('medium and higher effective risk cannot bypass architecture review', () => {
  for (const risk of ['medium', 'high', 'critical']) {
    const result = evaluatePolicy({
      manifest: { profiles: ['cli'], risk: { class: risk, dataSensitivity: 'public', internetExposure: false, regulated: false }, capabilities: { required: [], optional: [] }, quality: { requiredGates: [], additionalChecks: [] }, authority: {} },
      detection: { components: [{ family: 'node', capabilities: ['command-line'] }], gaps: [] },
      catalogs,
    });
    assert.ok(result.requiredGates.includes('architecture'), `${risk} risk must require architecture`);
  }
});

test('unknown profiles and unavailable required capabilities fail closed', () => {
  const result = evaluatePolicy({
    manifest: { profiles: ['telepathy'], risk: { class: 'low', dataSensitivity: 'public', internetExposure: false, regulated: false }, capabilities: { required: ['quantum-runtime'], optional: [] }, quality: { requiredGates: [], additionalChecks: [] }, authority: {} },
    detection: { components: [], gaps: [{ code: 'unknown-stack' }] },
    catalogs,
  });
  assert.equal(result.status, 'blocked');
  assert.ok(result.gaps.some(g => g.code === 'unknown-profile'));
  assert.ok(result.gaps.some(g => g.code === 'missing-capability'));
});

test('known detected families and frameworks satisfy required capabilities', () => {
  const result = evaluatePolicy({
    manifest: { profiles: [], risk: { class: 'low', dataSensitivity: 'public', internetExposure: false, regulated: false }, capabilities: { required: ['node', 'react'], optional: [] }, quality: { requiredGates: ['custom-gate'], additionalChecks: [] }, authority: {} },
    detection: { components: [{ family: 'node', frameworks: ['react'] }], gaps: [] },
    catalogs,
  });
  assert.equal(result.status, 'ready');
  assert.ok(result.requiredGates.includes('custom-gate'));
});
