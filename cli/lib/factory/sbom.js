'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { stableDigest } = require('./stable-json');
const { isCityFabricBase, isGeneratedSkillMirrorPath, isLocalChildPath, isLocalWorkspacePath } = require('./hash');
const {
  findUnityProjectRoots,
  isUnityGeneratedPath,
  relativeWithinUnityProject,
} = require('./unity');

const SOURCE_NAMES = new Set([
  'package.json', 'package-lock.json', 'npm-shrinkwrap.json', 'pnpm-lock.yaml', 'yarn.lock',
  'composer.json', 'composer.lock', 'requirements.txt', 'pyproject.toml', 'poetry.lock', 'Pipfile.lock',
  'go.mod', 'go.sum', 'Cargo.toml', 'Cargo.lock', 'packages.lock.json', 'pom.xml', 'build.gradle',
  'build.gradle.kts', 'gradle.lockfile', 'Gemfile', 'Gemfile.lock',
]);
const UNITY_PACKAGE_FILES = new Set(['Packages/manifest.json', 'Packages/packages-lock.json']);

function sha256(buffer) { return crypto.createHash('sha256').update(buffer).digest('hex'); }
function cleanVersion(value) { return String(value || '').trim().replace(/^[~^=<>! ]+/, '').split(/[ ,;]/)[0] || 'unknown'; }
function add(map, type, name, version, scope, source) {
  if (!name) return;
  const normalized = cleanVersion(version);
  const key = `${type}\0${name}\0${normalized}\0${scope || 'required'}`;
  if (!map.has(key)) map.set(key, { type: 'library', name, version: normalized, scope: scope || 'required', purl: `pkg:${type}/${encodeURIComponent(name)}@${encodeURIComponent(normalized)}`, properties: [{ name: 'factory:source', value: source }] });
}
function readJson(file) { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; } }

