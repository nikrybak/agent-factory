'use strict';

// Edit-path rules of the hook dispatcher (owner order 2026-10-26, ADR-0028 section "Edits"): files are changed with the
// Edit tool, not with inline interpreter code, heredocs or ad-hoc read-replace-write scripts. A script is the tool for
// ONE mechanical change across 10+ files, written to a file with the marker `mass-edit: <reason>`.
//
// Ad hoc means outside version control: a script inside a Git work tree is reviewed with the diff, so repository
// generators, build scripts and tests keep running. Reference implementation: edit_guard.py (parity tested).

const fs = require('node:fs');
const path = require('node:path');
const { lower, unitsOf, interpreterInfo } = require('./secret_rules');

const ADVICE = 'use the Edit tool (rg -n anchor, Read offset/limit, Edit); a script only for one change across 10+ files, '
  + 'written to a file with the marker `# mass-edit: <reason>`';
const INLINE_REASON = `inline interpreter code that writes files: ${ADVICE}`;
const POWERSHELL_REASON = `a PowerShell read-replace-write of a file: ${ADVICE}`;
const HEREDOC_REASON = `a heredoc redirected into a file of a Git work tree: ${ADVICE}`;
const SCRIPT_REASON = `an ad-hoc edit script (reads, replaces and writes files) without the \`mass-edit:\` marker: ${ADVICE}`;

const WRITE_INTERPRETERS = new Set(['python', 'python3', 'py', 'pythonw', 'node', 'deno', 'bun', 'perl', 'ruby']);
const SCRIPT_RUNNERS = new Set([...WRITE_INTERPRETERS, 'pwsh', 'powershell']);
const SCRIPT_EXTENSIONS = ['.py', '.js', '.mjs', '.cjs', '.ts', '.ps1', '.pl', '.rb'];
const SCRIPT_LIMIT = 512 * 1024;
const MARKER = 'mass-edit:';

