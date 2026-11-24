'use strict';

// Secret-store rules of the hook dispatcher (ADR-0028): PreToolUse verdicts for secret stores, environment printing and
// clipboard reads, and the PostToolUse scan for secret-shaped output. The registry of stores is secret_paths.json.
//
// secret_rules.py is the reference implementation with the same functions in the same order; tests/test_hook_dispatch.py
// proves identical verdicts. To keep the two engines identical this file uses ASCII character classes only (no \w, \s,
// \b, ".", "$", no i flag) and ASCII case folding, and walks strings by code point.

const fs = require('node:fs');
const path = require('node:path');

const REGISTRY_FILE = path.join(__dirname, 'secret_paths.json');

const ASCII_ONLY = /^[\x00-\x7f]*$/;
// ASCII case folding only (Python's str.lower() folds more); plain toLowerCase() is the same for ASCII text and faster.
const lower = text => (ASCII_ONLY.test(text) ? text.toLowerCase() : text.replace(/[A-Z]/g, c => String.fromCharCode(c.charCodeAt(0) + 32)));
const upper = text => (ASCII_ONLY.test(text) ? text.toUpperCase() : text.replace(/[a-z]/g, c => String.fromCharCode(c.charCodeAt(0) - 32)));
const unique = items => items.filter((item, index) => items.indexOf(item) === index);

const WHITESPACE = ' \t\n\r\f\v';
const SEGMENT_BREAKS = '|&;\n()`';
const WORD_BREAKS = `${WHITESPACE}'"\`()[]<>|&;,=@+`;
const QUOTES = '\'"';
const END = '(?![\\s\\S])';
const SPECIAL = '\\^$.|?*+()[]{}';

const ADVICE = 'use `node scripts/secret.js keys <file>` (names), `check <key>@<file>` (presence, length) or '
  + '`run --env NAME=<key>@<file> -- <argv>` (value injected, output masked)';
const storeReason = id => `\`${id}\` is a secret store (registry .claude/hooks/secret_paths.json): its values never enter a transcript; ${ADVICE}`;
const ENV_REASON = 'printing environment variables can expose secrets; check presence with `node scripts/secret.js check <key>@<file>`, '
  + 'or run the tool under `node scripts/secret.js run` (its output is masked)';
const CLIPBOARD_REASON = 'agents never read the clipboard (it may hold a secret the owner copied); ask the owner, or inject the value with '
  + '`node scripts/secret.js run`';
const SET_REASON = '`secret.js set` is owner-only: the owner runs it in their own terminal (hidden prompt)';

/** Pieces of `text` between characters of `breaks`, empty pieces dropped. */
function splitOn(text, breaks) {
  const out = [];
  let current = '';
  for (const c of text) {
    if (breaks.includes(c)) {
      if (current) out.push(current);
      current = '';
    } else current += c;
  }
  if (current) out.push(current);
  return out;
}

/** Lower case, '/' separators, single slashes, Git Bash drives (/c/x becomes drive c), no trailing slash. */
function normPath(word) {
  let p = lower(word).split('\\').join('/').replace(/\/{2,}/g, '/');
  const drive = /^\/([a-z])(?=\/|(?![\s\S]))/.exec(p);
  if (drive) p = `${drive[1]}:${p.slice(2)}`;
  if (p.length > 1 && p.endsWith('/') && !p.endsWith(':/')) p = p.slice(0, -1);
  return p;
}

/** Regex source of a registry glob, matched against the end of a normalized path. */
function globSource(glob, store) {
  const g = normPath(glob);
  let out = '(?:^|/)';
  let i = g.startsWith('**/') ? 3 : 0;
  if (store && !g.includes('/') && g.startsWith('*') && !g.startsWith('**')) {
    out += '[^/.][^/]*';
    i = 1;
  }
  while (i < g.length) {
    if (g.startsWith('**/', i)) { out += '(?:[^/]*/)*'; i += 3; }
    else if (g.startsWith('**', i)) { out += '[\\s\\S]*'; i += 2; }
    else if (g[i] === '*') { out += '[^/]*'; i += 1; }
    else if (g[i] === '?') { out += '[^/]'; i += 1; }
    else { out += SPECIAL.includes(g[i]) ? `\\${g[i]}` : g[i]; i += 1; }
  }
  return out;
}

/** The longest literal piece of a glob: a word without it cannot match, so its regex is never run (speed only). */
function literalOf(glob) {
  // splitOn, not String.split(regex): a regex split builds a new sticky RegExp per call (~50 us each, cold).
  let best = '';
  for (const piece of splitOn(normPath(glob), '*?')) if (piece.length > best.length) best = piece;
  return best.startsWith('/') ? best.slice(1) : best;
}

