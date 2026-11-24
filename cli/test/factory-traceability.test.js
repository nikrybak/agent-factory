'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  validateArtifactGraph,
  analyzeArtifactGraph,
  loadArtifactGraph,
} = require('../lib/factory/traceability');

const TYPES = ['intent', 'requirement', 'spec', 'adr', 'module', 'test', 'evidence', 'release'];

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'factory-trace-'));
  const nodes = TYPES.map(type => {
    const relative = `${type}.txt`;
    fs.writeFileSync(path.join(root, relative), type);
    return { id: `${type}-node`, type, path: relative };
  });
  const edges = [
    { from: 'intent-node', to: 'requirement-node', type: 'defines' },
    { from: 'requirement-node', to: 'spec-node', type: 'specified-by' },
    { from: 'requirement-node', to: 'adr-node', type: 'governed-by' },
    { from: 'spec-node', to: 'module-node', type: 'implemented-by' },
    { from: 'adr-node', to: 'module-node', type: 'constrains' },
    { from: 'module-node', to: 'test-node', type: 'verified-by' },
    { from: 'test-node', to: 'evidence-node', type: 'produces' },
    { from: 'evidence-node', to: 'release-node', type: 'qualifies' },
  ];
  return { root, graph: { schemaVersion: '1.0.0', nodes, edges } };
}

test('complete graph validates and produces deterministic full-coverage report', t => {
  const { root, graph } = fixture();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  assert.equal(validateArtifactGraph(graph, root), graph);
  const report = analyzeArtifactGraph(graph, root);
  assert.equal(report.status, 'pass');
  assert.deepEqual(report.coverage.requirements, { total: 1, covered: 1, percent: 100 });
  assert.deepEqual(report.gaps, []);
  assert.equal(report.digest, analyzeArtifactGraph(structuredClone(graph), root).digest);
});

test('loads a graph only from a root-bounded file', t => {
  const { root, graph } = fixture();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, 'factory'));
  fs.writeFileSync(path.join(root, 'factory', 'artifacts.json'), JSON.stringify(graph));
  assert.equal(loadArtifactGraph(root).nodes.length, TYPES.length);
  assert.throws(() => loadArtifactGraph(root, '../artifacts.json'), /outside project root/);
});

test('rejects unknown properties, duplicate IDs, malformed edge types and dangling edges', t => {
  const { root, graph } = fixture();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  assert.throws(() => validateArtifactGraph({ ...graph, surprise: true }, root), /unknown property/);
  const duplicate = structuredClone(graph);
  duplicate.nodes[1].id = duplicate.nodes[0].id;
  assert.throws(() => validateArtifactGraph(duplicate, root), /duplicate node id/);
  const invalidType = structuredClone(graph);
  invalidType.edges[0].type = 'magic';
  assert.throws(() => validateArtifactGraph(invalidType, root), /type is invalid/);
  const dangling = structuredClone(graph);
  dangling.edges[0].to = 'missing-node';
  assert.throws(() => validateArtifactGraph(dangling, root), /dangling edge/);
  assert.throws(() => validateArtifactGraph({ ...graph, $schema: '' }, root), /non-empty string/);
  const badTitle = structuredClone(graph);
  badTitle.nodes[0].title = '';
  assert.throws(() => validateArtifactGraph(badTitle, root), /title must be a non-empty string/);
  const selfEdge = structuredClone(graph);
  selfEdge.edges[0].to = selfEdge.edges[0].from;
  assert.throws(() => validateArtifactGraph(selfEdge, root), /self-edge/);
  const wrongTransition = structuredClone(graph);
  wrongTransition.edges[0] = { from: 'intent-node', to: 'module-node', type: 'defines' };
  assert.throws(() => validateArtifactGraph(wrongTransition, root), /does not allow intent -> module/);
  assert.throws(() => validateArtifactGraph(graph, path.join(root, 'absent')), /project root is not a directory/);
});

test('rejects traversal, missing artifacts, directories, and symlink escape', t => {
  const { root, graph } = fixture();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const traversal = structuredClone(graph);
  traversal.nodes[0].path = '../outside.txt';
  assert.throws(() => validateArtifactGraph(traversal, root), /outside project root/);
  const missing = structuredClone(graph);
  missing.nodes[0].path = 'missing.txt';
  assert.throws(() => validateArtifactGraph(missing, root), /does not exist/);
  fs.mkdirSync(path.join(root, 'directory'));
  const directory = structuredClone(graph);
  directory.nodes[0].path = 'directory';
  assert.throws(() => validateArtifactGraph(directory, root), /not a file/);

  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'factory-trace-outside-'));
  t.after(() => fs.rmSync(outside, { recursive: true, force: true }));
  fs.writeFileSync(path.join(outside, 'secret.txt'), 'secret');
  const link = path.join(root, 'external-link');
  try {
    fs.symlinkSync(outside, link, process.platform === 'win32' ? 'junction' : 'dir');
  } catch (error) {
    if (error.code === 'EPERM' || error.code === 'EACCES') return;
    throw error;
  }
  const symlink = structuredClone(graph);
  symlink.nodes[0].path = 'external-link/secret.txt';
  assert.throws(() => validateArtifactGraph(symlink, root), /symlink|outside project root/);
});

test('reports orphan requirements, modules, tests and incomplete release provenance', t => {
  const { root, graph } = fixture();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  graph.edges = [];
  const report = analyzeArtifactGraph(graph, root);
  assert.equal(report.status, 'fail');
  assert.equal(report.coverage.requirements.percent, 0);
  assert.ok(report.gaps.some(gap => gap.code === 'orphan-requirement'));
  assert.ok(report.gaps.some(gap => gap.code === 'orphan-module'));
  assert.ok(report.gaps.some(gap => gap.code === 'orphan-test'));
  assert.ok(report.gaps.some(gap => gap.code === 'requirement-without-test'));
  assert.ok(report.gaps.some(gap => gap.code === 'requirement-without-evidence'));
  assert.ok(report.gaps.some(gap => gap.code === 'release-without-requirement'));
});

test('detects cycles in dependency relations where cycles are disallowed', t => {
  const { root, graph } = fixture();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(path.join(root, 'second-module.txt'), 'module');
  graph.nodes.push({ id: 'second-module', type: 'module', path: 'second-module.txt' });
  graph.edges.push(
    { from: 'module-node', to: 'second-module', type: 'depends-on' },
    { from: 'second-module', to: 'module-node', type: 'depends-on' },
  );
  const report = analyzeArtifactGraph(graph, root);
  assert.equal(report.status, 'fail');
  assert.ok(report.gaps.some(gap => gap.code === 'cycle'));
});

test('reports required artifact types missing from the graph', t => {
  const { root, graph } = fixture();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  graph.nodes = graph.nodes.filter(node => node.type !== 'release');
  graph.edges = graph.edges.filter(edge => edge.to !== 'release-node');
  const report = analyzeArtifactGraph(graph, root);
  assert.equal(report.status, 'fail');
  assert.ok(report.gaps.some(gap => gap.code === 'missing-node-type' && gap.nodeType === 'release'));
});

test('repository artifact graph is complete and root-bounded', { skip: 'needs the full private monorepo (child registry, skill canon)' }, () => {
  const root = path.join(__dirname, '..', '..');
  const graph = loadArtifactGraph(root);
  assert.equal(analyzeArtifactGraph(graph, root).status, 'pass');
});
