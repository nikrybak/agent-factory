#!/usr/bin/env node
'use strict';

// One-process-per-event hook dispatcher for Claude Code (ADR-0027). Events: pre (PreToolUse), post (PostToolUse),
// prompt (UserPromptSubmit), stop, task (TaskCompleted).
//
// It runs the checks that secrets_guard.py, pretool_guard.py, posttool_audit.py, user_prompt_submit.py,
// stop_quality_gate.py and task_completed_gate.py ran as six separate Python processes, in ONE Node process started
// from PATH (no interpreter shim, no machine path). The Python modules stay in the repository as the reference
// implementation: tests/test_hook_dispatch.py compares this file with them on a corpus and on thousands of random
// commands, so every call is blocked or allowed exactly as before. Exit code 2 blocks the call (stderr is for the
// agent); any other failure exits 0 and never blocks work by accident, like the Python hooks.
//
// Python-compatible regexes: Python's \s, \w, \b, . and $ differ from JavaScript's. py() rewrites them (Unicode
// whitespace and word characters, "." not matching only "\n") so the same pattern text gives the same matches.

const fs = require('node:fs');
const path = require('node:path');
const secretRules = require('./secret_rules');
// Loaded only for the tools it inspects (Bash, PowerShell, Write): parsing a module costs about a millisecond cold.
let editModule = null;
const editRules = () => editModule || (editModule = require('./edit_rules'));
const EDIT_GUARDED = ['Bash', 'PowerShell', 'Write'];

const WORD = '\\p{L}\\p{N}_';
const SPACE = '\\t\\n\\v\\f\\r \\x1c-\\x1f\\x85\\xa0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000';

function py(source, flags = '') {
  let out = '';
  let inClass = false;
  for (let i = 0; i < source.length; i += 1) {
    const c = source[i];
    if (c === '\\') {
      const n = source[i + 1];
      i += 1;
      if (n === 's') out += inClass ? SPACE : `[${SPACE}]`;
      else if (n === 'S') out += `[^${SPACE}]`;
      else if (n === 'w') out += inClass ? WORD : `[${WORD}]`;
      else if (n === 'b') out += `(?:(?<=[${WORD}])(?![${WORD}])|(?<![${WORD}])(?=[${WORD}]))`;
      else out += c + n;
    } else if (c === '[' && !inClass) {
      inClass = true;
      out += c;
      if (source[i + 1] === '^') { out += '^'; i += 1; }
    } else if (c === ']' && inClass) {
      inClass = false;
      out += c;
    } else if (c === '.' && !inClass) {
      out += '[^\\n]';
    } else {
      out += c;
    }
  }
  return new RegExp(out, `${flags}u`);
}

/** A regex compiled on first use: the \p{L} classes cost ~15 ms to build, and most calls need none of them. */
function lazy(source, flags = '') {
  let regex = null;
  return () => regex || (regex = py(source, flags));
}
const ASCII = /^[\x00-\x7f]*$/;

// ---- secrets_guard.py -----------------------------------------------------------------------------------------------
const SECRET_PATH = lazy(String.raw`(^|[\\/\s'"=:])\.secrets([\\/\s'"]|$)`, 'i');
const VAULT_FILE = lazy(String.raw`(?<![\w.-])(global|test)\.env(?![\w.])`, 'i');
const RECURSIVE_GREP = lazy(String.raw`(^|[\s;|&(\x60])(e|f)?grep\s+(?:[^|;&]*\s)?(-[a-zA-Z]*[rR][a-zA-Z]*|--recursive|--dereference-recursive)(\s|=|$)`);
const NO_IGNORE = lazy(String.raw`(^|[\s;|&(\x60])rg\s+(?:[^|;&]*\s)?(-[a-zA-Z]*u[a-zA-Z]*|--no-ignore\S*|--unrestricted)(\s|$)|git\s+grep\s+(?:[^|;&]*\s)?--no-exclude-standard`);
const PATH_FIELDS = ['file_path', 'path', 'notebook_path', 'pattern', 'glob'];

const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);
/** Python truthiness of a JSON value. */
const truthy = value => !(value === undefined || value === null || value === false || value === 0 || value === '' ||
  (Array.isArray(value) && value.length === 0) || (isObject(value) && Object.keys(value).length === 0));
