"""Read tracer for memoized Python test runs (ADR-0021, amendment 2026-10-29).

Python counterpart of cli/lib/test-trace-preload.js and it writes the same line format
(`<kind>\\t<ms>\\t<text>`, kinds R D W S X) into `<INFRA_TEST_TRACE_DIR>/<pid>-<n>.trace`. It is loaded by Python
itself as `sitecustomize` when this folder is on PYTHONPATH, so the unittest process and every Python child that does
not run isolated (-I, -S, -E) are traced; Node children get the Node tracer through NODE_OPTIONS. The analysis lives in
cli/lib/test-trace.js. This file must stay quiet: it never raises into the traced program.
"""
import atexit
import os
import sys
import time

_DIR = os.environ.get("INFRA_TEST_TRACE_DIR")
_ROOTS = [item for item in os.environ.get("INFRA_TEST_TRACE_ROOT", "").split(";") if item]
_WIN = os.name == "nt"


def _install():
    if not _DIR or not _ROOTS or getattr(sys, "_infra_test_trace", False):
        return
    sys._infra_test_trace = True
    try:
        os.makedirs(_DIR, exist_ok=True)
        # O_BINARY: a Windows fd is text mode by default and turns every "\n" into "\r\n" - every traced path then ended
        # in "\r", named no file, and a Python test's pass was never invalidated by an edit
        fd = os.open(os.path.join(_DIR, f"{os.getpid()}-py{os.urandom(4).hex()}.trace"),
                     os.O_WRONLY | os.O_CREAT | os.O_APPEND | getattr(os, "O_BINARY", 0))
    except OSError:
        return

    real = {name: getattr(os, name) for name in ("stat", "lstat", "access", "getcwd", "write", "fspath")}
    slash = lambda value: value.replace("\\", "/")
    fold = (lambda value: value.lower()) if _WIN else (lambda value: value)
    roots = [slash(os.path.abspath(item)).rstrip("/") for item in _ROOTS]
    roots_folded = [fold(item) for item in roots]
    ignored = [slash(os.path.abspath(item)).rstrip("/") for item in
               filter(None, [os.environ.get("TEMP"), os.environ.get("TMP"), os.environ.get("TMPDIR"),
                             _DIR, os.path.dirname(sys.executable), sys.prefix, sys.base_prefix])]
    ignored_folded = [fold(item) for item in ignored]
    home_prefix = fold(slash(os.path.join(os.path.expanduser("~"), ".infra-")))
    seen = set()
    busy = [False]
    here = os.path.dirname(os.path.abspath(__file__))

    def emit(kind, text):
        key = (kind, text)
        if key in seen:
            return
        seen.add(key)
        try:
            real["write"](fd, f"{kind}\t{time.time() * 1000:.3f}\t{text}\n".encode("utf-8", "replace"))
        except OSError:
            pass

    def absolute(value):
        try:
            if isinstance(value, int):
                return None
            if isinstance(value, bytes):
                value = os.fsdecode(value)
            return slash(os.path.abspath(real["fspath"](value)))
        except Exception:
            return None

    def mark(kind, value):
        if busy[0]:
            return
        busy[0] = True
        try:
            if value is None:
                value = "."
            abs_path = absolute(value)
            if abs_path is None:
                return
            folded = fold(abs_path)
            for index, root in enumerate(roots_folded):
                if folded == root:
                    emit(kind, ".")
                    return
                if folded.startswith(root + "/"):
                    emit(kind, abs_path[len(roots[index]) + 1:])
                    return
            if folded.startswith("//./") or folded.startswith("//?/") or folded.startswith(home_prefix):
                return
            if any(folded == item or folded.startswith(item + "/") for item in ignored_folded):
                return
            emit(kind, "@" + abs_path)
        except Exception:
            pass
        finally:
            busy[0] = False

    def mentions_root(text):
        folded = fold(slash(str(text)))
        return any(root in folded for root in roots_folded)

    def audit(event, args):
        try:
            if event == "open":
                path, mode, flags = args[0], args[1], args[2]
                writing = False
                appending = False
                if isinstance(mode, str):
                    writing = any(c in mode for c in "wax+")
                    appending = any(c in mode for c in "a+")
                elif isinstance(flags, int):
                    writing = bool(flags & (os.O_WRONLY | os.O_RDWR | os.O_CREAT | os.O_TRUNC | os.O_APPEND))
                    appending = bool(flags & (os.O_RDWR | os.O_APPEND))
                if not writing or appending:
                    mark("R", path)
                if writing:
                    mark("W", path)
            elif event in ("os.listdir", "os.scandir"):
                mark("R", args[0])
            elif event == "os.mkdir":
                mark("W", args[0])
            elif event in ("os.remove", "os.rmdir"):
                mark("R", args[0])
                mark("W", args[0])
            elif event == "os.rename":
                mark("R", args[0])
                mark("W", args[0])
                mark("W", args[1])
            elif event == "shutil.copyfile":
                mark("R", args[0])
                mark("W", args[1])
            elif event == "shutil.copytree":
                mark("D", args[0])
                mark("W", args[1])
            elif event == "shutil.rmtree":
                mark("R", args[0])
                mark("W", args[0])
            elif event == "shutil.move":
                mark("D", args[0])
                mark("W", args[0])
                mark("W", args[1])
            elif event == "subprocess.Popen":
                executable, argv, cwd = args[0], args[1], args[2]
                name = os.path.basename(str(executable or (argv[0] if argv else ""))).lower()
                isolated = any(str(item) in ("-I", "-S", "-E") for item in (argv or [])[1:4])
                traced = name.startswith("node") or (name.startswith("python") and not isolated)
                inside = cwd is None and False
                where = absolute(cwd) if cwd else absolute(".")
                inside = where is not None and any(fold(where) == r or fold(where).startswith(r + "/") for r in roots_folded)
                if not traced and (inside or any(mentions_root(item) for item in [executable, *(argv or [])])):
                    emit("S", name[:80] or "?")
            elif event in ("os.system", "os.exec", "os.posix_spawn", "os.spawn", "os.startfile"):
                emit("S", event)
        except Exception:
            pass

    def wrap(owner, name):
        original = getattr(owner, name, None)
        if original is None:
            return

        def traced(path, *a, **k):
            mark("R", path)
            return original(path, *a, **k)

        traced.__name__ = getattr(original, "__name__", name)
        try:
            setattr(owner, name, traced)
        except Exception:
            pass

    for name in ("stat", "lstat", "access"):
        wrap(os, name)
    for name in ("exists", "lexists", "isfile", "isdir", "islink", "getsize", "getmtime", "getatime", "getctime",
                 "realpath", "samefile", "isjunction"):
        wrap(os.path, name)
    try:
        wrap(os, "readlink")
    except Exception:
        pass

    # Children: put the tracer in their environment even when the test passes its own `env`.
    import subprocess
    original_init = subprocess.Popen.__init__

    def init(self, *args, **kwargs):
        try:
            env = dict(kwargs.get("env") if kwargs.get("env") is not None else os.environ)
            key = next((k for k in env if (k.upper() if _WIN else k) == "NODE_OPTIONS"), "NODE_OPTIONS")
            node_preload = os.environ.get("INFRA_TEST_TRACE_NODE_PRELOAD", "")
            if node_preload and node_preload not in env.get(key, ""):
                env[key] = (env.get(key, "") + f' --require "{node_preload}"').strip()
            pkey = next((k for k in env if (k.upper() if _WIN else k) == "PYTHONPATH"), "PYTHONPATH")
            if here not in env.get(pkey, "").split(os.pathsep):
                env[pkey] = os.pathsep.join(filter(None, [here, env.get(pkey, "")]))
            env["INFRA_TEST_TRACE_DIR"] = _DIR
            env["INFRA_TEST_TRACE_ROOT"] = ";".join(_ROOTS)
            env["INFRA_TEST_TRACE_NODE_PRELOAD"] = node_preload
            env["PYTHONDONTWRITEBYTECODE"] = "1"
            kwargs["env"] = env
        except Exception:
            pass
        return original_init(self, *args, **kwargs)

    subprocess.Popen.__init__ = init

    def modules():
        for module in list(sys.modules.values()):
            file = getattr(module, "__file__", None)
            if isinstance(file, str):
                mark("R", file)
                mark("R", os.path.dirname(file))
        mark("R", sys.argv[0] if sys.argv else None)

    atexit.register(modules)
    sys.addaudithook(audit)
    sys.dont_write_bytecode = True


_install()
