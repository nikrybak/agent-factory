'use strict';

function validateWorkflow(plan) {
  if (!plan || !Array.isArray(plan.steps) || plan.steps.length === 0) {
    throw new Error('workflow requires a non-empty steps array');
  }
  const ids = new Set();
  for (const step of plan.steps) {
    if (!step || typeof step.id !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(step.id)) {
      throw new Error('workflow step has an invalid id');
    }
    if (ids.has(step.id)) throw new Error(`duplicate workflow step: ${step.id}`);
    ids.add(step.id);
  }
  for (const step of plan.steps) {
    for (const dependency of (step.needs || [])) {
      if (!ids.has(dependency)) throw new Error(`unknown dependency ${dependency} for ${step.id}`);
      if (dependency === step.id) throw new Error(`workflow cycle at ${step.id}`);
    }
  }
  const visiting = new Set();
  const visited = new Set();
  const byId = new Map(plan.steps.map(step => [step.id, step]));
  function visit(id) {
    if (visiting.has(id)) throw new Error(`workflow cycle at ${id}`);
    if (visited.has(id)) return;
    visiting.add(id);
    for (const dependency of (byId.get(id).needs || [])) visit(dependency);
    visiting.delete(id);
    visited.add(id);
  }
  for (const id of ids) visit(id);
  return true;
}

function latestEvidence(evidence) {
  const latest = new Map();
  for (const item of (evidence || [])) {
    const previous = latest.get(item.stepId);
    const currentAttempt = Number.isSafeInteger(item.attempt) ? item.attempt : 0;
    const previousAttempt = previous && Number.isSafeInteger(previous.attempt) ? previous.attempt : 0;
    if (!previous || currentAttempt >= previousAttempt) latest.set(item.stepId, item);
  }
  return latest;
}

function evaluateWorkflow(plan, evidence = [], checkpoint = null, now = new Date()) {
  validateWorkflow(plan);
  const latest = latestEvidence(evidence);
  const states = {};
  const active = checkpoint && checkpoint.running;
  const activeLease = active && Date.parse(active.leaseExpiresAt);

  for (const step of plan.steps) {
    const item = latest.get(step.id);
    if (step.applicable === false && step.naReason && !item) states[step.id] = { state: 'PENDING', plannedNa: true, reason: step.naReason };
    else if (item && item.fresh === false) states[step.id] = { state: 'STALE', evidence: item };
    else if (item && item.status === 'PASS') states[step.id] = { state: 'PASS', evidence: item };
    else if (item && item.status === 'FAIL') states[step.id] = { state: 'FAIL', evidence: item };
    else if (item && item.status === 'NA') {
      const validNa = step.applicable === false && item.reason && (!step.naReason || item.reason === step.naReason);
      states[step.id] = validNa ? { state: 'PENDING', plannedNa: true, evidence: item } : { state: 'FAIL', evidence: item, reason: 'invalid N/A' };
    } else if (active && active.stepId === step.id) {
      states[step.id] = { state: activeLease > now.getTime() ? 'RUNNING' : 'INTERRUPTED' };
    } else states[step.id] = { state: 'PENDING' };
  }

  const satisfied = state => state === 'PASS' || state === 'NA';
  let changed = true;
  while (changed) {
    changed = false;
    for (const step of plan.steps) {
      if (!['PENDING', 'STALE', 'INTERRUPTED'].includes(states[step.id].state)) continue;
      const dependencies = (step.needs || []).map(id => states[id].state);
      if (dependencies.every(satisfied)) {
        if (states[step.id].state === 'PENDING') states[step.id].state = states[step.id].plannedNa ? 'NA' : 'READY';
      } else if (states[step.id].state === 'PENDING') {
        states[step.id].state = 'BLOCKED';
        changed = true;
      }
    }
  }

  const ready = plan.steps
    .filter(step => ['READY', 'STALE', 'INTERRUPTED'].includes(states[step.id].state))
    .filter(step => (step.needs || []).every(id => satisfied(states[id].state)))
    .map(step => step.id);
  const values = Object.values(states).map(value => value.state);
  let runState = 'BLOCKED';
  if (values.every(satisfied)) runState = 'COMPLETE';
  else if (values.includes('RUNNING')) runState = 'RUNNING';
  else if (values.includes('FAIL')) runState = 'FAILED';
  else if (ready.length) runState = 'READY';
  return { runState, ready, steps: states };
}

module.exports = { evaluateWorkflow, validateWorkflow };
