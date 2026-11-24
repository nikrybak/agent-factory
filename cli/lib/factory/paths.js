'use strict';
/** @implements REQ-FK-011 Canonical root identity shared by manifest validation and detection. */
const fs = require('node:fs');
const path = require('node:path');

const DEFAULT_IGNORES = new Set(['.git', '.hg', '.svn', 'node_modules', 'vendor', 'target', 'dist', 'build', '.next', '.venv', 'venv', '__pycache__']);

function normalizeRelativeRoot(value) {
  if (typeof value !== 'string' || !value) return '.';
  return path.posix.normalize(value.replaceAll('\\', '/')).replace(/\/$/, '') || '.';
}

function resolveInside(rootDir, candidate, options = {}) {
  if (path.isAbsolute(candidate)) throw new Error('project path must be relative');
  const root = path.resolve(rootDir);
  const resolved = path.resolve(root, candidate);
  const relative = path.relative(root, resolved);
  if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error(`path is outside project root: ${candidate}`);
  }
  const rootReal = fs.existsSync(root) ? fs.realpathSync(root) : root;
  let ancestor = resolved;
  while (!fs.existsSync(ancestor) && ancestor !== path.dirname(ancestor)) ancestor = path.dirname(ancestor);
  if (fs.existsSync(ancestor)) {
    const ancestorReal = fs.realpathSync(ancestor);
    const realRelative = path.relative(rootReal, ancestorReal);
    if (realRelative === '..' || realRelative.startsWith(`..${path.sep}`) || path.isAbsolute(realRelative)) {
      throw new Error(`path is outside project root through symlink: ${candidate}`);
    }
  }
  if (!options.allowRoot && relative === '') return resolved;
  return resolved;
}

function walkFiles(rootDir, options = {}) {
  const root = path.resolve(rootDir);
  const maxDepth = Number.isInteger(options.maxDepth) ? options.maxDepth : 6;
  const ignores = new Set([...DEFAULT_IGNORES, ...(options.ignore || [])]);
  const files = [];
  function visit(dir, depth) {
    if (depth > maxDepth) return;
    const entries = fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      if (entry.isSymbolicLink() || ignores.has(entry.name)) continue;
      const absolute = path.join(dir, entry.name);
      const relative = path.relative(root, absolute).split(path.sep).join('/');
      if (options.exclude && options.exclude(relative, entry)) continue;
      if (entry.isDirectory()) visit(absolute, depth + 1);
      else if (entry.isFile()) files.push(relative);
    }
  }
  visit(root, 0);
  return files.sort();
}

module.exports = { DEFAULT_IGNORES, normalizeRelativeRoot, resolveInside, walkFiles };
