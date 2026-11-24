'use strict';

/**
 * Registry-addressed child-project resolver.
 *
 * REQ-CF-001 and REQ-CF-002 require every child-facing caller to obtain paths
 * from this module instead of inferring them from directory names or host paths.
 *
 * Child layout (ADR-0018). The child root belongs to this base; every version
 * directory is an independent application repository:
 *   app_entry_root/<key>/_project/                         knowledge tracked by the base
 *   app_entry_root/<key>/_project/market/<store>/<locale>/ store listing texts
 *   app_entry_root/<key>/_output/<key>-<version>/          ignored local output
 *   app_entry_root/<key>/<key>-<version>/                  application repository (ignored)
 *
 * Shared packages (ADR-0024) are not children: `app_entry_root/packages/<name>/` holds
 * reusable libraries, each its own ignored repository, and `packages` is a reserved name.
 */

const fs = require('node:fs');
const path = require('node:path');

const CHILDREN_DIR = 'app_entry_root';
const KNOWLEDGE_DIR = '_project';
const OUTPUT_DIR = '_output';
const MARKET_DIR = 'market';
const PACKAGES_DIR = 'packages';
const SCREENSHOTS_DIR = 'screenshots';
const REGISTRY_REL = path.join(CHILDREN_DIR, '_registry', 'registry.json');
const SKILL_REGISTRY_REL = path.join('skills', 'REGISTRY.json');
const KEY_PATTERN = /^[a-z][a-z0-9-]{0,62}$/;
const VERSION_PATTERN = /^v[0-9][a-z0-9._-]{0,61}$/;
const LOCALE_PATTERN = /^[a-z]{2,3}(?:-[A-Z][a-z]{3})?(?:-(?:[A-Z]{2}|[0-9]{3}))?$/;
const RUNTIME_MODES = new Set(['disabled', 'advisory', 'governed']);

function registryError(message) {
  const error = new Error(`registry invalid: ${message}`);
  error.code = 'REGISTRY_INVALID';
  return error;
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function assertPlainObject(value, label) {
  if (!isPlainObject(value)) throw registryError(`${label} must be an object`);
}

function assertKnownKeys(value, allowed, label) {
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) throw registryError(`${label} has unknown property: ${key}`);
  }
}

function assertString(value, label, { nullable = false } = {}) {
  if (nullable && value === null) return value;
  if (typeof value !== 'string' || value.trim() === '') throw registryError(`${label} must be a non-empty string`);
  return value;
}

function assertStringArray(value, label) {
  if (!Array.isArray(value) || value.some(item => typeof item !== 'string' || item.trim() === '')) {
    throw registryError(`${label} must be an array of non-empty strings`);
  }
  return [...value];
}

function assertKey(value, label = 'key') {
  if (typeof value !== 'string' || !KEY_PATTERN.test(value)) {
    throw registryError(`${label} must be lowercase kebab-case`);
  }
  return value;
}

/** A child key may not take the name of the shared-packages directory. */
function assertChildKey(value, label = 'key') {
  assertKey(value, label);
  if (value === PACKAGES_DIR) throw registryError(`${label} "${PACKAGES_DIR}" is reserved for shared packages`);
  return value;
}

function assertVersion(value, label) {
  if (typeof value !== 'string' || !VERSION_PATTERN.test(value)) {
    throw registryError(`${label} must be a version id such as v1`);
  }
  return value;
}

/** The only directory name an application version may use: `<key>-<version>`. */
function versionDirName(key, version) {
  return `${key}-${version}`;
}

function assertUniqueList(values, label, pattern, description) {
  const list = assertStringArray(values, label);
  if (list.length === 0) throw registryError(`${label} must not be empty`);
  const seen = new Set();
  for (const item of list) {
    if (!pattern.test(item)) throw registryError(`${label} item ${item} must be ${description}`);
    if (seen.has(item)) throw registryError(`${label} has duplicate item: ${item}`);
    seen.add(item);
  }
  return list;
}