/** {literal, regex} matchers of globs; `suffix` extends the regex (folders also match a direct child). */
const matchers = (globs, store, suffix = '') => globs.map(glob => ({ glob, store, suffix, literal: literalOf(glob), regex: null }));
const regexOf = item => item.regex || (item.regex = new RegExp(globSource(item.glob, item.store) + item.suffix + END));
const anyMatch = (list, w) => list.some(item => w.includes(item.literal) && regexOf(item).test(w));

const envStyles = name => [`$${name}`, `\${${name}}`, `%${name}%`, `$env:${name}`, `\${env:${name}}`];

/** Every spelling of a path anchor ('~' or '$VAR'): the variable forms and the resolved value. */
function anchorForms(anchor, env) {
  const forms = [];
  const resolved = [];
  if (anchor === '~') {
    forms.push('~', ...envStyles('home'), ...envStyles('userprofile'));
    resolved.push(env.USERPROFILE, env.HOME);
  } else if (anchor.startsWith('$')) {
    forms.push(...envStyles(lower(anchor.slice(1))));
    resolved.push(env[anchor.slice(1)]);
  } else forms.push(normPath(anchor));
  for (const value of resolved) {
    if (typeof value !== 'string') continue;
    const normal = normPath(value);
    if (normal.length > 3) forms.push(normal);
  }
  return unique(forms);
}

/** [anchor forms, normalized rest] of a registry path like '$GRADLE_USER_HOME/gradle.properties'. */
function splitAnchor(entry, env) {
  const slash = entry.indexOf('/');
  const anchor = slash < 0 ? entry : entry.slice(0, slash);
  return [anchorForms(anchor, env), slash < 0 ? '' : lower(entry.slice(slash + 1))];
}

function expandPath(entry, env) {
  const [forms, rest] = splitAnchor(entry, env);
  return forms.map(form => (rest ? `${form}/${rest}` : form));
}

/** The folder forms and the file name of a registry path: both named in one command count as a mention. */
function cooccurrence(entry, env) {
  const [forms, rest] = splitAnchor(entry, env);
  const parts = rest.split('/');
  const leaf = parts.pop();
  const folder = parts.join('/');
  return { parents: forms.map(form => (folder ? `${form}/${folder}` : form)), leaf };
}

let compiled = null;

/** The registry, compiled once per process for `env` (tests pass their own and call reset()). */
function registry(env = process.env) {
  if (compiled) return compiled;
  const data = JSON.parse(fs.readFileSync(REGISTRY_FILE, 'utf8'));
  const store = entry => ({
    id: entry.id,
    consumers: entry.consumers || [],
    standalone: entry.standalone === true,
    regexes: matchers(entry.globs || [], true),
    forms: (entry.paths || []).flatMap(item => expandPath(item, env)),
    cooc: (entry.paths || []).map(item => cooccurrence(item, env)),
  });
  const dir = entry => ({
    id: entry.id,
    consumers: entry.consumers || [],
    regexes: matchers(entry.globs || [], false, '(?:/[^/]*)?'),
    forms: (entry.paths || []).flatMap(item => expandPath(item, env)),
  });
  compiled = {
    stores: data.stores.map(store),
    dirs: data.dirs.map(dir),
    allow: matchers(data.allow, false),
    safe: new Set(data.safePrograms),
    ignore: new Set(data.ignoreWords),
    names: data.secretEnvNames,
    publicKeys: data.publicKeys,
    aliases: data.aliases,
  };
  return compiled;
}

function reset() {
  compiled = null;
  outputNamesCache = undefined;
}

/** Registry stores a word names; `standalone` says it is a whole argument (see the registry's 'standalone'). */
function storesOf(word, standalone, reg) {
  if (word.startsWith('\\.')) return []; // a regex like \.env, not a path
  const w = normPath(word);
  if (!w || reg.ignore.has(w) || anyMatch(reg.allow, w)) return [];
  const slashed = w.includes('/');
  return reg.stores.filter(store => (!store.standalone || standalone || slashed)
    && (store.forms.includes(w) || anyMatch(store.regexes, w)));
}

/** Registry folders a word names: the folder itself or one of its direct children. */
function dirsOf(word, reg) {
  const w = normPath(word);
  if (!w || anyMatch(reg.allow, w)) return [];
  return reg.dirs.filter(dir => anyMatch(dir.regexes, w)
    || dir.forms.some(form => w === form || (w.startsWith(`${form}/`) && !w.slice(form.length + 1).includes('/'))));
}

/** Registry folders below an absolute (or anchored) word: a search there reads them. */
function ancestorsOf(word, reg) {
  const w = normPath(word);
  if (!(/^[a-z]:/.test(w) || '/~$%'.includes(w[0] || ' '))) return [];
  const prefix = w.endsWith('/') ? w : `${w}/`;
  return reg.dirs.filter(dir => dir.forms.some(form => form.startsWith(prefix)));
}

