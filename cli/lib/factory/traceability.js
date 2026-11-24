'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { resolveInside } = require('./paths');
const { stableDigest } = require('./stable-json');

const NODE_TYPES = Object.freeze(['intent', 'requirement', 'spec', 'adr', 'module', 'test', 'evidence', 'release']);
const EDGE_TYPES = Object.freeze({
  defines: [['intent', 'requirement']],
  'specified-by': [['requirement', 'spec']],
  'governed-by': [['requirement', 'adr'], ['spec', 'adr']],
  'implemented-by': [['requirement', 'module'], ['spec', 'module']],
  constrains: [['adr', 'module']],
  'verified-by': [['requirement', 'test'], ['module', 'test']],
  produces: [['test', 'evidence']],
  qualifies: [['evidence', 'release']],
  'depends-on': [['spec', 'spec'], ['adr', 'adr'], ['module', 'module'], ['test', 'test']],
});
const ID_PATTERN = /^[a-z][a-z0-9-]{1,62}$/;
const FORBIDDEN_KEYS = new Set(['__proto__', 'prototype', 'constructor']);

function problem(code, message, details = {}) {
  return { code, message, ...details };
}

function assertPlainObject(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} must be an object`);
}

function assertKeys(value, allowed, label) {
  for (const key of Object.keys(value)) {
    if (FORBIDDEN_KEYS.has(key)) throw new Error(`${label} contains forbidden key: ${key}`);
    if (!allowed.has(key)) throw new Error(`${label} contains unknown property: ${key}`);
  }
}

function validateShape(graph) {
  assertPlainObject(graph, 'artifact graph');
  assertKeys(graph, new Set(['$schema', 'schemaVersion', 'nodes', 'edges']), 'artifact graph');
  if (graph.schemaVersion !== '1.0.0') throw new Error('artifact graph schemaVersion must be 1.0.0');
  if (graph.$schema !== undefined && (typeof graph.$schema !== 'string' || graph.$schema.length === 0)) {
    throw new Error('artifact graph $schema must be a non-empty string');
  }
  if (!Array.isArray(graph.nodes) || graph.nodes.length === 0) throw new Error('artifact graph nodes must be a non-empty array');
  if (!Array.isArray(graph.edges)) throw new Error('artifact graph edges must be an array');

  const ids = new Set();
  for (const [index, node] of graph.nodes.entries()) {
    const label = `nodes[${index}]`;
    assertPlainObject(node, label);
    assertKeys(node, new Set(['id', 'type', 'path', 'title']), label);
    if (typeof node.id !== 'string' || !ID_PATTERN.test(node.id)) throw new Error(`${label}.id is invalid`);
    if (ids.has(node.id)) throw new Error(`duplicate node id: ${node.id}`);
    ids.add(node.id);
    if (!NODE_TYPES.includes(node.type)) throw new Error(`${label}.type is invalid`);
    if (typeof node.path !== 'string' || node.path.trim() === '') throw new Error(`${label}.path must be a non-empty relative path`);
    if (node.title !== undefined && (typeof node.title !== 'string' || node.title.trim() === '')) {
      throw new Error(`${label}.title must be a non-empty string`);
    }
  }

  const edgeKeys = new Set();
  for (const [index, edge] of graph.edges.entries()) {
    const label = `edges[${index}]`;
    assertPlainObject(edge, label);
    assertKeys(edge, new Set(['from', 'to', 'type']), label);
    if (typeof edge.from !== 'string' || !ID_PATTERN.test(edge.from)) throw new Error(`${label}.from is invalid`);
    if (typeof edge.to !== 'string' || !ID_PATTERN.test(edge.to)) throw new Error(`${label}.to is invalid`);
    if (!Object.hasOwn(EDGE_TYPES, edge.type)) throw new Error(`${label}.type is invalid`);
    if (edge.from === edge.to) throw new Error(`${label} cannot be a self-edge`);
    const key = `${edge.from}\0${edge.to}\0${edge.type}`;
    if (edgeKeys.has(key)) throw new Error(`duplicate edge: ${edge.from} -> ${edge.to} (${edge.type})`);
    edgeKeys.add(key);
  }
}

function validateArtifactGraph(graph, rootDir) {
  validateShape(graph);
  const root = path.resolve(rootDir);
  if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) throw new Error(`project root is not a directory: ${root}`);
  const byId = new Map(graph.nodes.map(node => [node.id, node]));
  for (const node of graph.nodes) {
    const absolute = resolveInside(root, node.path);
    if (!fs.existsSync(absolute)) throw new Error(`artifact path does not exist: ${node.path}`);
    if (!fs.statSync(absolute).isFile()) throw new Error(`artifact path is not a file: ${node.path}`);
  }
  for (const edge of graph.edges) {
    const source = byId.get(edge.from);
    const target = byId.get(edge.to);
    if (!source || !target) throw new Error(`dangling edge: ${edge.from} -> ${edge.to}`);
    const allowed = EDGE_TYPES[edge.type].some(([from, to]) => source.type === from && target.type === to);
    if (!allowed) throw new Error(`edge type ${edge.type} does not allow ${source.type} -> ${target.type}`);
  }
  return graph;
}

function reachable(start, adjacency, predicate) {
  const queue = [...(adjacency.get(start) || [])];
  const seen = new Set();
  while (queue.length > 0) {
    const id = queue.shift();
    if (seen.has(id)) continue;
    seen.add(id);
    if (predicate(id)) return true;
    queue.push(...(adjacency.get(id) || []));
  }
  return false;
}

function findCycle(ids, adjacency) {
  const visited = new Set();
  const active = new Set();
  const stack = [];
  function visit(id) {
    if (active.has(id)) return [...stack.slice(stack.indexOf(id)), id];
    if (visited.has(id)) return null;
    visited.add(id);
    active.add(id);
    stack.push(id);
    for (const next of adjacency.get(id) || []) {
      const cycle = visit(next);
      if (cycle) return cycle;
    }
    stack.pop();
    active.delete(id);
    return null;
  }
  for (const id of [...ids].sort()) {
    const cycle = visit(id);
    if (cycle) return cycle;
  }
  return null;
}

function analyzeArtifactGraph(graph, rootDir) {
  validateArtifactGraph(graph, rootDir);
  const nodes = [...graph.nodes].sort((a, b) => a.id.localeCompare(b.id));
  const byId = new Map(nodes.map(node => [node.id, node]));
  const outgoing = new Map(nodes.map(node => [node.id, []]));
  const incoming = new Map(nodes.map(node => [node.id, []]));
  for (const edge of graph.edges) {
    outgoing.get(edge.from).push(edge.to);
    incoming.get(edge.to).push(edge.from);
  }
  for (const list of [...outgoing.values(), ...incoming.values()]) list.sort();

  const gaps = [];
  for (const type of NODE_TYPES) {
    if (!nodes.some(node => node.type === type)) {
      gaps.push(problem('missing-node-type', `artifact graph has no ${type} node`, { nodeType: type }));
    }
  }
  const cycle = findCycle(byId.keys(), outgoing);
  if (cycle) gaps.push(problem('cycle', `artifact graph contains a cycle: ${cycle.join(' -> ')}`, { nodes: cycle }));

  const requirements = nodes.filter(node => node.type === 'requirement');
  const modules = nodes.filter(node => node.type === 'module');
  const tests = nodes.filter(node => node.type === 'test');
  const releases = nodes.filter(node => node.type === 'release');
  const hasType = type => id => byId.get(id).type === type;

  for (const node of requirements) {
    if (incoming.get(node.id).length === 0 || outgoing.get(node.id).length === 0) {
      gaps.push(problem('orphan-requirement', `requirement is not connected end-to-end: ${node.id}`, { nodeId: node.id }));
    }
    if (!reachable(node.id, outgoing, hasType('test'))) {
      gaps.push(problem('requirement-without-test', `requirement does not reach a test: ${node.id}`, { nodeId: node.id }));
    }
    if (!reachable(node.id, outgoing, hasType('evidence'))) {
      gaps.push(problem('requirement-without-evidence', `requirement does not reach evidence: ${node.id}`, { nodeId: node.id }));
    }
  }
  for (const node of modules) {
    if (incoming.get(node.id).length === 0 || !reachable(node.id, outgoing, hasType('test'))) {
      gaps.push(problem('orphan-module', `module has no upstream contract or downstream test: ${node.id}`, { nodeId: node.id }));
    }
  }
  for (const node of tests) {
    if (incoming.get(node.id).length === 0 || !reachable(node.id, outgoing, hasType('evidence'))) {
      gaps.push(problem('orphan-test', `test has no subject or downstream evidence: ${node.id}`, { nodeId: node.id }));
    }
  }
  for (const node of releases) {
    if (!reachable(node.id, incoming, hasType('requirement'))) {
      gaps.push(problem('release-without-requirement', `release does not trace back to a requirement: ${node.id}`, { nodeId: node.id }));
    }
  }

  gaps.sort((a, b) => `${a.code}\0${a.nodeId || ''}\0${a.message}`.localeCompare(`${b.code}\0${b.nodeId || ''}\0${b.message}`));
  const covered = requirements.filter(node =>
    reachable(node.id, outgoing, hasType('test')) && reachable(node.id, outgoing, hasType('evidence'))).length;
  const requirementCoverage = requirements.length === 0 ? 0 : Number(((covered / requirements.length) * 100).toFixed(2));
  const reportCore = {
    schemaVersion: '1.0.0',
    status: gaps.length === 0 ? 'pass' : 'fail',
    coverage: { requirements: { total: requirements.length, covered, percent: requirementCoverage } },
    counts: Object.fromEntries(NODE_TYPES.map(type => [type, nodes.filter(node => node.type === type).length])),
    gaps,
  };
  return { ...reportCore, digest: stableDigest(reportCore) };
}

function loadArtifactGraph(rootDir, relativePath = 'factory/artifacts.json') {
  const filename = resolveInside(rootDir, relativePath);
  const graph = JSON.parse(fs.readFileSync(filename, 'utf8'));
  validateArtifactGraph(graph, rootDir);
  return graph;
}

module.exports = { NODE_TYPES, EDGE_TYPES, validateArtifactGraph, analyzeArtifactGraph, loadArtifactGraph };