/**
 * Validate a path value before resolving it underneath a child root. Both POSIX
 * and Windows absolute forms are rejected even when this module is tested on a
 * different operating system.
 */
function assertRelativePath(value, label) {
  assertString(value, label);
  const normalized = value.replace(/\\/g, '/');
  if (normalized.includes('\0') || path.posix.isAbsolute(normalized) || path.win32.isAbsolute(value) || /^[A-Za-z]:/.test(value)) {
    throw registryError(`${label} must be a relative path`);
  }
  const segments = normalized.split('/');
  if (segments.some(segment => !segment || segment === '.' || segment === '..')) {
    throw registryError(`${label} must not contain empty, . or .. segments`);
  }
  return normalized;
}

function realPathIsInside(root, candidate) {
  const rootReal = fs.realpathSync(root);
  const candidateReal = fs.realpathSync(candidate);
  const relative = path.relative(rootReal, candidateReal);
  return relative === '' || (
    relative !== '..'
    && !relative.startsWith(`..${path.sep}`)
    && !path.isAbsolute(relative)
  );
}

/**
 * A version's directory is derived, never chosen: `<key>-<id>`. An explicit
 * `path` is accepted only as a readable restatement of that derived name.
 */
function normalizeVersionEntry(value, label, key) {
  assertPlainObject(value, label);
  assertKnownKeys(value, new Set(['id', 'path', 'repo', 'branch', 'note']), label);
  const id = assertVersion(value.id, `${label}.id`);
  const expected = versionDirName(key, id);
  if (value.path !== undefined && assertRelativePath(value.path, `${label}.path`) !== expected) {
    throw registryError(`${label}.path must be ${expected}`);
  }
  const normalized = { id, path: expected };
  for (const field of ['repo', 'branch', 'note']) {
    if (value[field] !== undefined && value[field] !== null) normalized[field] = assertString(value[field], `${label}.${field}`);
  }
  return normalized;
}

function normalizeBack(value, label) {
  if (value === null || value === undefined) return null;
  assertPlainObject(value, label);
  assertKnownKeys(value, new Set(['path', 'repo']), label);
  const result = {};
  if (value.path !== undefined) result.path = assertRelativePath(value.path, `${label}.path`);
  if (value.repo !== undefined) result.repo = assertString(value.repo, `${label}.repo`);
  return result;
}

function normalizeApp(value, label, key) {
  if (value === null || value === undefined) return null;
  assertPlainObject(value, label);
  if (value.path !== undefined) {
    throw registryError(`${label}.path is retired; declare app.versions so code lives in ${versionDirName(key, 'v1')}/`);
  }
  assertKnownKeys(value, new Set(['active', 'versions', 'back']), label);
  if (!Array.isArray(value.versions) || value.versions.length === 0) {
    throw registryError(`${label}.versions must declare at least one version`);
  }
  const versions = value.versions.map((entry, index) => normalizeVersionEntry(entry, `${label}.versions[${index}]`, key));
  const ids = new Set();
  for (const version of versions) {
    if (ids.has(version.id)) throw registryError(`${label}.versions has duplicate id: ${version.id}`);
    ids.add(version.id);
  }
  const active = assertVersion(value.active, `${label}.active`);
  if (!ids.has(active)) throw registryError(`${label}.active does not name a declared version`);
  const back = normalizeBack(value.back, `${label}.back`);
  if (back?.path && reservedChildEntry(key, versions, back.path.split('/')[0])) {
    throw registryError(`${label}.back.path must not reuse a reserved child directory`);
  }
  return { active, versions, back };
}

/** Directories the layout reserves; a sidecar path may not alias one of them. */
function reservedChildEntry(key, versions, name) {
  return name === KNOWLEDGE_DIR || name === OUTPUT_DIR || versions.some(version => version.path === name);
}

/**
 * Store listings are declared per child: every store × locale pair receives a
 * tracked text directory and a per-version screenshot directory. `locales` is
 * shared by every declared store; the optional `extraLocales` maps a declared
 * store to further locales only that store lists (a store that already carries
 * a language the other stores do not).
 */
