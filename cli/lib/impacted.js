'use strict';

/**
 * Impacted-tests selector (ADR-0021): from the files changed in a repository, compute the Cargo
 * packages and Gradle modules whose tests must run — the changed ones plus every workspace member
 * that depends on them. Agents run exactly this set; the coordinator runs full suites.
 *
 * Shared inputs (workspace manifests, lockfiles, toolchain, migrations, query metadata) select
 * everything, because any test may observe them.
 */

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const CARGO_SHARED = [/^Cargo\.(toml|lock)$/, /^rust-toolchain(\.toml)?$/, /^\.cargo\//, /^migrations\//, /^\.sqlx\//];
const GRADLE_SHARED = [/^settings\.gradle(\.kts)?$/, /^build\.gradle(\.kts)?$/, /^gradle\//, /^gradle\.properties$/, /^buildSrc\//];

function git(repo, args) {
  const result = spawnSync('git', ['-C', repo, ...args], { encoding: 'utf8', shell: false });
  if (result.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${(result.stderr || '').trim()}`);
  return result.stdout;
}

/** Files changed against `base` (committed, staged, unstaged and untracked), repo-relative with `/`. */
function changedFiles(repo, base) {
  const files = new Set();
  const add = text => text.split('\n').map(line => line.trim()).filter(Boolean).forEach(file => files.add(file.replace(/\\/g, '/')));
  // `--relative` keeps paths relative to (and limited to) `repo` when it is a subdirectory of a repository.
  if (base) add(git(repo, ['diff', '--relative', '--name-only', `${base}...HEAD`]));
  add(git(repo, ['diff', '--relative', '--name-only', 'HEAD']));
  add(git(repo, ['ls-files', '--others', '--exclude-standard']));
  return [...files].sort();
}

/** Workspace members as `{ name, dir, deps }` (dir repo-relative, deps = names of path dependencies). */
function cargoMembers(repo, run = spawnSync) {
  const result = run('cargo', ['metadata', '--format-version', '1', '--no-deps', '--offline'], { cwd: repo, encoding: 'utf8', shell: false, maxBuffer: 64 * 1024 * 1024 });
  if (result.status !== 0) throw new Error(`cargo metadata failed: ${(result.stderr || '').trim().slice(0, 300)}`);
  const metadata = JSON.parse(result.stdout);
  const root = path.resolve(metadata.workspace_root);
  const dirToName = new Map();
  const members = metadata.packages.map(pkg => {
    const dir = path.relative(root, path.dirname(pkg.manifest_path)).replace(/\\/g, '/');
    dirToName.set(path.resolve(path.dirname(pkg.manifest_path)), pkg.name);
    return { name: pkg.name, dir, pathDeps: pkg.dependencies.filter(dep => dep.path).map(dep => path.resolve(dep.path)) };
  });
  return members.map(member => ({ name: member.name, dir: member.dir, deps: member.pathDeps.map(dep => dirToName.get(dep)).filter(Boolean) }));
}

/** Gradle modules from `settings.gradle(.kts)` includes and their `project(":x")` dependencies. */
function gradleModules(repo) {
  const settings = ['settings.gradle.kts', 'settings.gradle'].map(file => path.join(repo, file)).find(file => fs.existsSync(file));
  if (!settings) return [];
  const text = fs.readFileSync(settings, 'utf8');
  const names = [...text.matchAll(/include\s*\(?\s*((?:["']:?[\w.-]+(?::[\w.-]+)*["']\s*,?\s*)+)\)?/g)]
    .flatMap(match => [...match[1].matchAll(/["'](:?[\w.:-]+)["']/g)].map(name => (name[1].startsWith(':') ? name[1] : `:${name[1]}`)));
  return names.map(name => {
    const dir = name.slice(1).replace(/:/g, '/');
    const build = ['build.gradle.kts', 'build.gradle'].map(file => path.join(repo, dir, file)).find(file => fs.existsSync(file));
    const deps = build ? [...fs.readFileSync(build, 'utf8').matchAll(/project\(\s*(?:path\s*=\s*)?["'](:[\w.:-]+)["']/g)].map(match => match[1]) : [];
    return { name, dir, deps };
  });
}

function owner(file, members) {
  let best = null;
  for (const member of members) {
    const prefix = member.dir ? `${member.dir}/` : '';
    if ((prefix === '' || file.startsWith(prefix)) && (!best || member.dir.length > best.dir.length)) best = member;
  }
  return best;
}

/** Members owning a changed file plus every member that (transitively) depends on them. */
function closure(changed, members) {
  const selected = new Set(changed);
  let grew = true;
  while (grew) {
    grew = false;
    for (const member of members) {
      if (!selected.has(member.name) && member.deps.some(dep => selected.has(dep))) {
        selected.add(member.name);
        grew = true;
      }
    }
  }
  return members.map(member => member.name).filter(name => selected.has(name));
}

function select(files, members, shared) {
  if (!members.length) return null;
  if (files.some(file => shared.some(pattern => pattern.test(file)))) return { all: true, members: members.map(m => m.name) };
  const direct = new Set();
  for (const file of files) {
    const member = owner(file, members);
    if (member && (member.dir !== '' || members.length === 1)) direct.add(member.name);
  }
  return { all: false, members: closure([...direct], members) };
}

/** Android flavors whose own source sets changed; `shared` when `src/main` or `src/test` changed. */
function flavors(files) {
  const found = new Set();
  for (const file of files) {
    const match = file.match(/(?:^|\/)src\/(main|test|androidTest|test([A-Z]\w*)|([a-z]\w*))\//);
    if (!match) continue;
    if (match[1] === 'main' || match[1] === 'test' || match[1] === 'androidTest') found.add('shared');
    else if (match[2]) found.add(match[2][0].toLowerCase() + match[2].slice(1));
    else found.add(match[3]);
  }
  return [...found].sort();
}

function impacted(repo, { base, run } = {}) {
  const files = changedFiles(repo, base);
  const hasCargo = fs.existsSync(path.join(repo, 'Cargo.toml'));
  const cargo = hasCargo ? select(files, cargoMembers(repo, run), CARGO_SHARED) : null;
  const gradle = select(files, gradleModules(repo), GRADLE_SHARED);
  return { files: files.length, cargo, gradle, flavors: flavors(files) };
}

function cargoArgs(selection) {
  if (!selection) return null;
  return selection.all ? '--workspace' : selection.members.map(name => `-p ${name}`).join(' ');
}

const USAGE = 'usage: infra impacted [--repo DIR] [--base REF] [--json]';

function impactedMain(args, { cwd = process.cwd(), out = console.log, err = console.error, run } = {}) {
  const value = name => { const index = args.indexOf(name); return index >= 0 ? args[index + 1] : undefined; };
  if (args.includes('--help')) { out(USAGE); return 0; }
  const repo = path.resolve(cwd, value('--repo') || '.');
  let report;
  try {
    report = impacted(repo, { base: value('--base'), run });
  } catch (error) {
    err(`[impacted] ${error.message}`);
    return 1;
  }
  if (args.includes('--json')) { out(JSON.stringify({ ...report, cargoArgs: cargoArgs(report.cargo) }, null, 2)); return 0; }
  out(`[impacted] ${report.files} changed file(s)`);
  if (report.cargo) out(`cargo: ${report.cargo.members.length ? cargoArgs(report.cargo) : '(nothing)'}`);
  if (report.gradle) out(`gradle: ${report.gradle.all ? 'all modules' : report.gradle.members.join(' ') || '(nothing)'}`);
  if (report.flavors.length) out(`android source sets: ${report.flavors.join(' ')} (shared → test one flavor)`);
  return 0;
}

module.exports = { USAGE, cargoArgs, cargoMembers, changedFiles, closure, flavors, gradleModules, impacted, impactedMain, owner, select };
