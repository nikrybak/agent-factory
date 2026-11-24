'use strict';
/** @implements REQ-FK-011 Exact component roots, module ownership, and fail-closed detection gaps. */
const fs = require('node:fs');
const path = require('node:path');
const { loadCatalog } = require('./catalog-loader');
const { normalizeRelativeRoot, walkFiles } = require('./paths');
const { isCityFabricBase, isGeneratedSkillMirrorPath, isLocalChildPath, isLocalWorkspacePath } = require('./hash');
const {
  findUnityProjectRoots,
  isUnityGeneratedPath,
  unityRootForMarker,
} = require('./unity');

const INFRA_ROOT = path.resolve(__dirname, '../../..');
const ID = /^[a-z][a-z0-9-]*$/;
const MARKER_ROLES = new Set(['component', 'build-root', 'module']);

function readCatalog() { return loadCatalog(INFRA_ROOT, 'factory/catalog/stack-signals.json'); }
function validateStackSignalCatalog(catalog) {
  if (!catalog || !['1.0.0', '1.1.0'].includes(catalog.schemaVersion)
    || !Array.isArray(catalog.signals) || !catalog.signals.length) {
    throw new Error('stack-signal catalog requires supported schemaVersion and signals');
  }
  for (const signal of catalog.signals) {
    if (!signal || !ID.test(signal.family || '')) throw new Error('stack signal family is invalid');
    const files = signal.files;
    const extensions = signal.extensions;
    const validStrings = values => Array.isArray(values) && values.length
      && values.every(value => typeof value === 'string' && value.length && !/[\/\\\r\n\0]/.test(value))
      && new Set(values).size === values.length;
    if (!validStrings(files) && !validStrings(extensions)) throw new Error(`stack signal ${signal.family} requires files or extensions`);
    if (files !== undefined && !validStrings(files)) throw new Error(`stack signal ${signal.family} files are invalid`);
    if (extensions !== undefined && (!validStrings(extensions) || extensions.some(value => !value.startsWith('.')))) {
      throw new Error(`stack signal ${signal.family} extensions are invalid`);
    }
    if (typeof signal.confidence !== 'number' || signal.confidence <= 0 || signal.confidence > 1) {
      throw new Error(`stack signal ${signal.family} confidence is invalid`);
    }
    for (const field of ['capabilities', 'ownsModuleFamilies']) {
      if (signal[field] !== undefined && (!Array.isArray(signal[field])
        || signal[field].some(value => !ID.test(value)) || new Set(signal[field]).size !== signal[field].length)) {
        throw new Error(`stack signal ${signal.family} ${field} is invalid`);
      }
    }
    if (signal.markerRole !== undefined && !MARKER_ROLES.has(signal.markerRole)) {
      throw new Error(`stack signal ${signal.family} markerRole is invalid`);
    }
    if (catalog.schemaVersion === '1.0.0'
      && (signal.markerRole !== undefined || signal.ownsModuleFamilies !== undefined)) {
      throw new Error('stack-signal 1.0.0 cannot declare marker ownership');
    }
    if ((signal.markerRole || 'component') === 'module' && signal.ownsModuleFamilies !== undefined) {
      throw new Error(`module stack signal ${signal.family} cannot own module families`);
    }
  }
  return true;
}
function dependencyNames(packageJson) {
  try {
    const pkg = JSON.parse(fs.readFileSync(packageJson, 'utf8'));
    return new Set(Object.keys({ ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}), ...(pkg.peerDependencies || {}) }));
  } catch { return new Set(); }
}
function frameworksFor(family, root, evidence, projectRoot) {
  if (family !== 'node' || !evidence.some(e => e.path.endsWith('package.json'))) return [];
  const names = dependencyNames(path.join(projectRoot, root === '.' ? '' : root, 'package.json'));
  return ['angular', 'astro', 'express', 'fastify', 'next', 'nuxt', 'react', 'svelte', 'vue'].filter(name => names.has(name) || names.has(`@${name}/core`));
}
function nodeCapabilities(root, projectRoot, frameworks) {
  try {
    const file = path.join(projectRoot, root === '.' ? '' : root, 'package.json');
    const pkg = JSON.parse(fs.readFileSync(file, 'utf8'));
    const capabilities = [];
    if (pkg.bin) capabilities.push('command-line');
    if (frameworks.some(name => ['angular', 'astro', 'next', 'nuxt', 'react', 'svelte', 'vue'].includes(name))) capabilities.push('browser');
    if (frameworks.some(name => ['express', 'fastify'].includes(name))) capabilities.push('api');
    return capabilities;
  } catch { return []; }
}