function normalizeMarket(value, label) {
  if (value === null || value === undefined) return null;
  assertPlainObject(value, label);
  assertKnownKeys(value, new Set(['stores', 'locales', 'extraLocales']), label);
  const market = {
    stores: assertUniqueList(value.stores, `${label}.stores`, KEY_PATTERN, 'lowercase kebab-case'),
    locales: assertUniqueList(value.locales, `${label}.locales`, LOCALE_PATTERN, 'a BCP 47 tag such as en-GB'),
  };
  if (value.extraLocales !== undefined) {
    assertPlainObject(value.extraLocales, `${label}.extraLocales`);
    const extra = {};
    for (const [store, list] of Object.entries(value.extraLocales)) {
      if (!market.stores.includes(store)) throw registryError(`${label}.extraLocales names a store that is not declared: ${store}`);
      extra[store] = assertUniqueList(list, `${label}.extraLocales.${store}`, LOCALE_PATTERN, 'a BCP 47 tag such as en-GB');
      const shared = extra[store].find(locale => market.locales.includes(locale));
      if (shared) throw registryError(`${label}.extraLocales.${store} repeats a shared locale: ${shared}`);
    }
    if (Object.keys(extra).length > 0) market.extraLocales = extra;
  }
  return market;
}

/** Every locale a store lists: the shared ones plus the store's own extras. */
function storeLocales(market, store) {
  return [...market.locales, ...(market.extraLocales?.[store] ?? [])];
}

function normalizeRuntime(value, label) {
  if (value === null || value === undefined) return null;
  assertPlainObject(value, label);
  assertKnownKeys(value, new Set(['ai', 'platforms']), label);
  const runtime = {};
  if (value.ai !== undefined) {
    assertPlainObject(value.ai, `${label}.ai`);
    assertKnownKeys(value.ai, new Set(['mode', 'capabilityPacks', 'providerClasses']), `${label}.ai`);
    const mode = assertString(value.ai.mode, `${label}.ai.mode`);
    if (!RUNTIME_MODES.has(mode)) throw registryError(`${label}.ai.mode must be disabled, advisory or governed`);
    runtime.ai = { mode };
    if (value.ai.capabilityPacks !== undefined) runtime.ai.capabilityPacks = assertStringArray(value.ai.capabilityPacks, `${label}.ai.capabilityPacks`);
    if (value.ai.providerClasses !== undefined) runtime.ai.providerClasses = assertStringArray(value.ai.providerClasses, `${label}.ai.providerClasses`);
  }
  if (value.platforms !== undefined) runtime.platforms = assertStringArray(value.platforms, `${label}.platforms`);
  return runtime;
}