/** Python str() of a JSON value, as far as the patterns can tell. */
const pyStr = value => (typeof value === 'string' ? value : value === true ? 'True' : value === false ? 'False' : value === null ? 'None' : String(value));

// Fast paths: the patterns below can only match text that contains a literal fragment (".secrets", "grep", ...), so a
// call without one is allowed without compiling any regex. Non-ASCII text always takes the regex (Unicode case folding
// lets other characters stand in for letters). The parity tests prove the shortcut never changes a verdict.
const SPACE_CHAR = new RegExp(`[${SPACE}]`, 'u');
const SECRET_FRAGMENT = /\.secrets|global\.env|test\.env/i;

/** A conservative superset of NO_IGNORE's `rg` branch: an `rg` word followed later by a flag word with "u" or --no-ignore. */
function rgCandidate(command) {
  let index = command.indexOf('rg');
  while (index !== -1) {
    const before = index === 0 ? ' ' : command[index - 1];
    const after = command[index + 2];
    if ((';|&(`'.includes(before) || SPACE_CHAR.test(before)) && after !== undefined && SPACE_CHAR.test(after)) {
      for (const token of command.slice(index + 2).split(SPACE_CHAR)) {
        if (token.startsWith('-') && (token.includes('u') || token.startsWith('--no-ignore'))) return true;
      }
    }
    index = command.indexOf('rg', index + 1);
  }
  return false;
}

function secretViolations(toolName, toolInput) {
  if (!isObject(toolInput)) return [];
  const found = [];
  const texts = PATH_FIELDS.filter(field => truthy(toolInput[field])).map(field => pyStr(toolInput[field]));
  const command = toolName === 'Bash' || toolName === 'PowerShell' ? toolInput.command : null;
  if (typeof command === 'string') {
    texts.push(command.includes('secret.js') ? secretRules.legacyText(command) : command);
    const grep = command.includes('grep');
    if (grep && RECURSIVE_GREP().test(command)) found.push('recursive grep ignores .gitignore and reads secret overlays; use `rg` or `git grep`');
    if ((grep || rgCandidate(command)) && NO_IGNORE().test(command)) found.push('searching with ignore rules switched off can read secret overlays');
  }
  for (const text of texts) {
    if ((!ASCII.test(text) || SECRET_FRAGMENT.test(text)) && (SECRET_PATH().test(text) || VAULT_FILE().test(text))) {
      found.push('secret overlays (.secrets/, global.env, test.env) are owner-only; never read, search or write them');
      break;
    }
  }
  for (const reason of secretRules.violations(toolName, toolInput)) if (!found.includes(reason)) found.push(reason);
  return found;
}

