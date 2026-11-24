'use strict';

/**
 * Read tracer for memoized Node test runs (ADR-0021, amendment 2026-10-29).
 *
 * Loaded with `--require` into every traced Node process (NODE_OPTIONS carries it into node children). It
 * appends one line per distinct touched path under the repository to `<INFRA_TEST_TRACE_DIR>/<pid>-<n>.trace`:
 *   R <ms> <relative path>   a path was read, stat-ed, listed or probed (an absent path counts: creating it changes the result)
 *   D <ms> <relative path>   a whole subtree was read (recursive copy, listing or glob)
 *   W <ms> <relative path>   a path was created, written or removed by the traced run itself
 *   S <ms> <command>         a program that is not traced Node was started where it can read the repository
 *   X <ms> <what>            a read the tracer cannot follow (the test then falls back to the whole tree key)
 * Spawned children get the same variables, so a chain of Node processes is followed. The analysis lives in
 * `test-trace.js`; this file must stay self contained and quiet: it never throws into the traced program.
 */

const fs = require('node:fs');
const path = require('node:path');
const { fileURLToPath } = require('node:url');
const childProcess = require('node:child_process');

const TRACE_DIR = process.env.INFRA_TEST_TRACE_DIR;
const ROOTS = (process.env.INFRA_TEST_TRACE_ROOT || '').split(';').filter(Boolean);
const WIN = process.platform === 'win32';

if (TRACE_DIR && ROOTS.length && !globalThis.__infraTestTrace) {
  globalThis.__infraTestTrace = true;
  install();
}