function normalizeEntry(value, index) {
  const label = `projects[${index}]`;
  assertPlainObject(value, label);
  assertKnownKeys(value, new Set([
    'key', 'title', 'summary', 'status', 'presentLocally', 'app', 'stack', 'ci', 'demo',
    'neighbours', 'notes', 'capabilityPacks', 'runtime', 'market',
  ]), label);
  const entry = { key: assertChildKey(value.key, `${label}.key`) };
  for (const field of ['title', 'status']) {
    if (value[field] !== undefined) entry[field] = assertString(value[field], `${label}.${field}`);
  }
  if (value.summary !== undefined) entry.summary = assertString(value.summary, `${label}.summary`, { nullable: true });
  if (value.presentLocally !== undefined) {
    if (typeof value.presentLocally !== 'boolean') throw registryError(`${label}.presentLocally must be boolean`);
    entry.presentLocally = value.presentLocally;
  } else entry.presentLocally = false;
  entry.app = normalizeApp(value.app, `${label}.app`, entry.key);
  entry.market = normalizeMarket(value.market, `${label}.market`);
  entry.runtime = normalizeRuntime(value.runtime, `${label}.runtime`);
  if (value.capabilityPacks !== undefined) entry.capabilityPacks = assertStringArray(value.capabilityPacks, `${label}.capabilityPacks`);

  for (const field of ['stack', 'ci', 'demo']) {
    if (value[field] !== undefined) {
      assertPlainObject(value[field], `${label}.${field}`);
      entry[field] = structuredClone(value[field]);
    }
  }
  if (value.neighbours !== undefined) {
    if (!Array.isArray(value.neighbours)) throw registryError(`${label}.neighbours must be an array`);
    entry.neighbours = value.neighbours.map((neighbour, neighbourIndex) => {
      const itemLabel = `${label}.neighbours[${neighbourIndex}]`;
      assertPlainObject(neighbour, itemLabel);
      assertKnownKeys(neighbour, new Set(['path', 'what', 'actual']), itemLabel);
      const normalized = {
        path: assertRelativePath(neighbour.path, `${itemLabel}.path`),
        what: assertString(neighbour.what, `${itemLabel}.what`),
      };
      if (neighbour.actual !== undefined) {
        if (typeof neighbour.actual !== 'boolean') throw registryError(`${itemLabel}.actual must be boolean`);
        normalized.actual = neighbour.actual;
      }
      return normalized;
    });
  }
  if (value.notes !== undefined) entry.notes = assertStringArray(value.notes, `${label}.notes`);
  return entry;
}

/** Validate and normalize a registry document without reading the file system. */
function normalizeRegistry(value) {
  assertPlainObject(value, 'registry');
  assertKnownKeys(value, new Set(['$schema', 'schemaVersion', 'version', 'title', 'note', 'invariant', 'projects']), 'registry');
  const declaredVersion = value.schemaVersion ?? value.version;
  if (!(declaredVersion === '1.0.0' || declaredVersion === 1)) {
    throw registryError('schemaVersion must be 1.0.0');
  }
  if (!Array.isArray(value.projects)) throw registryError('projects must be an array');
  const projects = value.projects.map(normalizeEntry);
  const keys = new Set();
  for (const project of projects) {
    if (keys.has(project.key)) throw registryError(`projects has duplicate key: ${project.key}`);
    keys.add(project.key);
  }
  return {
    schemaVersion: '1.0.0',
    ...(value.$schema ? { $schema: value.$schema } : {}),
    ...(value.title ? { title: value.title } : {}),
    ...(value.note ? { note: value.note } : {}),
    ...(value.invariant ? { invariant: value.invariant } : {}),
    projects,
  };
}

function declaredCapabilityPacks(registry) {
  const declared = [];
  for (let projectIndex = 0; projectIndex < registry.projects.length; projectIndex += 1) {
    const project = registry.projects[projectIndex];
    for (const name of project.capabilityPacks ?? []) {
      declared.push({ name, label: `projects[${projectIndex}].capabilityPacks` });
    }
    for (const name of project.runtime?.ai?.capabilityPacks ?? []) {
      declared.push({ name, label: `projects[${projectIndex}].runtime.ai.capabilityPacks` });
    }
  }
  return declared;
}

/**
 * A runtime profile may select only an installed skill directory or a generated
 * pack identifier. The check is conditional so an isolated registry fixture can
 * still be validated before a local canon has been initialized.
 */
function validateDeclaredCapabilityPacks(baseRoot, registry) {
  const declared = declaredCapabilityPacks(registry);
  if (declared.length === 0) return registry;
  const catalogFile = path.join(baseRoot, SKILL_REGISTRY_REL);
  if (!fs.existsSync(catalogFile)) return registry;
  let catalog;
  try { catalog = JSON.parse(fs.readFileSync(catalogFile, 'utf8')); }
  catch (error) { throw registryError(`${SKILL_REGISTRY_REL} is unreadable: ${error.message}`); }
  if (!Array.isArray(catalog.skills)) throw registryError(`${SKILL_REGISTRY_REL} has no skills array`);
  const available = new Set();
  for (const skill of catalog.skills) {
    if (typeof skill?.directory === 'string') available.add(skill.directory);
    if (typeof skill?.pack === 'string') available.add(skill.pack);
  }
  for (const capability of declared) {
    if (!available.has(capability.name)) {
      throw registryError(`${capability.label} names unavailable local capability: ${capability.name}`);
    }
  }
  return registry;
}

