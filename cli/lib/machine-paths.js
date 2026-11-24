'use strict';

/**
 * Detect host-specific paths in tracked Factory City metadata.
 *
 * REQ-CF-002 keeps child source/output local, so those ignored trees are not
 * scanned. The registry and local skill manifest remain in scope because they
 * are shared instructions and must work after a clean clone.
 */

const fs = require('node:fs');
const path = require('node:path');

const SCANNED_EXT = new Set(['.md', '.js', '.mjs', '.cjs', '.json', '.py', '.ts', '.yml', '.yaml', '.ps1', '.sh', '.txt']);
// `.claude/worktrees`: agents' git worktrees inside the base (ignored by git) - whole copies of the repository, never shared
// metadata of this checkout; scanning them reported every machine path of their copied skills as this tree's own.
const SKIP_DIRS = new Set(['.git', 'node_modules', 'vendor', '.venv', '__pycache__', 'dist', 'coverage', '.factory', '.claude/skills', '.claude/state', '.claude/worktrees', '.agents/skills']);
const SHARED_HOMES = new Set(['node', 'runner', 'ubuntu', 'user', 'root']);
const ALLOW_MARKER = 'machine-path: ok';
const FILE_OFF_MARKER = 'machine-path-scan: off';
const FILE_OFF_LOOKAHEAD = 20;
const DRIVE = new RegExp('(?<![\\w:])[A-Za-z]:[\\\\/]', 'g');
const POSIX_HOME = new RegExp('/(?:home|Users)/([A-Za-z0-9._-]+)', 'g');

function isSkipped(relativePath) {
  const parts = relativePath.split(/[\\/]/);
  for (let index = 0; index < parts.length; index += 1) {
    if (SKIP_DIRS.has(parts[index]) || SKIP_DIRS.has(parts.slice(index, index + 2).join('/'))) return true;
  }
  if (parts[0] === 'app_entry_root' && parts.length > 2 && parts[1] !== '_registry') return true;
  if (parts[0] === 'skills' && !(parts.length === 2 && parts[1] === 'REGISTRY.json')) return true;
  // Test fixtures deliberately model foreign machines and are not shared
  // Factory City metadata. Scan the implementation and generated contracts,
  // not literal fixture data used to verify parser behavior.
  if (parts[0] === 'cli' && parts[1] === 'test') return true;
  return false;
}

function isPlaceholder(line, index) {
  const tail = line.slice(index, index + 48);
  return tail.includes('...') || tail.includes('…') || /[<>]/.test(tail) || /\bpath[\\/]to\b/i.test(tail);
}

function findInLine(line) {
  if (line.includes(ALLOW_MARKER)) return [];
  const hits = [];
  for (const match of line.matchAll(DRIVE)) {
    if (!isPlaceholder(line, match.index)) hits.push(match[0]);
  }
  for (const match of line.matchAll(POSIX_HOME)) {
    if (SHARED_HOMES.has(match[1]) || isPlaceholder(line, match.index)) continue;
    hits.push(match[0]);
  }
  return hits;
}

function scanMachinePaths(root, options = {}) {
  const selfSkip = new Set(options.selfSkip ?? ['cli/lib/machine-paths.js', 'cli/test/machine-paths.test.js']);
  const findings = [];
  const walk = directory => {
    let entries;
    try { entries = fs.readdirSync(directory, { withFileTypes: true }); }
    catch { return; }
    for (const entry of entries) {
      const absolute = path.join(directory, entry.name);
      const relative = path.relative(root, absolute).split(path.sep).join('/');
      if (isSkipped(relative)) continue;
      if (entry.isDirectory()) {
        walk(absolute);
        continue;
      }
      if (!SCANNED_EXT.has(path.extname(entry.name)) || selfSkip.has(relative)) continue;
      let text;
      try { text = fs.readFileSync(absolute, 'utf8'); }
      catch { continue; }
      const lines = text.split(/\r?\n/);
      if (lines.slice(0, FILE_OFF_LOOKAHEAD).some(line => line.includes(FILE_OFF_MARKER))) continue;
      lines.forEach((line, index) => {
        for (const hit of findInLine(line)) {
          findings.push({ file: relative, line: index + 1, hit, text: line.trim().slice(0, 160) });
        }
      });
    }
  };
  walk(root);
  return findings;
}

module.exports = { scanMachinePaths, findInLine };