// ---- shell commands -------------------------------------------------------------------------------------------------
function stripQuotes(token) {
  let t = token;
  while (t && QUOTES.includes(t[0])) t = t.slice(1);
  while (t && QUOTES.includes(t[t.length - 1])) t = t.slice(0, -1);
  return t;
}

const tokenize = text => splitOn(text, WHITESPACE).map(stripQuotes).filter(Boolean);
const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;

/** The value a whitespace token passes as a whole argument: @file, <file, $(file), --opt=file, NAME=file. */
function standaloneOf(token) {
  let t = stripQuotes(token);
  while (t && '@<>($`'.includes(t[0])) t = t.slice(1);
  while (t && ')`;,'.includes(t[t.length - 1])) t = t.slice(0, -1);
  t = stripQuotes(t);
  if (t.startsWith('-') && t.includes('=')) t = t.slice(t.indexOf('=') + 1);
  else if (ASSIGNMENT.test(t)) t = t.slice(t.indexOf('=') + 1);
  return stripQuotes(t);
}

function programName(token) {
  const parts = lower(token).split('\\').join('/').split('/');
  let name = parts[parts.length - 1];
  for (const ext of ['.exe', '.cmd', '.bat', '.com', '.ps1']) {
    if (name.endsWith(ext) && name.length > ext.length) {
      name = name.slice(0, -ext.length);
      break;
    }
  }
  return name;
}

const WRAPPERS = new Set(['sudo', 'command', 'exec', 'time', 'nice', 'nohup', 'builtin', 'xargs', 'doas', 'call']);

/** The program a segment runs, past assignments and wrappers (`env` alone is the program `env`). */
function programOf(tokens) {
  let i = 0;
  while (i < tokens.length) {
    const t = tokens[i];
    if (ASSIGNMENT.test(t)) { i += 1; continue; }
    const name = programName(t);
    if (name === 'env') {
      let j = i + 1;
      while (j < tokens.length && (tokens[j].startsWith('-') || ASSIGNMENT.test(tokens[j]))) j += 1;
      if (j >= tokens.length) return { name: 'env', index: i };
      i = j;
      continue;
    }
    if (WRAPPERS.has(name)) {
      i += 1;
      while (i < tokens.length && tokens[i].startsWith('-')) i += 1;
      continue;
    }
    return { name, index: i };
  }
  return { name: '', index: tokens.length };
}

/** The first argument that is not a flag (git skips `-C dir` and `-c k=v`). */
function subcommand(tokens, index, name) {
  let i = index + 1;
  while (i < tokens.length && tokens[i].startsWith('-')) i += name === 'git' && (tokens[i] === '-C' || tokens[i] === '-c') ? 2 : 1;
  return i < tokens.length ? lower(tokens[i]) : '';
}

const INLINE_FLAGS = {
  python: ['-c'], python3: ['-c'], py: ['-c'], pythonw: ['-c'], node: ['-e', '--eval', '-p', '--print'],
  bun: ['-e', '--eval', '-p', '--print'], php: ['-r'], bash: ['-c'], sh: ['-c'], zsh: ['-c'], dash: ['-c'], ksh: ['-c'],
  osascript: ['-e'], lua: ['-e'],
};
const VALUE_FLAGS = ['-X', '-W', '-r', '--require', '--import', '--loader', '--env-file'];
const INTERPRETERS = new Set([...Object.keys(INLINE_FLAGS), 'deno', 'ruby', 'perl', 'pwsh', 'powershell', 'cmd']);
const POWERSHELL_INLINE = ['-c', '-command', '-encodedcommand', '-ec', '-e'];

/** {inline, script, scriptIndex} of an interpreter call: inline code (-c, -e, heredoc, stdin) or a script file. */
function interpreterInfo(tokens, index, name) {
  const shell = name === 'pwsh' || name === 'powershell';
  for (let i = index + 1; i < tokens.length; i += 1) {
    const t = tokens[i];
    const lt = lower(t);
    if ((INLINE_FLAGS[name] || []).includes(t)) return { inline: true, script: null, scriptIndex: -1 };
    if ((name === 'perl' || name === 'ruby') && /^-[a-zA-Z0-9]*e/.test(t)) return { inline: true, script: null, scriptIndex: -1 };
    if (shell && POWERSHELL_INLINE.includes(lt)) return { inline: true, script: null, scriptIndex: -1 };
    if (name === 'cmd' && (lt === '/c' || lt === '/k')) return { inline: true, script: null, scriptIndex: -1 };
    if (shell && lt === '-file') return { inline: false, script: tokens[i + 1] || null, scriptIndex: i + 1 };
    if (name.startsWith('py') && t === '-m') return { inline: false, script: null, scriptIndex: -1 };
    if (t === '-') return { inline: true, script: null, scriptIndex: -1 };
    if (VALUE_FLAGS.includes(t) && !shell) { i += 1; continue; }
    if (t.startsWith('-') || (name === 'cmd' && t.startsWith('/'))) continue;
    if (name === 'deno' && (lt === 'run' || lt === 'eval')) {
      if (lt === 'eval') return { inline: true, script: null, scriptIndex: -1 };
      continue;
    }
    if (shell && !lt.endsWith('.ps1')) return { inline: true, script: null, scriptIndex: -1 };
    return { inline: false, script: t, scriptIndex: i };
  }
  return { inline: true, script: null, scriptIndex: -1 };
}