const WRITE_CODE = new RegExp([
  String.raw`open\([^)]*,[ \t]*(?:mode[ \t]*=[ \t]*)?['"][rbt]*[wax+]`, String.raw`\.write_text\(`, String.raw`\.write_bytes\(`,
  String.raw`\.writelines\(`, String.raw`(?<!stdout)(?<!stderr)\.write\(`, 'writefilesync', String.raw`writefile\(`,
  'appendfilesync', String.raw`appendfile\(`, 'createwritestream', String.raw`file\.open\([^)]*['"][wa]`,
  String.raw`open[ \t]*\(?[ \t]*(?:my[ \t]+)?[$a-z_]+[ \t]*,[ \t]*['"][ \t]*\+?>`, String.raw`fileinput\.input\([^)]*inplace`,
].join('|'));
const SCRIPT_WRITE = new RegExp(`${WRITE_CODE.source}|set-content|out-file|add-content|writealltext|writealllines`);
const SCRIPT_READ = new RegExp(String.raw`open\(|read_text\(|read_bytes\(|\.read\(|readfilesync|readfile\(|get-content|readalltext|readalllines|fileinput\.input`);
const SCRIPT_REPLACE = new RegExp(String.raw`\.replace\(|\.replaceall\(|\.subn?\(|-replace|gsub`);
const PERL_IN_PLACE = /^-[a-zA-Z0-9]*i/;
const PS_WRITERS = new Set(['set-content', 'add-content', 'out-file']);
const PS_WRITE_FRAGMENTS = [']::writealltext(', ']::writealllines(', ']::appendalltext(', ']::writeallbytes('];
const PS_READ_FRAGMENTS = ['-replace', '.replace(', 'get-content', ']::readall'];
const PS_PATH_FLAGS = ['-path', '-filepath', '-literalpath', '-pspath'];
const PS_VALUE_FLAGS = ['-encoding', '-value', '-width', '-delimiter', '-stream', '-filter', '-include', '-exclude'];
const REDIRECT = /(?:^|[^0-9&>])>>?[ \t]*['"]?([^ \t'"|;&<>()]+)/g;

/** True when `text` reads a file, replaces text and writes a file, and carries no mass-edit marker. */
function isEditScript(text) {
  const low = lower(text);
  return !low.includes(MARKER) && SCRIPT_READ.test(low) && SCRIPT_REPLACE.test(low) && SCRIPT_WRITE.test(low);
}

/** An absolute path for `target` (Git Bash /c/x spelling accepted) relative to `cwd`. */
function resolveIn(cwd, target) {
  const drive = process.platform === 'win32' ? /^\/([a-zA-Z])\//.exec(target) : null;
  return path.resolve(cwd, drive ? `${drive[1]}:/${target.slice(3)}` : target);
}

/** True when a `.git` entry exists in the folder of `file` or above it. */
function inWorkTree(file) {
  let dir = path.dirname(file);
  for (;;) {
    if (fs.existsSync(path.join(dir, '.git'))) return true;
    const parent = path.dirname(dir);
    if (parent === dir) return false;
    dir = parent;
  }
}

/** The text of a small existing regular file, or null. */
function readSmall(file) {
  try {
    const stat = fs.statSync(file);
    if (!stat.isFile() || stat.size > SCRIPT_LIMIT) return null;
    return fs.readFileSync(file, 'utf8');
  } catch {
    return null;
  }
}

const isFile = file => {
  try {
    return fs.statSync(file).isFile();
  } catch {
    return false;
  }
};

function powershellTarget(unit) {
  const args = unit.tokens.slice(unit.program.index + 1);
  for (let i = 0; i < args.length; i += 1) {
    const flag = lower(args[i]);
    if (PS_PATH_FLAGS.includes(flag)) return args[i + 1] || null;
    if (args[i].startsWith('-')) {
      if (PS_VALUE_FLAGS.includes(flag)) i += 1;
      continue;
    }
    return args[i];
  }
  return null;
}

function commandReasons(command, cwd) {
  const reasons = [];
  const add = reason => { if (!reasons.includes(reason)) reasons.push(reason); };
  const units = unitsOf(command);
  const low = lower(command);
  for (const unit of units) {
    const name = unit.program.name;
    if (!SCRIPT_RUNNERS.has(name)) continue;
    const info = interpreterInfo(unit.tokens, unit.program.index, name);
    if (name === 'perl' && unit.tokens.slice(unit.program.index + 1).some(token => PERL_IN_PLACE.test(token))) add(INLINE_REASON);
    if (info.inline) {
      if (WRITE_INTERPRETERS.has(name) && WRITE_CODE.test(low)) add(INLINE_REASON);
      continue;
    }
    if (!info.script || !SCRIPT_EXTENSIONS.some(ext => lower(info.script).endsWith(ext))) continue;
    const file = resolveIn(cwd, info.script);
    if (!isFile(file) || inWorkTree(file)) continue; // repository scripts are never read: one stat and a short walk
    const text = readSmall(file);
    if (text !== null && isEditScript(text)) add(SCRIPT_REASON);
  }
  const writes = units.some(unit => PS_WRITERS.has(unit.program.name)) || PS_WRITE_FRAGMENTS.some(fragment => low.includes(fragment));
  if (writes) {
    const reads = PS_READ_FRAGMENTS.some(fragment => low.includes(fragment))
      || units.some(unit => ['gc', 'cat', 'type'].includes(unit.program.name));
    if (reads) add(POWERSHELL_REASON);
    for (const unit of units) {
      if (!PS_WRITERS.has(unit.program.name)) continue;
      const target = powershellTarget(unit);
      if (target) {
        const file = resolveIn(cwd, target);
        if (isFile(file) && inWorkTree(file)) add(POWERSHELL_REASON);
      }
    }
  }
  if (command.includes('<<')) {
    for (const line of command.split('\n')) {
      if (!line.includes('<<')) continue;
      for (const match of line.matchAll(REDIRECT)) {
        const file = resolveIn(cwd, match[1]);
        if (isFile(file) && inWorkTree(file)) add(HEREDOC_REASON);
      }
    }
  }
  return reasons;
}

/** The edit-path reasons to block a call (empty: allowed). */
function violations(toolName, toolInput, cwd = process.cwd()) {
  if (toolInput === null || typeof toolInput !== 'object' || Array.isArray(toolInput)) return [];
  if (toolName === 'Bash' || toolName === 'PowerShell') {
    return typeof toolInput.command === 'string' ? commandReasons(toolInput.command, cwd) : [];
  }
  if (toolName === 'Write') {
    const target = toolInput.file_path;
    const content = toolInput.content;
    if (typeof target !== 'string' || !target || typeof content !== 'string') return [];
    if (!SCRIPT_EXTENSIONS.some(ext => lower(target).endsWith(ext))) return [];
    const file = resolveIn(cwd, target);
    if (fs.existsSync(file) || inWorkTree(file)) return [];
    return isEditScript(content) ? [SCRIPT_REASON] : [];
  }
  return [];
}

module.exports = { violations, isEditScript, inWorkTree, resolveIn, ADVICE };
