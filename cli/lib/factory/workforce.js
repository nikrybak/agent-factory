'use strict';

const ID = /^[a-z][a-z0-9-]*$/;
const REQUIRED_ARRAYS = ['capabilities', 'requiredContext', 'deliverables', 'handoff', 'evidence'];

function unique(values) { return [...new Set(values)].sort(); }
function assertStringArray(value, field, allowEmpty = false) {
  if (!Array.isArray(value) || (!allowEmpty && value.length === 0) || value.some(item => typeof item !== 'string' || !item.trim())) {
    throw new Error(`role ${field} must be ${allowEmpty ? 'an' : 'a non-empty'} string array`);
  }
}

function validateRoleCatalog(catalog) {
  if (!catalog || catalog.schemaVersion !== '1.0.0' || !Array.isArray(catalog.roles) || catalog.roles.length < 24) {
    throw new Error('role catalog requires schemaVersion 1.0.0 and at least 24 roles');
  }
  const ids = new Set();
  for (const role of catalog.roles) {
    if (!role || !ID.test(role.id || '') || ids.has(role.id)) throw new Error(`invalid or duplicate role id: ${role && role.id}`);
    ids.add(role.id);
    if (typeof role.label !== 'string' || !role.label.trim()) throw new Error(`role ${role.id} requires label`);
    for (const field of REQUIRED_ARRAYS) assertStringArray(role[field], field);
    if (!role.authority || typeof role.authority !== 'object' || Array.isArray(role.authority)) throw new Error(`role ${role.id} requires authority`);
    assertStringArray(role.authority.actions, 'authority.actions');
    assertStringArray(role.conflictsWith || [], 'conflictsWith', true);
  }
  for (const role of catalog.roles) {
    for (const conflict of role.conflictsWith || []) if (!ids.has(conflict)) throw new Error(`role ${role.id} conflicts with unknown role ${conflict}`);
  }
  return true;
}

const STEP_ROLE = Object.freeze({
  intake: 'product-owner', plan: 'project-manager', architecture: 'solution-architect', implementation: 'backend-engineer',
  'test-contract': 'qa-lead', tests: 'unit-test-engineer', 'browser-e2e': 'e2e-test-engineer',
  'api-contract': 'api-engineer', security: 'security-engineer', docs: 'documentation-engineer',
  quality: 'test-coverage-auditor', 'release-checkpoint': 'devops-release-engineer',
  traceability: 'documentation-engineer', workforce: 'it-orchestrator', adapters: 'integration-engineer',
  trust: 'security-engineer', 'supply-chain': 'security-engineer', evals: 'qa-lead',
  observability: 'observability-engineer', 'city-certification': 'it-orchestrator',
});
const CAPABILITY_ROLE = Object.freeze({
  browser: 'frontend-engineer', api: 'api-engineer', database: 'database-engineer', infrastructure: 'platform-engineer',
  automation: 'devops-release-engineer', 'command-line': 'backend-engineer', mobile: 'mobile-engineer',
  observability: 'observability-engineer', performance: 'performance-engineer', accessibility: 'ux-ui-lead',
  integration: 'integration-engineer', data: 'data-engineer', machine_learning: 'ml-engineer',
});

function routeWorkforce({ catalog, plan, detection = {} }) {
  validateRoleCatalog(catalog);
  if (!plan || !Array.isArray(plan.steps)) throw new Error('workforce routing requires plan.steps');
  const byId = new Map(catalog.roles.map(role => [role.id, role]));
  const requested = new Set(['it-orchestrator']);
  const gaps = [];
  for (const step of plan.steps) {
    if (step.applicable === false) continue;
    const roleId = STEP_ROLE[step.id] || (step.gate && STEP_ROLE[step.gate]);
    if (roleId) requested.add(roleId);
    else gaps.push({ code: 'unrouted-step', subject: step.id, message: `No workforce route for step: ${step.id}` });
  }
  const capabilities = unique([...(detection.capabilities || []), ...(detection.components || []).flatMap(item => item.capabilities || [])]);
  for (const capability of capabilities) if (CAPABILITY_ROLE[capability]) requested.add(CAPABILITY_ROLE[capability]);
  for (const id of requested) if (!byId.has(id)) gaps.push({ code: 'missing-role', subject: id, message: `Required role is absent: ${id}` });
  const selected = [...requested].filter(id => byId.has(id)).sort().map(id => byId.get(id));
  const selectedIds = new Set(selected.map(role => role.id));
  const conflicts = []; const conflictKeys = new Set();
  for (const role of selected) {
    for (const other of role.conflictsWith || []) {
      if (!selectedIds.has(other)) continue;
      const roles = [role.id, other].sort(); const key = roles.join(':');
      if (!conflictKeys.has(key)) {
        conflictKeys.add(key);
        conflicts.push({ code: 'separation-of-duty', roles, message: `${roles[0]} conflicts with ${roles[1]}` });
      }
    }
  }
  conflicts.sort((a, b) => a.roles.join(':').localeCompare(b.roles.join(':')));
  return { status: gaps.length || conflicts.length ? 'blocked' : 'ready', roles: selected, capabilities, gaps, conflicts };
}

module.exports = { validateRoleCatalog, routeWorkforce, STEP_ROLE, CAPABILITY_ROLE };