function isAtOrBelow(relative, ownerRoot) {
  return ownerRoot === '.' || relative === ownerRoot || relative.startsWith(`${ownerRoot}/`);
}

function normalizedRoot(value) {
  return normalizeRelativeRoot(value);
}

function generatedId(family, root) {
  return `${family}-${root === '.' ? 'root' : root.replace(/[^a-z0-9]+/gi, '-')}`;
}

function applyDeclarations(components, declarations = []) {
  const byIdentity = new Map();
  for (const declaration of declarations) {
    if (!declaration || typeof declaration.family !== 'string') continue;
    const key = `${declaration.family}:${normalizedRoot(declaration.root)}`;
    if (!byIdentity.has(key)) byIdentity.set(key, declaration);
  }
  return components.map(component => {
    const declaration = byIdentity.get(`${component.family}:${component.root}`);
    if (!declaration) return component;
    return {
      ...component,
      ...(declaration.id ? { id: declaration.id } : {}),
      ...(declaration.adapterId ? { adapterId: declaration.adapterId } : {}),
      ...(declaration.runtime ? { runtime: declaration.runtime } : {}),
      ...(declaration.packageManager ? { packageManager: declaration.packageManager } : {}),
    };
  });
}

function detectStack(projectRoot, options = {}) {
  const root = path.resolve(projectRoot);
  const catalog = options.catalog || readCatalog();
  validateStackSignalCatalog(catalog);
  const cityFabricBase = isCityFabricBase(root);
  // Files under local child repositories and skill mirrors are excluded below, so their Unity roots are moot.
  // Tool state (.factory runs, agent worktrees) is no part of the project either.
  const outside = relative => isLocalWorkspacePath(relative)
    || (cityFabricBase && (isLocalChildPath(relative) || isGeneratedSkillMirrorPath(relative)));
  const unityRoots = findUnityProjectRoots(root, options.maxDepth, { skip: outside });
  const files = walkFiles(root, {
    maxDepth: options.maxDepth,
    exclude: relative => isUnityGeneratedPath(relative, unityRoots) || outside(relative),
  });
  const matches = [];
  for (const file of files) {
    const base = path.posix.basename(file);
    const ext = path.posix.extname(base);
    for (const signal of catalog.signals) {
      const namedOrExtended = (signal.files || []).includes(base) || ((signal.extensions || []).includes(ext));
      const unityRoot = signal.family === 'unity' ? unityRootForMarker(file, unityRoots) : null;
      const fileMatch = namedOrExtended && (signal.family !== 'unity' || unityRoot !== null);
      if (!fileMatch) continue;
      const evidenceRoot = path.posix.dirname(file) === '.' ? '.' : path.posix.dirname(file);
      const markerRoot = signal.family === 'unity'
        ? unityRoot
        : evidenceRoot;
      matches.push({
        family: signal.family,
        root: markerRoot,
        markerRole: signal.markerRole || 'component',
        ownsModuleFamilies: [...new Set([signal.family, ...(signal.ownsModuleFamilies || [])])],
        confidence: signal.confidence,
        evidence: { path: file, signal: base },
        capabilities: signal.capabilities || [],
      });
    }
  }
  const ownerMap = new Map();
  for (const match of matches.filter(candidate => candidate.markerRole !== 'module')) {
    const key = `${match.family}:${match.root}`;
    const current = ownerMap.get(key);
    ownerMap.set(key, {
      family: match.family,
      root: match.root,
      ownsModuleFamilies: [...new Set([
        ...(current?.ownsModuleFamilies || []), ...match.ownsModuleFamilies,
      ])],
    });
  }
  const owners = [...ownerMap.values()];
  const groups = new Map();
  const detectionGaps = [];
  for (const match of matches) {
    let componentFamily = match.family;
    let componentRoot = match.root;
    let moduleOwner = null;
    if (match.markerRole === 'module') {
      const candidates = owners
        .filter(owner => owner.ownsModuleFamilies.includes(match.family) && isAtOrBelow(match.root, owner.root))
        .sort((left, right) => {
          const depth = right.root.split('/').length - left.root.split('/').length;
          const sameFamily = Number(right.family === match.family) - Number(left.family === match.family);
          return depth || sameFamily || `${left.family}:${left.root}`.localeCompare(`${right.family}:${right.root}`);
        });
      if (!candidates.length) {
        detectionGaps.push({
          code: 'orphan-module-marker',
          subject: `${match.family}:${match.root}`,
          message: `Module marker has no eligible component owner: ${match.evidence.path}`,
        });
        continue;
      }
      const nearestDepth = candidates[0].root === '.' ? 0 : candidates[0].root.split('/').length;
      const nearest = candidates.filter(candidate => (candidate.root === '.' ? 0 : candidate.root.split('/').length) === nearestDepth);
      if (nearest.length !== 1) {
        detectionGaps.push({
          code: 'ambiguous-module-owner',
          subject: `${match.family}:${match.root}`,
          message: `Module marker has multiple equally near owners: ${nearest.map(owner => `${owner.family}:${owner.root}`).join(', ')}`,
        });
        continue;
      }
      [moduleOwner] = nearest;
      componentFamily = moduleOwner.family;
      componentRoot = moduleOwner.root;
    }
    const key = `${componentFamily}:${componentRoot}`;
    if (!groups.has(key)) groups.set(key, {
      family: componentFamily, root: componentRoot, weights: [], evidence: [], capabilities: [], modules: new Map(),
    });
    const group = groups.get(key);
    if (moduleOwner && match.root !== componentRoot) {
      const relativeRoot = path.posix.relative(componentRoot, match.root) || '.';
      const moduleKey = `${match.family}:${relativeRoot}`;
      if (!group.modules.has(moduleKey)) group.modules.set(moduleKey, {
        family: match.family, root: relativeRoot, evidence: [],
      });
      group.modules.get(moduleKey).evidence.push(match.evidence);
      continue;
    }
    group.weights.push(match.confidence);
    group.evidence.push(match.evidence);
    group.capabilities.push(...match.capabilities);
  }
  let components = [...groups.values()].map(group => {
    const evidence = group.evidence.sort((a, b) => a.path.localeCompare(b.path));
    const confidence = Math.min(1, group.weights.reduce((sum, value) => sum + value, 0));
    const frameworks = frameworksFor(group.family, group.root, evidence, root);
    const capabilities = [...new Set([
      ...group.capabilities,
      ...(group.family === 'node' ? nodeCapabilities(group.root, root, frameworks) : []),
    ])].sort();
    const modules = [...group.modules.values()].map(module => ({
      family: module.family,
      root: module.root,
      evidence: module.evidence.sort((a, b) => a.path.localeCompare(b.path)),
    })).sort((left, right) => `${left.family}:${left.root}`.localeCompare(`${right.family}:${right.root}`));
    return { id: generatedId(group.family, group.root), family: group.family, root: group.root, confidence, frameworks, capabilities, evidence, modules };
  }).sort((a, b) => `${a.family}:${a.root}`.localeCompare(`${b.family}:${b.root}`));
  components = applyDeclarations(components, options.declarations);
  const capabilities = [...new Set(components.flatMap(component => component.capabilities || []))].sort();
  const componentIds = new Set();
  const gaps = [...detectionGaps];
  for (const component of components) {
    if (componentIds.has(component.id)) gaps.push({ code: 'duplicate-component-id', subject: component.id, message: `Component id is not unique: ${component.id}` });
    componentIds.add(component.id);
  }
  if (!components.length) gaps.push({ code: 'unknown-stack', message: 'No supported stack evidence found' });
  return { schemaVersion: '1.1.0', components, capabilities, gaps };
}

module.exports = { detectStack, validateStackSignalCatalog };
