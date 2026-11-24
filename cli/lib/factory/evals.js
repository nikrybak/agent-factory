'use strict';

const FORBIDDEN = new Set(['__proto__', 'prototype', 'constructor']);
const OPERATORS = new Set(['equals', 'gte', 'includes']);

function validateEvalSuite(suite) {
  const issues = [];
  if (!suite || typeof suite !== 'object' || Array.isArray(suite)) return ['suite must be an object'];
  if (suite.schemaVersion !== '1.0.0') issues.push('unsupported schemaVersion');
  if (typeof suite.threshold !== 'number' || suite.threshold < 0 || suite.threshold > 100) issues.push('threshold must be 0..100');
  if (!Array.isArray(suite.cases) || !suite.cases.length) issues.push('cases must be a non-empty array');
  const ids = new Set();
  for (const item of suite.cases || []) {
    if (!item || typeof item !== 'object') { issues.push('case must be an object'); continue; }
    if (!/^[a-z][a-z0-9-]{1,62}$/.test(item.id || '')) issues.push(`invalid case id: ${String(item.id)}`);
    else if (ids.has(item.id)) issues.push(`duplicate case id: ${item.id}`);
    ids.add(item.id);
    const parts = typeof item.path === 'string' ? item.path.split('.') : [];
    if (!parts.length || parts.some(part => !part || FORBIDDEN.has(part))) issues.push(`unsafe case path: ${String(item.path)}`);
    if (!OPERATORS.has(item.operator)) issues.push(`unsupported operator: ${String(item.operator)}`);
  }
  return issues.sort();
}

function readPath(facts, dotted) {
  let value = facts;
  for (const part of dotted.split('.')) {
    if (FORBIDDEN.has(part) || value === null || typeof value !== 'object' || !Object.hasOwn(value, part)) return undefined;
    value = value[part];
  }
  return value;
}

function compare(actual, operator, expected) {
  if (operator === 'equals') return actual === expected;
  if (operator === 'gte') return typeof actual === 'number' && actual >= expected;
  if (operator === 'includes') return (Array.isArray(actual) || typeof actual === 'string') && actual.includes(expected);
  return false;
}

function evaluateAssertions(suite, facts) {
  const issues = validateEvalSuite(suite);
  if (issues.length) throw new Error(`invalid eval suite: ${issues.join('; ')}`);
  const results = suite.cases.map(item => {
    const actual = readPath(facts, item.path);
    return { id: item.id, pass: compare(actual, item.operator, item.expected), actual, expected: item.expected, operator: item.operator };
  }).sort((a, b) => a.id.localeCompare(b.id));
  const passed = results.filter(item => item.pass).length;
  const score = Number(((passed / results.length) * 100).toFixed(2));
  return { schemaVersion: '1.0.0', status: score >= suite.threshold ? 'PASS' : 'FAIL', score, threshold: suite.threshold, results };
}

module.exports = { evaluateAssertions, readPath, validateEvalSuite };