/** {index, sub} when the segment runs scripts/secret.js (directly or through node/bun). */
function secretTool(tokens, program) {
  let index = program.index;
  if (program.name === 'node' || program.name === 'bun') {
    const info = interpreterInfo(tokens, index, program.name);
    if (info.inline || info.scriptIndex < 0) return null;
    index = info.scriptIndex;
  }
  if (index >= tokens.length || programName(tokens[index]) !== 'secret.js') return null;
  return { index, sub: lower(tokens[index + 1] || '') };
}

/** Segments of a command; the argv after `secret.js run ... --` is a segment of its own whose output is masked. */
function unitsOf(command) {
  const units = [];
  for (const raw of splitOn(command, SEGMENT_BREAKS)) {
    const tokens = tokenize(raw);
    if (!tokens.length) continue;
    const program = programOf(tokens);
    const tool = secretTool(tokens, program);
    if (!tool) {
      units.push({ raw, tokens, program, sanctioned: false, masked: false, sub: '' });
      continue;
    }
    const dashes = tokens.indexOf('--', tool.index + 1);
    const head = dashes < 0 ? tokens : tokens.slice(0, dashes);
    units.push({ raw: head.join(' '), tokens: head, program, sanctioned: true, masked: false, sub: tool.sub });
    const tail = dashes < 0 ? [] : tokens.slice(dashes + 1);
    if (tail.length && tool.sub === 'run') {
      units.push({ raw: tail.join(' '), tokens: tail, program: programOf(tail), sanctioned: false, masked: true, sub: '' });
    }
  }
  return units;
}

const HARMLESS_REDIRECT = /[0-9]?>&[0-9]|[0-9]?>>?[ \t]*(?:\/dev\/null|nul|\$null)/g;

const VARIABLE = /^\$(?:env:)?[A-Za-z_][A-Za-z0-9_]*(?![\s\S])/;
const VARIABLE_SET = /^\$(?:env:)?[A-Za-z_][A-Za-z0-9_]*=/;

/** `X=value` alone, or PowerShell `$env:X = value` with one literal value (no command on the right). */
function literalAssignment(unit) {
  const t = unit.tokens;
  if (unit.program.name === '') return true;
  if (t.length === 3 && t[1] === '=' && VARIABLE.test(t[0])) return true;
  return t.length === 1 && VARIABLE_SET.test(t[0]);
}

/** A segment may name a store when it only looks at it (safe programs) or is a registered consumer. */
function safeFor(unit, hit, reg) {
  if (lower(unit.raw).replace(HARMLESS_REDIRECT, '').includes('>')) return false;
  if (literalAssignment(unit)) return true;
  const name = unit.program.name;
  if (reg.safe.has(name) || reg.safe.has(`${name} ${subcommand(unit.tokens, unit.program.index, name)}`)) return true;
  return hit.consumers.includes(name);
}

const SEARCHERS = new Set(['rg', 'grep', 'egrep', 'fgrep', 'findstr', 'select-string', 'sls', 'ag', 'ack', 'ugrep', 'find',
  'fd', 'tar', 'zip', '7z', '7za', 'cp', 'copy', 'copy-item', 'cpi', 'robocopy', 'xcopy', 'rsync', 'scp',
  'compress-archive', 'get-content', 'gc', 'cat', 'type', 'git']);
const PRINTERS = new Set(['echo', 'printf', 'print', 'write-output', 'write', 'write-host', 'out-host', 'out-string',
  'write-information', 'write-warning', 'write-error', 'write-verbose', 'write-debug', 'out-file', 'set-content',
  'add-content', 'tee', 'tee-object', 'say', 'cat', 'printenv']);