/** Factory root is recognized by the same stable markers used by Factory City gates. */
function isBaseRoot(dir) {
  const agents = path.join(dir, 'AGENTS.md');
  if (!fs.existsSync(agents) || !fs.existsSync(path.join(dir, 'cli', 'bin', 'infra.js'))) return false;
  try {
    return fs.readFileSync(agents, 'utf8').includes('Factory City');
  } catch {
    return false;
  }
}

/** Find a Factory City root from any descendant, including a child application path. */
function findBaseRoot(startDir = process.cwd()) {
  let dir = path.resolve(startDir);
  for (;;) {
    if (isBaseRoot(dir)) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

function readRegistry(baseRoot) {
  const file = path.join(baseRoot, REGISTRY_REL);
  if (!fs.existsSync(file)) return { schemaVersion: '1.0.0', projects: [] };
  try {
    return validateDeclaredCapabilityPacks(baseRoot, normalizeRegistry(JSON.parse(fs.readFileSync(file, 'utf8'))));
  } catch (error) {
    if (error.code === 'REGISTRY_INVALID') throw error;
    const wrapped = new Error(`registry unreadable at ${REGISTRY_REL}: ${error.message}`);
    wrapped.code = 'REGISTRY_UNREADABLE';
    throw wrapped;
  }
}

function findEntry(baseRoot, key) {
  return readRegistry(baseRoot).projects.find(entry => entry.key === key) ?? null;
}

/** Derive every child path from a key and one registry record. */
function childPaths(baseRoot, key, version) {
  assertKey(key);
  const childRoot = path.join(baseRoot, CHILDREN_DIR, key);
  const entry = findEntry(baseRoot, key);
  const app = entry?.app ?? null;
  const versions = app?.versions ?? [];
  if (version !== undefined) assertVersion(version, `project ${key} version`);
  const selectedVersion = version ?? app?.active ?? null;
  const versionEntry = selectedVersion === null ? null : versions.find(item => item.id === selectedVersion) ?? null;
  if (selectedVersion !== null && !versionEntry) throw registryError(`project ${key} has no version: ${selectedVersion}`);
  const outputName = versionEntry ? versionEntry.path : key;
  const knowledgeRoot = path.join(childRoot, KNOWLEDGE_DIR);
  const outputRoot = path.join(childRoot, OUTPUT_DIR, outputName);
  return {
    childRoot,
    knowledgeRoot,
    outputRoot,
    // Key and version id patterns admit no separator or traversal, so the derived name is contained.
    appRoot: versionEntry ? path.join(childRoot, versionEntry.path) : null,
    version: selectedVersion,
    versions: versions.map(item => item.id),
    outputName,
    marketRoot: path.join(knowledgeRoot, MARKET_DIR),
    marketOutputRoot: path.join(outputRoot, MARKET_DIR),
    market: entry?.market ?? null,
    runtime: entry?.runtime ?? null,
    capabilityPacks: entry?.capabilityPacks ?? [],
  };
}

/**
 * A working directory under `app_entry_root/packages/` is a shared package, never a
 * child: it has no registry key, no `_project/` knowledge and no output root. The
 * package's own repository keeps its documentation, so `knowledgeRoot` is its root.
 */
function resolvePackage(baseRoot, name) {
  const packagesRoot = path.join(baseRoot, CHILDREN_DIR, PACKAGES_DIR);
  const named = name !== null && KEY_PATTERN.test(name);
  const packageRoot = named ? path.join(packagesRoot, name) : null;
  return {
    scope: 'package', baseRoot, key: null, packageName: named ? name : null, packageRoot,
    knowledgeRoot: packageRoot, outputRoot: null, appRoot: null, version: null, runtime: null,
    capabilityPacks: [], inRegistry: false,
    reason: named
      ? `path is inside shared package ${CHILDREN_DIR}/${PACKAGES_DIR}/${name}/`
      : `path is inside the shared packages directory ${CHILDREN_DIR}/${PACKAGES_DIR}/`,
  };
}

/** Resolve base/child scope and return the only allowed context for child-aware work. */
function resolveProject(cwd = process.cwd()) {
  const baseRoot = findBaseRoot(cwd);
  const none = {
    scope: 'unknown', baseRoot: null, key: null, knowledgeRoot: null,
    outputRoot: null, appRoot: null, version: null, runtime: null,
    capabilityPacks: [], inRegistry: false,
  };
  if (!baseRoot) return { ...none, reason: 'Factory City root not found upward from current directory' };

  const segments = path.relative(baseRoot, path.resolve(cwd)).split(path.sep);
  if (segments[0] !== CHILDREN_DIR || segments.length < 2 || !segments[1] || segments[1].startsWith('_') || segments[1].startsWith('.')) {
    return {
      scope: 'base', baseRoot, key: null, knowledgeRoot: baseRoot, outputRoot: null,
      appRoot: null, version: null, runtime: null, capabilityPacks: [], inRegistry: false,
      reason: 'working in Factory City base',
    };
  }

  if (segments[1] === PACKAGES_DIR) return resolvePackage(baseRoot, segments[2] ?? null);

  const key = segments[1];
  const entry = KEY_PATTERN.test(key) ? findEntry(baseRoot, key) : null;
  if (!entry) {
    return {
      scope: 'child', baseRoot, key, knowledgeRoot: path.join(baseRoot, CHILDREN_DIR, key, KNOWLEDGE_DIR),
      outputRoot: path.join(baseRoot, CHILDREN_DIR, key, OUTPUT_DIR, key), appRoot: null,
      version: null, runtime: null, capabilityPacks: [], inRegistry: false,
      reason: `path is inside unregistered child ${CHILDREN_DIR}/${key}/`,
    };
  }
  // A working directory inside `<key>-<version>/` selects that version.
  const fromPath = entry.app?.versions.find(item => item.path === segments[2])?.id;
  const paths = childPaths(baseRoot, key, fromPath);
  return {
    scope: 'child', baseRoot, key, ...paths, inRegistry: true,
    reason: `path is inside registered child ${CHILDREN_DIR}/${key}/`,
  };
}

/** Resolve a child directly from its registry key without deriving it from a path. */
function resolveProjectKey(baseRoot, key, version) {
  assertKey(key);
  const entry = findEntry(baseRoot, key);
  if (!entry) throw registryError(`project key is not registered: ${key}`);
  const paths = childPaths(baseRoot, key, version);
  return {
    scope: 'child', baseRoot, key, ...paths, inRegistry: true,
    reason: `resolved registered child key ${key}`,
  };
}

/**
 * Expand the declared store × locale matrix into exact directories:
 * tracked listing text under `_project/market/` and per-version captures
 * under the resolver-owned output root.
 */
function marketPaths(baseRoot, key, version) {
  const resolved = resolveProjectKey(baseRoot, key, version);
  if (!resolved.market) throw registryError(`project ${key} declares no market`);
  if (!resolved.version) throw registryError(`project ${key} market output requires an app version`);
  const targets = [];
  for (const store of resolved.market.stores) {
    for (const locale of storeLocales(resolved.market, store)) {
      const outputRoot = path.join(resolved.marketOutputRoot, store, locale);
      targets.push({
        store,
        locale,
        textRoot: path.join(resolved.marketRoot, store, locale),
        outputRoot,
        screenshotsRoot: path.join(outputRoot, SCREENSHOTS_DIR),
      });
    }
  }
  return {
    key,
    version: resolved.version,
    marketRoot: resolved.marketRoot,
    marketOutputRoot: resolved.marketOutputRoot,
    stores: [...resolved.market.stores],
    locales: [...resolved.market.locales],
    storeLocales: Object.fromEntries(resolved.market.stores.map(store => [store, storeLocales(resolved.market, store)])),
    targets,
  };
}

/**
 * Create missing market directories without touching existing content. Text
 * directories receive a `.gitkeep` so an empty locale stays visible in Git.
 * The child root must already exist; this never materializes a new child.
 */
function initMarket(baseRoot, key, version) {
  const plan = marketPaths(baseRoot, key, version);
  const childRoot = path.join(baseRoot, CHILDREN_DIR, key);
  if (!fs.existsSync(childRoot)) throw registryError(`project ${key} child directory is absent; create it before market init`);
  for (const container of [path.join(childRoot, KNOWLEDGE_DIR), path.join(childRoot, OUTPUT_DIR)]) {
    if (fs.existsSync(container) && !realPathIsInside(childRoot, container)) {
      throw registryError(`project ${key} ${path.basename(container)} escapes its child directory through a link`);
    }
  }
  const created = [];
  const ensureDir = dir => {
    if (fs.existsSync(dir)) return;
    fs.mkdirSync(dir, { recursive: true });
    created.push(dir);
  };
  for (const target of plan.targets) {
    ensureDir(target.textRoot);
    const keep = path.join(target.textRoot, '.gitkeep');
    if (fs.readdirSync(target.textRoot).length === 0) {
      fs.writeFileSync(keep, '', { flag: 'wx' });
      created.push(keep);
    }
    ensureDir(target.screenshotsRoot);
  }
  return { ...plan, created };
}

function childRel(key, ...parts) {
  return [CHILDREN_DIR, key, ...parts].join('/');
}

/** Only the layout's reserved directories, a declared sidecar and dot-entries may sit in a child root. */
function scanChildRoot(entry, childRoot, drift) {
  const versions = entry.app?.versions ?? [];
  const sidecar = entry.app?.back?.path?.split('/')[0] ?? null;
  for (const childEntry of fs.readdirSync(childRoot, { withFileTypes: true })) {
    const name = childEntry.name;
    if (name.startsWith('.')) continue;
    if (childEntry.isDirectory() && (reservedChildEntry(entry.key, versions, name) || name === sidecar)) continue;
    if (childEntry.isDirectory()) {
      drift.push({
        key: entry.key,
        problem: `directory outside the child layout: ${childRel(entry.key, name)}/ (application code belongs in ${versionDirName(entry.key, '<version>')}/)`,
      });
    } else {
      drift.push({ key: entry.key, problem: `loose entry exists directly in child root: ${childRel(entry.key, name)}` });
    }
  }
}

function scanOutput(entry, childRoot, drift) {
  const outputContainer = path.join(childRoot, OUTPUT_DIR);
  if (!fs.existsSync(outputContainer)) return;
  if (!realPathIsInside(childRoot, outputContainer)) {
    drift.push({ key: entry.key, problem: 'output container escapes the child directory through a link' });
    return;
  }
  const versions = entry.app?.versions ?? [];
  const allowed = new Set(versions.length ? versions.map(version => version.path) : [entry.key]);
  for (const artifact of fs.readdirSync(outputContainer, { withFileTypes: true })) {
    if (!allowed.has(artifact.name)) {
      drift.push({
        key: entry.key,
        problem: `output exists outside resolver-owned root: ${childRel(entry.key, OUTPUT_DIR, artifact.name)}`,
      });
    } else if (!realPathIsInside(outputContainer, path.join(outputContainer, artifact.name))) {
      drift.push({
        key: entry.key,
        problem: `resolver-owned output root escapes its child container through a link: ${childRel(entry.key, OUTPUT_DIR, artifact.name)}`,
      });
    }
  }
}

/** Report each store whose declared locales lack a tracked listing directory. */
function scanMarket(entry, knowledgeRoot, drift) {
  if (!entry.market || !fs.existsSync(knowledgeRoot)) return;
  for (const store of entry.market.stores) {
    const missing = storeLocales(entry.market, store).filter(locale => !fs.existsSync(path.join(knowledgeRoot, MARKET_DIR, store, locale)));
    if (missing.length) {
      drift.push({
        key: entry.key,
        problem: `market text directories are absent for ${store}: ${missing.join(', ')} (run infra project market ${entry.key} --init)`,
      });
    }
  }
}

/** Compare tracked registry intent with local child layout without mutating either. */
function scanProjects(baseRoot) {
  const registry = readRegistry(baseRoot);
  const drift = [];
  const childrenDir = path.join(baseRoot, CHILDREN_DIR);
  const onDisk = fs.existsSync(childrenDir)
    ? fs.readdirSync(childrenDir, { withFileTypes: true })
      .filter(entry => entry.isDirectory() && !entry.name.startsWith('_') && !entry.name.startsWith('.') && entry.name !== PACKAGES_DIR)
      .map(entry => entry.name)
    : [];

  for (const entry of registry.projects) {
    const paths = childPaths(baseRoot, entry.key);
    if (!fs.existsSync(paths.childRoot)) {
      if (entry.presentLocally) drift.push({ key: entry.key, problem: 'presentLocally is true but child directory is absent' });
      continue;
    }
    if (!fs.existsSync(paths.knowledgeRoot)) {
      drift.push({ key: entry.key, problem: `knowledge directory is absent: ${childRel(entry.key, KNOWLEDGE_DIR)}/` });
    }
    if (entry.presentLocally) {
      if (!paths.appRoot) drift.push({ key: entry.key, problem: 'presentLocally requires a registered app version' });
      else if (!fs.existsSync(paths.appRoot)) {
        drift.push({ key: entry.key, problem: `registered app version is absent locally: ${childRel(entry.key, paths.outputName)}/` });
      }
    }
    scanChildRoot(entry, paths.childRoot, drift);
    scanOutput(entry, paths.childRoot, drift);
    scanMarket(entry, paths.knowledgeRoot, drift);
  }

  for (const legacyContainer of [
    path.join(baseRoot, OUTPUT_DIR),
    path.join(childrenDir, OUTPUT_DIR),
  ]) {
    if (!fs.existsSync(legacyContainer)) continue;
    for (const artifact of fs.readdirSync(legacyContainer, { withFileTypes: true })) {
      drift.push({
        key: artifact.name,
        problem: `legacy child output exists outside its child directory: ${path.relative(baseRoot, path.join(legacyContainer, artifact.name))}`,
      });
    }
  }

  const known = new Set(registry.projects.map(entry => entry.key));
  for (const key of onDisk) {
    if (!known.has(key)) drift.push({ key, problem: 'child directory exists without a registry record' });
  }
  return drift.sort((left, right) => `${left.key}\0${left.problem}`.localeCompare(`${right.key}\0${right.problem}`));
}

function listProjects(baseRoot) {
  return readRegistry(baseRoot).projects.map(entry => ({
    key: entry.key,
    title: entry.title ?? null,
    status: entry.status ?? null,
    presentLocally: entry.presentLocally,
    activeVersion: entry.app?.active ?? null,
    versions: (entry.app?.versions ?? []).map(version => version.id),
    market: entry.market ?? null,
    capabilityPacks: entry.capabilityPacks ?? [],
    runtime: entry.runtime ?? null,
  }));
}

module.exports = {
  CHILDREN_DIR,
  KNOWLEDGE_DIR,
  OUTPUT_DIR,
  MARKET_DIR,
  PACKAGES_DIR,
  REGISTRY_REL,
  SKILL_REGISTRY_REL,
  assertKey,
  assertChildKey,
  assertRelativePath,
  versionDirName,
  normalizeRegistry,
  validateDeclaredCapabilityPacks,
  isBaseRoot,
  findBaseRoot,
  readRegistry,
  findEntry,
  childPaths,
  resolveProject,
  resolveProjectKey,
  marketPaths,
  storeLocales,
  initMarket,
  scanProjects,
  listProjects,
};