function packageJson(file, map, relative) {
  const data = readJson(file); if (!data) return;
  for (const [field, scope] of [['dependencies', 'required'], ['optionalDependencies', 'optional'], ['devDependencies', 'development'], ['peerDependencies', 'required']]) {
    for (const [name, version] of Object.entries(data[field] || {})) add(map, 'npm', name, version, scope, relative);
  }
}
function packageLock(file, map, relative) {
  const data = readJson(file); if (!data) return;
  for (const [location, item] of Object.entries(data.packages || {})) {
    if (!location || !item || !item.version) continue;
    add(map, 'npm', item.name || location.replace(/^.*node_modules\//, ''), item.version, item.dev ? 'development' : 'required', relative);
  }
  for (const [name, item] of Object.entries(data.dependencies || {})) add(map, 'npm', name, item && item.version, item && item.dev ? 'development' : 'required', relative);
}
function composer(file, map, relative) {
  const data = readJson(file); if (!data) return;
  const locked = Array.isArray(data.packages);
  if (locked) for (const item of [...(data.packages || []), ...(data['packages-dev'] || [])]) add(map, 'composer', item.name, item.version, (data['packages-dev'] || []).includes(item) ? 'development' : 'required', relative);
  else for (const [field, scope] of [['require', 'required'], ['require-dev', 'development']]) for (const [name, version] of Object.entries(data[field] || {})) if (name !== 'php') add(map, 'composer', name, version, scope, relative);
}
function requirements(text, map, relative) { for (const line of text.split(/\r?\n/)) { const match = line.trim().match(/^([A-Za-z0-9_.-]+)(?:\[[^\]]+\])?\s*(?:==|~=|>=|<=|>|<)?\s*([^;\s]+)?/); if (match && !line.trim().startsWith('#')) add(map, 'pypi', match[1], match[2], 'required', relative); } }
function addPythonRequirement(spec, map, relative, scope) {
  const match = String(spec).trim().match(/^([A-Za-z0-9_.-]+)(?:\[[^\]]+\])?(?:\s*@\s*\S+|\s*(?:===|==|~=|>=|<=|!=|>|<)\s*([^;\s]+))?/);
  if (match) add(map, 'pypi', match[1], match[2], scope, relative);
}
function tomlSection(text, name) {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = text.match(new RegExp(`^\\s*\\[${escaped}\\]\\s*$([\\s\\S]*?)(?=^\\s*\\[|(?![\\s\\S]))`, 'm'));
  return match ? match[1] : '';
}
function tomlArrayAt(text, openIndex) {
  let quote = null;
  let escaped = false;
  for (let index = openIndex + 1; index < text.length; index++) {
    const char = text[index];
    if (quote) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === quote) quote = null;
      continue;
    }
    if (char === '"' || char === "'") quote = char;
    else if (char === ']') return text.slice(openIndex + 1, index);
  }
  return '';
}
function tomlArrayAssignments(section, keyPattern) {
  const values = [];
  const matcher = new RegExp(`^\\s*${keyPattern}\\s*=\\s*\\[`, 'gm');
  for (const match of section.matchAll(matcher)) {
    values.push(tomlArrayAt(section, match.index + match[0].lastIndexOf('[')));
  }
  return values;
}
function pythonToml(text, map, relative) {
  const project = tomlSection(text, 'project');
  for (const dependencies of tomlArrayAssignments(project, 'dependencies')) {
    for (const match of dependencies.matchAll(/["']([^"']+)["']/g)) {
      addPythonRequirement(match[1], map, relative, 'required');
    }
  }

  const optional = tomlSection(text, 'project.optional-dependencies');
  for (const block of tomlArrayAssignments(optional, '[A-Za-z0-9_.-]+')) {
    for (const match of block.matchAll(/["']([^"']+)["']/g)) {
      addPythonRequirement(match[1], map, relative, 'optional');
    }
  }

  for (const sectionName of ['tool.poetry.dependencies', 'tool.poetry.group.dev.dependencies']) {
    const section = tomlSection(text, sectionName);
    const scope = sectionName.includes('.dev.') ? 'development' : 'required';
    for (const match of section.matchAll(/^\s*([A-Za-z0-9_.-]+)\s*=\s*(?:["']([^"']+)["']|\{[^}]*version\s*=\s*["']([^"']+)["'][^}]*\})/gm)) {
      if (match[1] !== 'python') add(map, 'pypi', match[1], match[2] || match[3], scope, relative);
    }
  }

  for (const block of text.matchAll(/\[\[package\]\]([\s\S]*?)(?=\[\[package\]\]|$)/g)) {
    const name = block[1].match(/^name\s*=\s*["']([^"']+)["']/m); const version = block[1].match(/^version\s*=\s*["']([^"']+)["']/m);
    if (name) add(map, 'pypi', name[1], version && version[1], 'required', relative);
  }
}
function pipfileLock(file, map, relative) {
  const data = readJson(file); if (!data) return;
  for (const [field, scope] of [['default', 'required'], ['develop', 'development']]) for (const [name, item] of Object.entries(data[field] || {})) add(map, 'pypi', name, typeof item === 'string' ? item : item.version, scope, relative);
}
function goMod(text, map, relative) { for (const match of text.matchAll(/^\s*(?:require\s+)?([^\s()]+)\s+(v[^\s()]+)(?:\s+\/\/ indirect)?$/gm)) add(map, 'golang', match[1], match[2], 'required', relative); }
function cargoLock(text, map, relative) { for (const block of text.split(/\[\[package\]\]/).slice(1)) { const name = block.match(/^\s*name\s*=\s*"([^"]+)"/m); const version = block.match(/^\s*version\s*=\s*"([^"]+)"/m); if (name) add(map, 'cargo', name[1], version && version[1], 'required', relative); } }
function cargoToml(text, map, relative) {
  const section = text.match(/\[dependencies\]([\s\S]*?)(?=\n\s*\[|$)/); if (!section) return;
  for (const match of section[1].matchAll(/^\s*([A-Za-z0-9_-]+)\s*=\s*(?:"([^"]+)"|\{[^}]*version\s*=\s*"([^"]+)"[^}]*\})/gm)) add(map, 'cargo', match[1], match[2] || match[3], 'required', relative);
}
function yarnLock(text, map, relative) { for (const match of text.matchAll(/^(?:"?)(@?[^\s@:]+(?:\/[^\s@:]+)?)[^:]*:\s*\r?\n\s+version\s+"([^"]+)"/gm)) add(map, 'npm', match[1], match[2], 'required', relative); }
function pnpmLock(text, map, relative) { for (const match of text.matchAll(/^\s{2,}['"]?\/?((?:@[^\/\s:'"]+\/)?[^@\/\s:'"]+)[@\/]([^:\s'"]+)['"]?:/gm)) add(map, 'npm', match[1], match[2], 'required', relative); }
function dotnet(text, map, relative) { for (const match of text.matchAll(/<PackageReference\s+Include="([^"]+)"(?:\s+Version="([^"]+)")?[^>]*>(?:[\s\S]*?<Version>([^<]+)<\/Version>)?/gi)) add(map, 'nuget', match[1], match[2] || match[3], 'required', relative); }
function dotnetLock(file, map, relative) { const data = readJson(file); if (!data) return; for (const framework of Object.values(data.dependencies || {})) for (const [name, item] of Object.entries(framework || {})) add(map, 'nuget', name, item && (item.resolved || item.requested), 'required', relative); }
function maven(text, map, relative) { for (const block of text.matchAll(/<dependency>([\s\S]*?)<\/dependency>/gi)) { const group = block[1].match(/<groupId>([^<]+)<\/groupId>/); const artifact = block[1].match(/<artifactId>([^<]+)<\/artifactId>/); const version = block[1].match(/<version>([^<]+)<\/version>/); if (artifact) add(map, 'maven', group ? `${group[1]}:${artifact[1]}` : artifact[1], version && version[1], 'required', relative); } }
function gemLock(text, map, relative) { for (const match of text.matchAll(/^\s{4}([^\s(]+) \(([^)]+)\)$/gm)) add(map, 'gem', match[1], match[2], 'required', relative); }
function gemfile(text, map, relative) { for (const match of text.matchAll(/^\s*gem\s+["']([^"']+)["'](?:\s*,\s*["']([^"']+)["'])?/gm)) add(map, 'gem', match[1], match[2], 'required', relative); }
function gradle(text, map, relative) { for (const match of text.matchAll(/(?:implementation|api|runtimeOnly|compileOnly)\s*\(?["']([^:"']+):([^:"']+):([^"']+)["']\)?/g)) add(map, 'maven', `${match[1]}:${match[2]}`, match[3], 'required', relative); }
function gradleLock(text, map, relative) {
  for (const line of text.split(/\r?\n/)) {
    const match = line.trim().match(/^([^:#=]+):([^:=]+):([^=]+)=([^#]+)$/);
    if (!match) continue;
    const configurations = match[4].split(',').map(value => value.trim()).filter(Boolean);
    const production = configurations.some(value => !/^test/i.test(value) && value !== 'kotlinInternalAbiValidation');
    add(map, 'maven', `${match[1]}:${match[2]}`, match[3], production ? 'required' : 'development', relative);
  }
}
function unityPackages(file, map, relative) {
  const data = readJson(file); if (!data) return;
  const dependencies = data.dependencies || {};
  for (const [name, entry] of Object.entries(dependencies)) {
    const version = typeof entry === 'string' ? entry : entry && entry.version;
    add(map, 'generic', name, version, 'required', relative);
  }
}

/** Paths the source walk never enters: tool state, and in the base its local children and skill mirrors. */
function outsideSources(root) {
  const cityFabricBase = isCityFabricBase(root);
  return relative => isLocalWorkspacePath(relative)
    || (cityFabricBase && (isLocalChildPath(relative) || isGeneratedSkillMirrorPath(relative)));
}

/** Unity roots of the source walk; what it never enters holds no root that could matter, so the finder skips it too. */
function sourceUnityRoots(root) {
  return findUnityProjectRoots(root, 4, { skip: outsideSources(root) });
}

function collectSources(root, unityRoots = sourceUnityRoots(root)) {
  const result = [];
  const outside = outsideSources(root);
  function visit(dir, depth) {
    if (depth > 4) return;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      if (
        entry.isSymbolicLink() ||
        ['.git', '.factory', 'node_modules', 'vendor', 'target', '.venv'].includes(entry.name)
      ) continue;
      const absolute = path.join(dir, entry.name);
      const relative = path.relative(root, absolute).split(path.sep).join('/');
      if (outside(relative) || isUnityGeneratedPath(relative, unityRoots)) continue;
      const unityRelative = relativeWithinUnityProject(relative, unityRoots);
      if (entry.isDirectory()) visit(absolute, depth + 1);
      else if (entry.isFile() && (
        SOURCE_NAMES.has(entry.name) || /\.csproj$/.test(entry.name) ||
        (unityRelative && UNITY_PACKAGE_FILES.has(unityRelative.path))
      )) result.push(absolute);
    }
  }
  visit(root, 0); return result.sort();
}

function generateSbom(rootDir) {
  const root = path.resolve(rootDir);
  if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) throw new Error('SBOM root must be an existing directory');
  const components = new Map(); const sources = [];
  const unityRoots = sourceUnityRoots(root);
  for (const file of collectSources(root, unityRoots)) {
    const relative = path.relative(root, file).split(path.sep).join('/'); const buffer = fs.readFileSync(file); const text = buffer.toString('utf8');
    const unityRelative = relativeWithinUnityProject(relative, unityRoots);
    sources.push({ path: relative, sha256: sha256(buffer) });
    const name = path.basename(file);
    if (name === 'package.json') packageJson(file, components, relative);
    else if (['package-lock.json', 'npm-shrinkwrap.json'].includes(name)) packageLock(file, components, relative);
    else if (name === 'yarn.lock') yarnLock(text, components, relative);
    else if (name === 'pnpm-lock.yaml') pnpmLock(text, components, relative);
    else if (['composer.json', 'composer.lock'].includes(name)) composer(file, components, relative);
    else if (name === 'requirements.txt') requirements(text, components, relative);
    else if (['pyproject.toml', 'poetry.lock'].includes(name)) pythonToml(text, components, relative);
    else if (name === 'Pipfile.lock') pipfileLock(file, components, relative);
    else if (name === 'go.mod') goMod(text, components, relative);
    else if (name === 'Cargo.lock') cargoLock(text, components, relative);
    else if (name === 'Cargo.toml') cargoToml(text, components, relative);
    else if (/\.csproj$/.test(name)) dotnet(text, components, relative);
    else if (name === 'packages.lock.json') dotnetLock(file, components, relative);
    else if (name === 'pom.xml') maven(text, components, relative);
    else if (name === 'gradle.lockfile') gradleLock(text, components, relative);
    else if (['build.gradle', 'build.gradle.kts'].includes(name)) gradle(text, components, relative);
    else if (unityRelative && UNITY_PACKAGE_FILES.has(unityRelative.path)) unityPackages(file, components, relative);
    else if (name === 'Gemfile.lock') gemLock(text, components, relative);
    else if (name === 'Gemfile') gemfile(text, components, relative);
  }
  const sorted = [...components.values()].sort((a, b) => a.name.localeCompare(b.name) || a.version.localeCompare(b.version) || a.scope.localeCompare(b.scope));
  const serial = stableDigest({ components: sorted, sources });
  return { bomFormat: 'CycloneDX', specVersion: '1.5', serialNumber: `urn:uuid:${serial.slice(0, 8)}-${serial.slice(8, 12)}-${serial.slice(12, 16)}-${serial.slice(16, 20)}-${serial.slice(20, 32)}`, version: 1, metadata: { sources }, components: sorted };
}

module.exports = { collectSources, generateSbom };
