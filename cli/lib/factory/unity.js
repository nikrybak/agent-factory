'use strict';
/** @implements REQ-FK-011 Unity project roots and generated/module ownership boundaries. */

const fs = require('node:fs');
const path = require('node:path');
const { DEFAULT_IGNORES } = require('./paths');

const UNITY_PROJECT_MARKER = 'ProjectSettings/ProjectVersion.txt';
/** How deep findUnityProjectRoots (and the tree hash, which follows the same rules) looks for a project root. */
const UNITY_ROOT_DEPTH = 6;
const UNITY_GENERATED_DIRS = new Set([
  'Library', 'Logs', 'Temp', 'Obj', 'Build', 'Builds', 'UserSettings', '.utmp',
]);

function toPosix(value) {
  return value.split(path.sep).join('/');
}

/**
 * Whether `dir`, whose `entries` were just listed, holds the project marker. The listing is asked first (one string
 * compare instead of a file system call per directory); the name compare ignores case, so a case-insensitive file
 * system still decides exactly as the plain existsSync did.
 */
function hasUnityMarker(dir, entries) {
  return entries.some(entry => entry.name.toLowerCase() === 'projectsettings')
    && fs.existsSync(path.join(dir, UNITY_PROJECT_MARKER));
}

/**
 * Unity project roots below `rootDir`, as posix paths relative to it. `skip(relative)` prunes directories the
 * caller never reads (the tree hash passes its own exclusions, so local child repositories are not walked).
 */
function findUnityProjectRoots(rootDir, maxDepth = UNITY_ROOT_DEPTH, { skip = () => false } = {}) {
  const root = path.resolve(rootDir);
  const found = [];

  function visit(dir, depth) {
    if (depth > maxDepth) return;
    const relativeDir = toPosix(path.relative(root, dir)) || '.';
    const entries = fs.readdirSync(dir, { withFileTypes: true })
      .sort((left, right) => left.name.localeCompare(right.name));
    const unityRoot = hasUnityMarker(dir, entries);
    if (unityRoot) found.push(relativeDir);

    for (const entry of entries) {
      if (!entry.isDirectory() || entry.isSymbolicLink() || DEFAULT_IGNORES.has(entry.name)) continue;
      if (unityRoot && UNITY_GENERATED_DIRS.has(entry.name)) continue;
      if (skip(relativeDir === '.' ? entry.name : `${relativeDir}/${entry.name}`)) continue;
      visit(path.join(dir, entry.name), depth + 1);
    }
  }

  visit(root, 0);
  return [...new Set(found)].sort();
}

function relativeWithinUnityProject(relative, unityRoots) {
  const normalized = relative.replace(/\\/g, '/');
  const candidates = unityRoots
    .filter(root => root === '.' || normalized === root || normalized.startsWith(`${root}/`))
    .sort((left, right) => right.length - left.length);
  if (!candidates.length) return null;
  const root = candidates[0];
  return {
    root,
    path: root === '.' ? normalized : normalized.slice(root.length + 1),
  };
}

function isUnityGeneratedPath(relative, unityRoots) {
  const match = relativeWithinUnityProject(relative, unityRoots);
  if (!match || !match.path) return false;
  return UNITY_GENERATED_DIRS.has(match.path.split('/')[0]);
}

function unityRootForMarker(relative, unityRoots) {
  const match = relativeWithinUnityProject(relative, unityRoots);
  return match && match.path === UNITY_PROJECT_MARKER ? match.root : null;
}

module.exports = {
  UNITY_GENERATED_DIRS,
  UNITY_PROJECT_MARKER,
  UNITY_ROOT_DEPTH,
  hasUnityMarker,
  findUnityProjectRoots,
  isUnityGeneratedPath,
  relativeWithinUnityProject,
  unityRootForMarker,
};