// ---- pretool_guard.py -----------------------------------------------------------------------------------------------
const BLOCKED_SOURCES = [
  String.raw`rm\s+-rf\s+[/~.]`, String.raw`sudo\s+rm`, String.raw`del\s+/s\s+/q`, String.raw`format\s+[a-z]:`,
  String.raw`git\s+reset\s+--hard`, String.raw`git\s+clean\s+-fd`, String.raw`curl\s+.*\|\s*sh`, String.raw`wget\s+.*\|\s*sh`,
  String.raw`npm\s+publish`, String.raw`gh\s+pr\s+merge`,
];
let blockedList = null;
const blocked = () => blockedList || (blockedList = BLOCKED_SOURCES.map(source => ({ source, regex: py(source) })));
const POLLING = lazy(String.raw`\b(until|while)\b[^\n]*?;\s*do\b[^]*?\bsleep\b`);
const FOLLOW_WAIT = lazy(String.raw`\btail\b[^|;&\n]*\s(?:-[a-zA-Z]*[fF][a-zA-Z]*|--follow\S*)(?=\s|$)[^|;&\n]*\|`);
const QUALITY_SOURCES = [
  String.raw`git\s+(?:-C\s+\S+\s+)?commit`, String.raw`git\s+(?:-C\s+\S+\s+)?push`, String.raw`gh\s+pr\s+create`,
  String.raw`gh\s+release\s`, String.raw`npm\s+version`, String.raw`docker\s+push`,
];
let qualityList = null;
const quality = () => qualityList || (qualityList = QUALITY_SOURCES.map(source => py(source, 'i')));
const GIT_TARGETED = lazy(String.raw`git\s+-c\s+("[^"]+"|'[^']+'|\S+)\s+(commit|push|tag|merge)\b`, 'g');
const GIT_PLAIN = lazy(String.raw`git\s+(?:-c\s+\S+\s+)?(commit|push|tag|merge)\b`, 'g');
// Owner 2026-10-26: the full gate is for releases, not for development (same list as pretool_guard.py RELEASE).
const RELEASE_SOURCES = [
  String.raw`gh\s+release\s`, String.raw`npm\s+version`, String.raw`docker\s+push`, String.raw`git\s+(?:-c\s+\S+\s+)?tag\b`,
  String.raw`git\s+(?:-c\s+\S+\s+)?(?:push|merge)\b[^\n;&|]*\b(?:main|master)\b`, String.raw`git\s+(?:-c\s+\S+\s+)?push\b[^\n;&|]*--tags`,
  String.raw`gh\s+pr\s+(?:create|merge)\b[^\n;&|]*\b(?:main|master)\b`,
];
let releaseList = null;
const releaseTargeted = command => (releaseList || (releaseList = RELEASE_SOURCES.map(source => py(source)))).some(regex => regex.test(command));

/** First word of `text` the way shlex.split (POSIX mode) reads it; throws on an unclosed quote. */
function shlexFirst(text) {
  let word = '';
  let quote = null;
  let started = false;
  for (let i = 0; i < text.length; i += 1) {
    const c = text[i];
    if (quote === "'") {
      if (c === "'") quote = null; else word += c;
    } else if (quote === '"') {
      if (c === '"') quote = null;
      else if (c === '\\' && i + 1 < text.length && (text[i + 1] === '"' || text[i + 1] === '\\')) { i += 1; word += text[i]; }
      else word += c;
    } else if (c === "'" || c === '"') {
      quote = c;
      started = true;
    } else if (c === '\\') {
      if (i + 1 >= text.length) throw new Error('No escaped character');
      i += 1;
      word += text[i];
      started = true;
    } else if (/\s/u.test(c)) {
      if (word || started) return word;
    } else {
      word += c;
      started = true;
    }
  }
  if (quote) throw new Error('No closing quotation');
  return word;
}