const ENV_DRIVE_READERS = new Set(['get-item', 'gi', 'get-childitem', 'gci', 'ls', 'dir', 'get-content', 'gc', 'cat', 'type']);
const DUMP_FLAGS = ['-p', '-x', '-px', '-xp'];
const VAR_PATTERNS = [/\$\{?(?:env:)?([a-z_][a-z0-9_]*)/g, /%([a-z_][a-z0-9_]*)%/g, /env:[\\/]?([a-z_][a-z0-9_]*)/g,
  /getenvironmentvariable\([ \t]*['"]([a-z_][a-z0-9_]*)/g];
const CODE_DUMPS = [/process\.env(?![ \t]*\.[ \t]*[a-z_$]|[ \t]*\[)/, /os\.environ(?![ \t]*\[|\.get\(|\.setdefault\(|\.pop\(|\.copy\()/,
  /%env(?![a-z0-9_{])/, /getenvironmentvariables\(/];
const CODE_PRINTS = /print|console\.|stdout|stderr|puts|pp |say |echo|write-host|write-output|json\.dumps|logging|log\(/;
const CODE_NAMES = [/process\.env\.([a-z_$][a-z0-9_$]*)/g, /process\.env\[[ \t]*['"]([^'"]+)/g, /environ\[[ \t]*['"]([^'"]+)/g,
  /environ\.get\([ \t]*['"]([^'"]+)/g, /getenv\([ \t]*['"]([^'"]+)/g, /env\[[ \t]*['"]([^'"]+)/g, /\$env\{[ \t]*['"]?([a-z0-9_]+)/g,
  /getenvironmentvariable\([ \t]*['"]([a-z_][a-z0-9_]*)/g];
const CLIPBOARD_FRAGMENTS = ['get-clipboard', 'pbpaste', 'wl-paste', 'termux-clipboard-get', 'clipboard]::get'];
const XSEL_WRITES = ['-i', '--input', '-a', '--append', '-c', '--clear', '-k', '--keep', '-d', '--delete', '-x', '--exchange'];

const matchesOf = (patterns, text) => patterns.flatMap(pattern => [...text.matchAll(pattern)].map(match => match[1]));

/** True when an environment variable NAME looks like it holds a secret (registry secretEnvNames). */
function secretName(name, reg) {
  const n = upper(name);
  if (reg.names.notSecret.includes(n)) return false;
  if (reg.names.substrings.some(part => n.includes(part))) return true;
  return n.split('_').some(part => reg.names.parts.includes(part));
}

function envPrinted(unit, reg) {
  const name = unit.program.name;
  const args = unit.tokens.slice(unit.program.index + 1);
  const low = lower(unit.raw);
  if (name === 'env' || ((name === 'printenv' || name === 'set') && args.length === 0)) return true;
  if (name === 'printenv' && args.some(arg => secretName(arg, reg))) return true;
  if ((name === 'export' || name === 'declare' || name === 'typeset') && args.every(arg => DUMP_FLAGS.includes(arg))) return true;
  if (low.includes('getenvironmentvariables(')) return true;
  if (unit.tokens.some(token => {
    const t = lower(token);
    return t === 'env:' || t === 'env:\\' || t === 'env:/' || (t.startsWith('env:') && t.includes('*'));
  })) return true;
  const outputs = PRINTERS.has(name) || ENV_DRIVE_READERS.has(name) || ('$%['.includes(name[0] || ' ') && !unit.raw.includes('='));
  return outputs && matchesOf(VAR_PATTERNS, low).some(found => secretName(found, reg));
}

function clipboardRead(units, low) {
  if (CLIPBOARD_FRAGMENTS.some(fragment => low.includes(fragment))) return true;
  return units.some(unit => {
    const args = unit.tokens.slice(unit.program.index + 1).map(lower);
    if (unit.program.name === 'gcb') return true;
    if (unit.program.name === 'xclip') return args.includes('-o') || args.includes('-out');
    if (unit.program.name === 'xsel') return args.includes('-o') || args.includes('--output') || !args.some(arg => XSEL_WRITES.includes(arg));
    return false;
  });
}

/** Inline interpreter code that dumps the environment, or reads a secret-named variable. */
function codeReadsEnv(low, reg) {
  if (CODE_DUMPS.some(pattern => pattern.test(low)) && CODE_PRINTS.test(low)) return true;
  return matchesOf(CODE_NAMES, low).some(found => secretName(found, reg));
}

function commandReasons(command, reg) {
  const reasons = [];
  const add = reason => { if (!reasons.includes(reason)) reasons.push(reason); };
  const units = unitsOf(command);
  const standalone = new Set(splitOn(command, WHITESPACE).map(standaloneOf));
  const words = [];
  for (const unit of units) {
    const unitWords = unit.tokens.flatMap(token => splitOn(token, WORD_BREAKS));
    words.push(...unitWords);
    if (unit.sanctioned) {
      if (unit.sub === 'set') add(SET_REASON);
      continue;
    }
    for (const word of unitWords) {
      const hits = [...storesOf(word, standalone.has(word), reg), ...dirsOf(word, reg)];
      if (SEARCHERS.has(unit.program.name)) hits.push(...ancestorsOf(word, reg));
      for (const hit of hits) if (!safeFor(unit, hit, reg)) add(storeReason(hit.id));
    }
  }
  const normal = words.map(normPath);
  const leaves = new Set(normal.map(word => word.slice(word.lastIndexOf('/') + 1)));
  for (const store of reg.stores) {
    for (const { parents, leaf } of store.cooc) {
      if (!leaves.has(leaf) || !normal.some(word => parents.some(parent => word === parent || word.startsWith(`${parent}/`)))) continue;
      if (units.some(unit => !unit.sanctioned && !safeFor(unit, store, reg))) add(storeReason(store.id));
    }
  }
  const low = lower(command);
  const open = units.filter(unit => !unit.sanctioned && !unit.masked);
  const inline = open.some(unit => INTERPRETERS.has(unit.program.name) && interpreterInfo(unit.tokens, unit.program.index, unit.program.name).inline);
  // [Environment]::GetEnvironmentVariable('X') spans segments (its parentheses split them), so it is read on the whole text.
  const getter = matchesOf([VAR_PATTERNS[3]], low).some(found => secretName(found, reg));
  if (getter || open.some(unit => envPrinted(unit, reg)) || (inline && codeReadsEnv(low, reg))) add(ENV_REASON);
  if (clipboardRead(units, low)) add(CLIPBOARD_REASON);
  return reasons;
}

// ---- file tools -----------------------------------------------------------------------------------------------------
const PATH_TOOL_FIELDS = ['file_path', 'path', 'notebook_path', 'glob'];

function pathReasons(toolName, toolInput, reg) {
  const reasons = [];
  const fields = toolName === 'Glob' ? [...PATH_TOOL_FIELDS, 'pattern'] : PATH_TOOL_FIELDS;
  for (const field of fields) {
    const value = toolInput[field];
    if (typeof value !== 'string' || !value) continue;
    const hits = [...storesOf(value, true, reg), ...dirsOf(value, reg)];
    if (toolName === 'Grep' && field === 'path') hits.push(...ancestorsOf(value, reg));
    for (const hit of hits) {
      const reason = storeReason(hit.id);
      if (!reasons.includes(reason)) reasons.push(reason);
    }
  }
  return reasons;
}

/** The secret-store reasons to block a call (empty: allowed). */
function violations(toolName, toolInput, env = process.env) {
  if (toolInput === null || typeof toolInput !== 'object' || Array.isArray(toolInput)) return [];
  const command = toolName === 'Bash' || toolName === 'PowerShell' ? toolInput.command : null;
  const fields = toolName === 'Glob' ? [...PATH_TOOL_FIELDS, 'pattern'] : PATH_TOOL_FIELDS;
  if (typeof command !== 'string' && !fields.some(field => typeof toolInput[field] === 'string' && toolInput[field])) return [];
  const reg = registry(env);
  const reasons = pathReasons(toolName, toolInput, reg);
  if (typeof command === 'string') {
    for (const reason of commandReasons(command, reg)) if (!reasons.includes(reason)) reasons.push(reason);
  }
  return reasons;
}

/** The command text the legacy overlay check reads: without the arguments of sanctioned secret.js calls. */
function legacyText(command) {
  const units = unitsOf(command);
  if (!units.some(unit => unit.sanctioned)) return command;
  return units.filter(unit => !unit.sanctioned).map(unit => unit.raw).join('\n');
}

// ---- PostToolUse: secret-shaped output ------------------------------------------------------------------------------
const OUTPUT_PATTERNS = [
  ['github-token', /(?<![A-Za-z0-9_])gh[pousr]_[A-Za-z0-9]{36,255}/g],
  ['github-token', /(?<![A-Za-z0-9_])github_pat_[A-Za-z0-9_]{22,255}/g],
  ['private-key', /-----BEGIN[A-Z ]*PRIVATE KEY[A-Z ]*-----[A-Za-z0-9+/=\\\r\n\t :,-]*/g],
  ['jwt', /(?<![A-Za-z0-9_-])eyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g],
  ['aws-access-key', /(?<![A-Z0-9])(?:AKIA|ASIA)[0-9A-Z]{16}(?![0-9A-Z])/g],
  ['slack-token', /(?<![A-Za-z0-9])xox[abprs]-[A-Za-z0-9-]{10,}/g],
  ['stripe-key', /(?<![A-Za-z0-9])[rs]k_live_[0-9A-Za-z]{20,}/g],
  ['api-key', /(?<![A-Za-z0-9])sk-(?:ant-|proj-)?[A-Za-z0-9_-]{32,}/g],
  ['npm-token', /(?<![A-Za-z0-9])npm_[A-Za-z0-9]{36}(?![A-Za-z0-9])/g],
  ['gitlab-token', /(?<![A-Za-z0-9])glpat-[A-Za-z0-9_-]{20,}/g],
  ['google-oauth', /(?<![A-Za-z0-9])ya29\.[0-9A-Za-z_-]{20,}/g],
  ['url-credentials', /(?<![a-z0-9+.-])[a-z][a-z0-9+.-]{0,30}:\/\/[^/ \t\r\n:@'"]{1,200}:[^/ \t\r\n:@'"]{6,200}@/g],
];
const FINDING_KINDS = new Set([...OUTPUT_PATTERNS.map(([kind]) => kind), 'assigned-secret']);
// Every repetition is bounded and every pattern starts with a literal or a guarded first character: the scan stays
// linear on long tool results (an unbounded scheme prefix took 19 s on 60 KB of letters).
const OUTPUT_LITERALS = [['gh'], ['github_pat_'], ['-----BEGIN'], ['eyJ'], ['AKIA', 'ASIA'], ['xox'], ['k_live_'], ['sk-'],
  ['npm_'], ['glpat-'], ['ya29.'], ['://']];
// Every substring and part of secretEnvNames, plus AUTH, holds one of these: a cheap pre-check before any regex runs.
const ASSIGNED_LITERALS = ['pass', 'secret', 'token', 'key', 'pwd', 'pat', 'credential', 'private', 'auth'];
//
// "key = value" text counts (kind assigned-secret) only when BOTH sides look secret (2026-10-26, ADR-0028 tuning):
//   key   - the whole identifier before the `=`/`:` (letters, digits, `_`, `.`, `-`; at most 96 characters) passes the
//           guard's own env-var name rule (secretEnvNames of secret_paths.json: TOKEN, SECRET, PASSWORD, PASSWD,
//           PASSPHRASE, CREDENTIAL, PRIVATE, APIKEY, ACCESSKEY substrings or a KEY/PASS/PAT/PWD part, notSecret names
//           excluded) or contains AUTH (not AUTHOR), and does not end in a descriptive word (HINT, LABEL, FILE, PATH, ...);
//   value - 8..200 characters of the value alphabet, not true/false/null/none/nil/empty/undefined, not a dotted code
//           reference (config.token), not code-identifier-like (words, camelCase, digit runs joined by `_ . / -`, e.g.
//           allowsEconomy, hints_50, emulator-5554), holds a letter and a digit or symbol, at least 6 distinct characters
//           and a Shannon entropy of at least 2.5 bits per character (random 8+ character passwords and keys measure
//           about 2.8-4.5, words and repeats stay under 2.5). `$VAR` / `${VAR}` never match: `$` is not in the alphabet.
// Matched on the lower-cased text; group 1 is the key, group 2 (in a lookahead) the value.
const ASSIGNED = /(?<![a-z0-9_.-])([a-z0-9_.-]{1,96})['"]?[ \t]{0,8}[=:][ \t]{0,8}['"]?(?=([a-z0-9+/=_!#%^&*.~-]{8,200}))/g;
const DOTTED = /^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)+(?![\s\S])/;
const VALUE_PIECES = /[A-Za-z]+|[0-9]+|[^A-Za-z0-9]+/g;
const VALUE_SEPARATORS = /[_./-]+/;
const VALUE_WORD = /^(?:(?:[A-Z]?[a-z]{2,})+|[A-Z]{2,})(?![\s\S])/;
const VALUE_HEX = /^[0-9a-fA-F]{16,}(?![\s\S])/;
const NOT_VALUES = new Set(['true', 'false', 'null', 'none', 'nil', 'empty', 'undefined']);
// HELPER: git's credential.helper names a program (`!gh auth git-credential`), never a secret (2026-10-29).
const DESCRIPTIVE_ENDINGS = ['HINT', 'LABEL', 'PLACEHOLDER', 'ALIAS', 'FILE', 'PATH', 'DIR', 'URL', 'TYPE', 'LENGTH', 'ENABLED',
  'HELPER'];
const SCAN_LIMIT = 2000000;
const ENTROPY_MIN = 2.5;

const digest = text => require('node:crypto').createHash('sha256').update(text, 'utf8').digest('hex').slice(0, 12);

let outputNamesCache; // undefined: not read yet; null: unreadable (fail closed)

/** secretEnvNames of the registry (read once, without compiling the stores); null when unreadable. */
function outputNames() {
  if (outputNamesCache === undefined) {
    try {
      outputNamesCache = JSON.parse(fs.readFileSync(REGISTRY_FILE, 'utf8')).secretEnvNames || null;
    } catch {
      outputNamesCache = null;
    }
  }
  return outputNamesCache;
}

/** True when the name left of `=`/`:` looks like it holds a secret (the guard's env-var rule plus AUTH). */
function secretKey(key) {
  // The guard's own labels ("assigned-secret:0152f3fd74b6" in a warning or a report) are never a secret (2026-10-29).
  if (FINDING_KINDS.has(lower(key))) return false;
  const names = outputNames();
  if (names === null) return true;
  const n = upper(key).replace(/[.-]/g, '_');
  if (names.notSecret.includes(n) || DESCRIPTIVE_ENDINGS.some(ending => n.endsWith(ending))) return false;
  if (names.substrings.some(part => n.includes(part)) || (n.includes('AUTH') && !n.includes('AUTHOR'))) return true;
  return n.split('_').some(part => names.parts.includes(part));
}

/** True for words, camelCase and digit runs joined by `_ . / -` (allowsEconomy, hints_50, emulator-5554). */
function codeIdentifier(value) {
  for (const segment of value.split(VALUE_SEPARATORS)) {
    for (const piece of segment.match(VALUE_PIECES) || []) {
      const lead = lower(piece[0]);
      if (lead >= 'a' && lead <= 'z') {
        if (!VALUE_WORD.test(piece)) return false;
      } else if (!(piece[0] >= '0' && piece[0] <= '9')) return false;
    }
  }
  return true;
}

/** Shannon entropy in bits per character. */
function entropy(value) {
  const counts = new Map();
  for (const ch of value) counts.set(ch, (counts.get(ch) || 0) + 1);
  const total = [...value].length;
  let sum = 0;
  for (const count of counts.values()) sum -= (count / total) * Math.log2(count / total);
  return sum;
}

function assignedValue(value) {
  if (NOT_VALUES.has(lower(value)) || DOTTED.test(value)) return false;
  if (!/[A-Za-z]/.test(value) || !/[0-9+/=!#%^&*~-]/.test(value)) return false;
  if (new Set(value).size < 6 || entropy(value) < ENTROPY_MIN - 1e-9) return false;
  return VALUE_HEX.test(value) || !codeIdentifier(value);
}

/** [{kind, hash, start, end}] of secret-shaped substrings of one string, sorted by start. */
function findSecrets(text) {
  if (text.length > SCAN_LIMIT) text = text.slice(0, SCAN_LIMIT);
  const found = [];
  OUTPUT_PATTERNS.forEach(([kind, pattern], index) => {
    if (!OUTPUT_LITERALS[index].some(literal => text.includes(literal))) return; // speed only: every match holds one
    for (const match of text.matchAll(pattern)) found.push({ kind, hash: digest(match[0]), start: match.index, end: match.index + match[0].length });
  });
  const low = lower(text);
  if (!ASSIGNED_LITERALS.some(literal => low.includes(literal))) return found.sort((a, b) => a.start - b.start || b.end - a.end);
  const assigned = new RegExp(ASSIGNED.source, 'g'); // a local copy: lastIndex is per scan
  for (let match = assigned.exec(low); match !== null; match = assigned.exec(low)) {
    const start = match.index + match[0].length;
    const end = start + match[2].length;
    assigned.lastIndex = start; // past the key and `=`: a rejected pair never hides a `token=...` inside its value
    if (!secretKey(match[1]) || !assignedValue(text.slice(start, end))) continue;
    found.push({ kind: 'assigned-secret', hash: digest(text.slice(start, end)), start, end });
    assigned.lastIndex = end;
  }
  found.sort((a, b) => a.start - b.start || b.end - a.end);
  return found;
}

/** `text` with every finding replaced by [REDACTED:kind:hash] (overlaps: the earlier, longer one wins). */
function redactText(text, found) {
  let out = '';
  let at = 0;
  for (const item of found) {
    if (item.start < at) continue;
    out += `${text.slice(at, item.start)}[REDACTED:${item.kind}:${item.hash}]`;
    at = item.end;
  }
  return out + text.slice(at);
}

/** {value, findings}: a JSON value with every string (keys too) redacted, and the sorted unique findings. */
function scanValue(value) {
  const findings = new Set();
  const walk = item => {
    if (typeof item === 'string') {
      const found = findSecrets(item);
      found.forEach(entry => findings.add(`${entry.kind}:${entry.hash}`));
      return found.length ? redactText(item, found) : item;
    }
    if (Array.isArray(item)) return item.map(walk);
    if (item !== null && typeof item === 'object') {
      const out = {};
      for (const [key, inner] of Object.entries(item)) out[walk(key)] = walk(inner);
      return out;
    }
    return item;
  };
  const redacted = walk(value);
  return { value: redacted, findings: [...findings].sort() };
}

const outputWarning = findings => `SECRET-SHAPED OUTPUT (${findings.join(', ')}): this tool result contains text shaped like a secret. `
  + 'If it is a real secret: stop, do not repeat, copy or use it, and tell the owner which tool call showed it so they rotate it. '
  + 'If it is a fixture or an example, continue. Values reach tools only through `node scripts/secret.js` (ADR-0028).';

module.exports = {
  REGISTRY_FILE, lower, upper, splitOn, normPath, globSource, registry, reset, storesOf, dirsOf, ancestorsOf, tokenize,
  standaloneOf, programName, programOf, interpreterInfo, unitsOf, secretName, violations, legacyText, findSecrets,
  redactText, scanValue, outputWarning, digest, INTERPRETERS,
};