function install() {
  const raw = {
    openSync: fs.openSync,
    writeSync: fs.writeSync,
    statSync: fs.statSync,
  };
  const slash = value => value.replace(/\\/g, '/');
  const fold = value => (WIN ? value.toLowerCase() : value);
  const roots = ROOTS.map(item => slash(path.resolve(item)).replace(/\/+$/, ''));
  const rootsFolded = roots.map(fold);
  const preload = __filename;
  let fd = -1;
  try {
    fs.mkdirSync(TRACE_DIR, { recursive: true });
    fd = raw.openSync(path.join(TRACE_DIR, `${process.pid}-${Math.random().toString(16).slice(2, 10)}.trace`), 'a');
  } catch {
    return;
  }
  const seen = new Set();
  const stamp = () => (performance.timeOrigin + performance.now()).toFixed(3);

  function emit(kind, text) {
    const key = `${kind}|${text}`;
    if (seen.has(key)) return;
    seen.add(key);
    try { raw.writeSync(fd, `${kind}\t${stamp()}\t${text}\n`); } catch { /* tracing must never break the test */ }
  }

  function absolute(value) {
    try {
      if (typeof value === 'string') return slash(path.resolve(value));
      if (Buffer.isBuffer(value)) return slash(path.resolve(value.toString()));
      if (value && typeof value === 'object' && value.protocol === 'file:') return slash(fileURLToPath(value));
    } catch { /* not a path */ }
    return null;
  }

  /** Path relative to the first repository root containing it, '' for the root itself, null when outside. */
  function relative(value) {
    const abs = absolute(value);
    if (abs === null) return null;
    const folded = fold(abs);
    for (let index = 0; index < roots.length; index += 1) {
      if (folded === rootsFolded[index]) return '';
      if (folded.startsWith(`${rootsFolded[index]}/`)) return abs.slice(roots[index].length + 1);
    }
    return null;
  }

  // Outside the repository only state the machine keeps for the tests (their temp folders, the caches, the Node
  // install) is ignored; any other path is an input too and is stored under an absolute '@' name.
  const os = require('node:os');
  const ignoredPrefixes = [os.tmpdir(), TRACE_DIR, path.dirname(process.execPath), process.env.TEMP, process.env.TMP,
    process.env.TMPDIR, process.env.DEV_TEMP]
    .filter(Boolean).map(item => fold(slash(path.resolve(item))).replace(/\/+$/, ''));
  const ignoredNamePrefixes = [fold(slash(path.join(os.homedir(), '.infra-')))];
  // npm rotates its own debug logs (it lists, reads and deletes `<cache>/_logs` on every start): its bookkeeping, not an input
  const ignoredPattern = /\/_logs(\/|$)/;

  function mark(kind, value) {
    const rel = relative(value);
    if (rel !== null) { emit(kind, rel === '' ? '.' : rel); return; }
    const abs = absolute(value);
    if (abs === null) return;
    const folded = fold(abs);
    if (folded.startsWith('//./') || folded.startsWith('//?/')) return;
    if (ignoredPrefixes.some(prefix => folded === prefix || folded.startsWith(`${prefix}/`))) return;
    if (ignoredNamePrefixes.some(prefix => folded.startsWith(prefix))) return;
    if (ignoredPattern.test(folded)) return;
    emit(kind, `@${abs}`);
  }

  function mentionsRoot(text) {
    const folded = fold(slash(String(text)));
    return rootsFolded.some(root => folded.includes(root));
  }

  const READ = ['readFile', 'readFileSync', 'stat', 'statSync', 'lstat', 'lstatSync', 'exists', 'existsSync',
    'access', 'accessSync', 'opendir', 'opendirSync', 'readlink', 'readlinkSync', 'createReadStream',
    'realpath', 'realpathSync', 'statfs', 'statfsSync'];
  const READ_NATIVE = ['realpath', 'realpathSync'];
  const LIST = ['readdir', 'readdirSync'];
  const OPEN = ['open', 'openSync'];
  const WRITE = ['writeFile', 'writeFileSync', 'appendFile', 'appendFileSync', 'rm', 'rmSync', 'rmdir', 'rmdirSync',
    'unlink', 'unlinkSync', 'truncate', 'truncateSync', 'createWriteStream'];
  const MKDIR = ['mkdir', 'mkdirSync'];
  const MKDTEMP = ['mkdtemp', 'mkdtempSync'];
  const UNSUPPORTED = ['glob', 'globSync'];

  const isSync = name => name.endsWith('Sync');
  const hasCallback = args => typeof args[args.length - 1] === 'function';

  /** Calls `fn`, then `after(result)` once the operation succeeded (sync result, promise or callback). */
  function onSuccess(fn, owner, args, sync, promises, after) {
    if (sync) {
      const result = fn.apply(owner, args);
      try { after(result); } catch { /* tracing only */ }
      return result;
    }
    if (promises) {
      return fn.apply(owner, args).then(result => { try { after(result); } catch { /* tracing only */ } return result; });
    }
    if (hasCallback(args)) {
      const callback = args[args.length - 1];
      const wrapped = args.slice(0, -1).concat(function traced(error, result, ...rest) {
        if (!error) { try { after(result); } catch { /* tracing only */ } }
        return callback.call(this, error, result, ...rest);
      });
      return fn.apply(owner, wrapped);
    }
    return fn.apply(owner, args);
  }

  function wrapAll(owner, promises) {
    const patch = (name, build) => {
      const original = owner[name];
      if (typeof original !== 'function') return;
      const replacement = build(original, isSync(name), promises);
      try { Object.defineProperty(replacement, 'name', { value: original.name }); } catch { /* cosmetic */ }
      for (const key of Object.keys(original)) replacement[key] = original[key];
      if (original.native) replacement.native = build(original.native, isSync(name), promises);
      if (original[Symbol.for('nodejs.util.promisify.custom')]) {
        replacement[Symbol.for('nodejs.util.promisify.custom')] = original[Symbol.for('nodejs.util.promisify.custom')];
      }
      owner[name] = replacement;
    };

    for (const name of READ) {
      patch(name, original => function traced(...args) { mark('R', args[0]); return original.apply(this, args); });
    }
    for (const name of LIST) {
      patch(name, original => function traced(...args) {
        const options = args[1];
        mark(options && typeof options === 'object' && options.recursive ? 'D' : 'R', args[0]);
        return original.apply(this, args);
      });
    }
    for (const name of OPEN) {
      patch(name, original => function traced(...args) {
        const flags = typeof args[1] === 'string' ? args[1] : '';
        mark('R', args[0]);
        const result = original.apply(this, args);
        if (/[wa+]/.test(flags)) mark('W', args[0]);
        return result;
      });
    }
    for (const name of WRITE) {
      patch(name, (original, sync, isPromises) => function traced(...args) {
        const options = args[2];
        const flag = options && typeof options === 'object' && options.flag ? String(options.flag) : '';
        // appending and updating depend on the previous content; removing depends on the path existing
        if (/appendFile|createWriteStream|^(rm|rmdir|unlink|truncate)/.test(name) || /[a+]/.test(flag)) mark('R', args[0]);
        if (name === 'createWriteStream') { mark('W', args[0]); return original.apply(this, args); }
        return onSuccess(original, this, args, sync, isPromises, () => mark('W', args[0]));
      });
    }
    for (const name of MKDIR) {
      patch(name, (original, sync, isPromises) => function traced(...args) {
        return onSuccess(original, this, args, sync, isPromises, created => {
          // recursive mkdir returns the first directory it created (undefined when all existed)
          const options = args[1];
          const recursive = options && typeof options === 'object' && options.recursive;
          if (recursive) { if (created) mark('W', created); } else mark('W', args[0]);
        });
      });
    }
    for (const name of MKDTEMP) {
      patch(name, (original, sync, isPromises) => function traced(...args) {
        return onSuccess(original, this, args, sync, isPromises, created => mark('W', created));
      });
    }
    for (const name of ['copyFile', 'copyFileSync']) {
      patch(name, (original, sync, isPromises) => function traced(...args) {
        mark('R', args[0]);
        return onSuccess(original, this, args, sync, isPromises, () => mark('W', args[1]));
      });
    }
    for (const name of ['rename', 'renameSync']) {
      patch(name, (original, sync, isPromises) => function traced(...args) {
        mark('R', args[0]);
        return onSuccess(original, this, args, sync, isPromises, () => { mark('W', args[0]); mark('W', args[1]); });
      });
    }
    for (const name of ['cp', 'cpSync']) {
      patch(name, (original, sync, isPromises) => function traced(...args) {
        mark('D', args[0]);
        return onSuccess(original, this, args, sync, isPromises, () => mark('W', args[1]));
      });
    }
    for (const name of ['symlink', 'symlinkSync', 'link', 'linkSync']) {
      patch(name, (original, sync, isPromises) => function traced(...args) {
        return onSuccess(original, this, args, sync, isPromises, () => mark('W', args[1]));
      });
    }
    for (const name of UNSUPPORTED) {
      patch(name, original => function traced(...args) { emit('X', `fs.${name}`); return original.apply(this, args); });
    }
    // A watch observes one path: outside the repository it reads nothing of it, inside it is a read of that path (a
    // recursive watch, of everything below it). It used to make every run that watched a temp folder untraceable.
    for (const name of ['watch', 'watchFile']) {
      patch(name, original => function traced(...args) {
        const recursive = name === 'watch' && args[1] !== null && typeof args[1] === 'object' && args[1].recursive === true;
        mark(recursive ? 'D' : 'R', args[0]);
        return original.apply(this, args);
      });
    }
  }

  wrapAll(fs, false);
  wrapAll(fs.promises, true);

  // Loaded CommonJS modules: record the file and its directory (a new sibling can change what `require` resolves).
  try {
    const Module = require('node:module');
    const compile = Module.prototype._compile;
    Module.prototype._compile = function traced(content, filename, ...rest) {
      mark('R', filename);
      mark('R', path.dirname(filename));
      return compile.call(this, content, filename, ...rest);
    };
    for (const extension of ['.json', '.node']) {
      const loader = Module._extensions[extension];
      if (typeof loader === 'function') {
        Module._extensions[extension] = function traced(module, filename) {
          mark('R', filename);
          mark('R', path.dirname(filename));
          return loader.call(this, module, filename);
        };
      }
    }
  } catch { /* the fs hooks still cover the loader */ }

  function tracedEnv(base) {
    // a child the test traces itself (its own trace dir, e.g. the memo's own tests running a traced run): a nested trace, left
    // as the test set it - overwriting it sent the inner run's reads into this trace and the test saw an empty one
    if (base && base.INFRA_TEST_TRACE_DIR && base.INFRA_TEST_TRACE_DIR !== TRACE_DIR) return { ...base };
    const env = { ...(base || process.env) };
    const key = Object.keys(env).find(name => (WIN ? name.toUpperCase() : name) === 'NODE_OPTIONS') || 'NODE_OPTIONS';
    const current = env[key] || '';
    const flag = `--require "${preload.replace(/\\/g, '/')}"`;
    if (!current.includes(preload.replace(/\\/g, '/'))) env[key] = `${current} ${flag}`.trim();
    env.INFRA_TEST_TRACE_DIR = TRACE_DIR;
    env.INFRA_TEST_TRACE_ROOT = ROOTS.join(';');
    const pythonKey = Object.keys(env).find(name => (WIN ? name.toUpperCase() : name) === 'PYTHONPATH') || 'PYTHONPATH';
    const pythonPath = (env[pythonKey] || '').split(path.delimiter).filter(Boolean);
    const pythonTrace = path.join(__dirname, 'pytrace');
    if (!pythonPath.includes(pythonTrace)) env[pythonKey] = [pythonTrace, ...pythonPath].join(path.delimiter);
    env.INFRA_TEST_TRACE_NODE_PRELOAD = preload.replace(/\\/g, '/');
    env.PYTHONDONTWRITEBYTECODE = '1';
    return env;
  }

  /** Node, or Python run with site enabled (its sitecustomize tracer is then loaded through PYTHONPATH). */
  function isNode(file, args) {
    if (typeof file !== 'string') return false;
    const name = path.basename(file);
    if (/^python[\d.]*(\.exe)?$/i.test(name)) {
      return !(Array.isArray(args) ? args.slice(0, 3) : []).some(item => ['-I', '-S', '-E'].includes(String(item)));
    }
    return path.resolve(file) === path.resolve(process.execPath) || /^node(\.exe)?$/i.test(name);
  }

  function withEnv(args) {
    const list = Array.from(args);
    const end = typeof list[list.length - 1] === 'function' ? list.length - 1 : list.length;
    let optionsIndex = -1;
    for (let index = end - 1; index >= 1; index -= 1) {
      const item = list[index];
      if (item && typeof item === 'object' && !Array.isArray(item)) { optionsIndex = index; break; }
    }
    if (optionsIndex === -1) {
      optionsIndex = end;
      list.splice(end, 0, {});
    } else {
      list[optionsIndex] = { ...list[optionsIndex] };
    }
    const options = list[optionsIndex];
    options.env = tracedEnv(options.env);
    return { list, options };
  }

  for (const name of ['spawn', 'spawnSync', 'execFile', 'execFileSync', 'exec', 'execSync', 'fork']) {
    const original = childProcess[name];
    if (typeof original !== 'function') continue;
    const replacement = function traced(...args) {
      let prepared = args;
      let opaque = null;
      try {
        const { list, options } = withEnv(args);
        prepared = list;
        const shell = name === 'exec' || name === 'execSync' || options.shell;
        const command = String(args[0]);
        if (name !== 'fork' && (shell || !isNode(args[0], args[1]))) {
          const cwd = options.cwd ? relative(options.cwd) : relative(process.cwd());
          const texts = [command, ...(Array.isArray(args[1]) ? args[1].map(String) : [])];
          if (cwd !== null || texts.some(mentionsRoot)) opaque = `${path.basename(command).slice(0, 80)}`;
        }
      } catch { prepared = args; }
      if (opaque === null) return original.apply(this, prepared);
      // a program that never started (not found) read nothing, so it is opaque only once it runs
      const notFound = error => Boolean(error) && error.code === 'ENOENT';
      if (isSync(name)) {
        let result;
        try { result = original.apply(this, prepared); } catch (error) {
          if (!notFound(error)) emit('S', opaque);
          throw error;
        }
        if (!notFound(result && result.error)) emit('S', opaque);
        return result;
      }
      const child = original.apply(this, prepared);
      if (child && typeof child.once === 'function') child.once('spawn', () => emit('S', opaque));
      else emit('S', opaque);
      return child;
    };
    const custom = original[Symbol.for('nodejs.util.promisify.custom')];
    if (typeof custom === 'function') {
      // util.promisify(exec|execFile) must keep resolving { stdout, stderr } and must also hand the tracer to the child.
      replacement[Symbol.for('nodejs.util.promisify.custom')] = function tracedPromisified(...args) {
        let prepared = args;
        try { prepared = withEnv(args).list; } catch { prepared = args; }
        return custom.apply(this, prepared);
      };
    }
    childProcess[name] = replacement;
  }

  try { mark('R', process.argv[1]); } catch { /* optional */ }
  try { raw.statSync(TRACE_DIR); } catch { /* optional */ }
}