/** True when a `git -C` target is a different repository than the base itself. */
function isChildOrOutside(pathText, root) {
  try {
    let raw = pathText[0] === '"' || pathText[0] === "'" ? shlexFirst(pathText) : pathText;
    raw = raw.replace(/^\/([a-zA-Z])\//, '$1:/');
    const flat = value => (process.platform === 'win32' ? value.toLowerCase() : value);
    const target = flat(path.resolve(root, raw));
    const base = flat(path.resolve(root));
    const relative = path.relative(base, target);
    if (path.isAbsolute(relative)) return true; // another drive: outside the base tree
    if (relative === '..' || relative.startsWith(`..${path.sep}`)) return true;
    const parts = relative === '' ? [] : relative.split(path.sep);
    return parts.length >= 3 && parts[0] === 'app_entry_root' && parts[1] !== '_registry' && parts[2] !== '_project';
  } catch {
    return true;
  }
}

function baseTargeted(command, root) {
  if (!quality().some(regex => regex.test(command)) && !releaseTargeted(command)) return false;
  const addressed = [...command.matchAll(GIT_TARGETED())];
  const plain = [...command.matchAll(GIT_PLAIN())];
  const other = quality().slice(2).some(regex => regex.test(command));
  if (other || plain.length > addressed.length) return true;
  return !addressed.every(match => isChildOrOutside(match[1], root));
}

function gatePassed(root) {
  try {
    return JSON.parse(fs.readFileSync(path.join(root, '.claude', 'state', 'quality_gate_passed.json'), 'utf8')).status === 'PASS';
  } catch {
    return false;
  }
}

const DESTRUCTIVE_FRAGMENTS = ['-rf', 'sudo', 'del', 'format', '--hard', 'clean', 'curl', 'wget', 'publish', 'merge'];
const QUALITY_FRAGMENTS = ['commit', 'push', 'create', 'release', 'version', 'tag'];

/** False only when no pretool pattern can possibly match (each one needs one of these literal fragments). */
function bashMayBlock(command, lowered) {
  if (!ASCII.test(command)) return true;
  if (lowered.includes('tail')) return true;
  if (lowered.includes('sleep') && (lowered.includes('until') || lowered.includes('while'))) return true;
  return DESTRUCTIVE_FRAGMENTS.some(fragment => lowered.includes(fragment)) || QUALITY_FRAGMENTS.some(fragment => lowered.includes(fragment));
}

/** A blocking message for the Bash call, or null to allow. */
function bashDecision(payload, root) {
  const toolInput = isObject(payload.tool_input) ? payload.tool_input : {};
  const command = typeof toolInput.command === 'string' ? toolInput.command : payload.command;
  if (typeof command !== 'string') return null;
  const lowered = command.toLowerCase();
  if (!bashMayBlock(command, lowered)) return null;
  for (const { source, regex } of blocked()) {
    if (regex.test(lowered)) {
      return `BLOCKED by pretool_guard.py: dangerous command matched \`${source}\`. Ask user for explicit confirmation and safer plan.`;
    }
  }
  if (FOLLOW_WAIT().test(command)) {
    return 'BLOCKED by pretool_guard.py: `tail -f | …` never exits after a match. Start the job itself in the background and wait for its '
      + 'completion notification, then read the log once (ADR-0021).';
  }
  if (POLLING().test(command) && !truthy(toolInput.run_in_background)) {
    return 'BLOCKED by pretool_guard.py: foreground polling loop. Run the job in the background and wait for its completion '
      + 'notification (ADR-0021).';
  }
  if (releaseTargeted(lowered) && baseTargeted(lowered, root) && !gatePassed(root)) {
    return 'BLOCKED: quality gate has not passed. Run `/mandatory-quality-gate` or `python scripts/quality_gate.py` first.';
  }
  return null;
}

/** The stderr lines and exit code of the PreToolUse event for a parsed payload. */
function preVerdict(payload, root = process.cwd()) {
  if (!isObject(payload)) return { code: 0, messages: [] };
  const toolName = payload.tool_name === undefined ? '' : payload.tool_name;
  const toolInput = payload.tool_input === undefined ? {} : payload.tool_input;
  const messages = [];
  const reasons = secretViolations(toolName, toolInput);
  if (reasons.length) messages.push(`BLOCKED by secrets_guard.py: ${reasons.join('; ')}`);
  const cwd = typeof payload.cwd === 'string' && payload.cwd ? payload.cwd : root;
  const edits = EDIT_GUARDED.includes(toolName) ? editRules().violations(toolName, toolInput, cwd) : [];
  if (edits.length) messages.push(`BLOCKED by edit_guard.py: ${edits.join('; ')}`);
  if (toolName === 'Bash') {
    const message = bashDecision(payload, root);
    if (message) messages.push(message);
  }
  return { code: messages.length ? 2 : 0, messages };
}

// ---- posttool_audit.py ----------------------------------------------------------------------------------------------
/** The nearest existing ancestor is resolved through links, the rest appended (Path.resolve, non-strict). */
function resolveLoose(target) {
  let current = path.resolve(target);
  const rest = [];
  for (;;) {
    try {
      return path.join(fs.realpathSync(current), ...rest.reverse());
    } catch {
      const parent = path.dirname(current);
      if (parent === current) return path.resolve(target);
      rest.push(path.basename(current));
      current = parent;
    }
  }
}

/** True when `filePath` is part of the base tree the quality gate certifies. */
function inCertifiedTree(filePath, root) {
  if (!filePath) return true;
  let relative;
  try {
    relative = path.relative(resolveLoose(root), resolveLoose(filePath));
  } catch {
    return false;
  }
  if (path.isAbsolute(relative) || relative === '..' || relative.startsWith(`..${path.sep}`)) return false;
  const parts = relative === '' ? [] : relative.split(path.sep);
  if (parts[0] === '.claude' && parts[1] === 'state') return false;
  const childRepository = parts.length > 2 && parts[0] === 'app_entry_root' && parts[1] !== '_registry' && parts[2] !== '_project';
  return !childRepository && !parts.includes('.git') && !parts.includes('.factory');
}

const EDIT_TOOLS = ['Edit', 'Write', 'MultiEdit', 'NotebookEdit'];

/**
 * PostToolUse for every tool: an edit is logged (secret-shaped text redacted) and drops a stale PASS; any result that
 * holds secret-shaped text gets a WARNING line (hashes only) and a message to the model (exit 2). Returns the exit code.
 */
function post(payload) {
  const state = path.join('.claude', 'state');
  const toolName = isObject(payload) ? payload.tool_name : undefined;
  const { value, findings } = secretRules.scanValue(isObject(payload) ? payload : {});
  const logged = typeof toolName !== 'string' || EDIT_TOOLS.includes(toolName);
  if (logged || findings.length) fs.mkdirSync(state, { recursive: true });
  const log = path.join(state, 'tool_audit.log');
  if (logged) {
    fs.appendFileSync(log, `${new Date().toISOString()} ${JSON.stringify(value).slice(0, 2000)}\n`);
    const toolInput = isObject(payload) ? payload.tool_input : null;
    const filePath = isObject(toolInput) ? toolInput.file_path : null;
    const flag = path.join(state, 'quality_gate_passed.json');
    if (fs.existsSync(flag) && inCertifiedTree(filePath, process.cwd())) fs.rmSync(flag, { force: true });
  }
  if (!findings.length) return 0;
  fs.appendFileSync(log, `${new Date().toISOString()} WARNING secret-shaped output tool=${JSON.stringify(pyStr(toolName ?? ''))} findings=${findings.join(',')}\n`);
  fs.writeSync(2, `${secretRules.outputWarning(findings)}\n`);
  return 2;
}

// ---- user_prompt_submit.py ------------------------------------------------------------------------------------------
function routingHints(payload) {
  const data = JSON.parse(fs.readFileSync(path.join(__dirname, 'routing_hints.json'), 'utf8'));
  const text = JSON.stringify(payload === undefined ? {} : payload).toLowerCase();
  return data.hints.filter(hint => hint.keys.some(key => text.includes(key))).map(hint => hint.message);
}

// ---- stop_quality_gate.py, task_completed_gate.py --------------------------------------------------------------------
const stateFile = name => path.join('.claude', 'state', name);

function main(event, stdin = () => fs.readFileSync(0)) {
  let payload;
  try {
    payload = JSON.parse(stdin().toString('utf8'));
  } catch {
    payload = undefined; // unparseable: allow, and log {}
  }
  const err = text => fs.writeSync(2, `${text}\n`);
  try {
    if (event === 'pre') {
      const { code, messages } = preVerdict(payload);
      messages.forEach(err);
      return code;
    }
    if (event === 'post') return post(payload);
    if (event === 'prompt') routingHints(payload === undefined ? {} : payload).forEach(hint => fs.writeSync(1, `${hint}\n`));
    else if (event === 'stop') {
      if (fs.existsSync(stateFile('tool_audit.log')) && !fs.existsSync(stateFile('quality_gate_passed.json'))) {
        err('NOTE: Files/tools were used and quality gate is not marked PASS. Before commit/release run `/mandatory-quality-gate`.');
      }
    } else if (event === 'task') {
      if (!fs.existsSync(stateFile('quality_gate_passed.json'))) {
        err('TaskCompleted gate: no PASS quality gate found. Do not mark implementation done until tests/docs gates pass.');
      }
    } else err(`dispatch.js: unknown event ${JSON.stringify(event)}`);
    return 0;
  } catch (error) {
    err(`dispatch.js ${event}: ${error.message}`); // a hook bug must never block work by accident
    return 1;
  }
}

if (require.main === module) process.exitCode = main(process.argv[2]);

module.exports = {
  main, py, preVerdict, secretViolations, bashDecision, baseTargeted, isChildOrOutside, shlexFirst,
  inCertifiedTree, routingHints, PATH_FIELDS,
};
