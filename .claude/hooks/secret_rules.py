"""Secret-store rules (ADR-0028): reference implementation of .claude/hooks/secret_rules.js.

Same functions in the same order as the Node module; tests/test_hook_dispatch.py proves identical verdicts. Only
ASCII character classes and ASCII case folding are used so that both regex engines and both string models agree.
"""
import hashlib
import json
import math
import os
import re

REGISTRY_FILE = os.path.join(os.path.dirname(os.path.abspath(__file__)), "secret_paths.json")

_LOWER = {code: code + 32 for code in range(ord("A"), ord("Z") + 1)}
_UPPER = {code + 32: code for code in range(ord("A"), ord("Z") + 1)}


def lower(text):
    return text.translate(_LOWER)


def upper(text):
    return text.translate(_UPPER)


def unique(items):
    out = []
    for item in items:
        if item not in out:
            out.append(item)
    return out


WHITESPACE = " \t\n\r\f\v"
SEGMENT_BREAKS = "|&;\n()`"
WORD_BREAKS = WHITESPACE + "'\"`()[]<>|&;,=@+"
QUOTES = "'\""
END = r"(?![\s\S])"
SPECIAL = "\\^$.|?*+()[]{}"

ADVICE = ("use `node scripts/secret.js keys <file>` (names), `check <key>@<file>` (presence, length) or "
          "`run --env NAME=<key>@<file> -- <argv>` (value injected, output masked)")


def store_reason(store_id):
    return (f"`{store_id}` is a secret store (registry .claude/hooks/secret_paths.json): its values never enter a "
            f"transcript; {ADVICE}")


ENV_REASON = ("printing environment variables can expose secrets; check presence with `node scripts/secret.js check "
              "<key>@<file>`, or run the tool under `node scripts/secret.js run` (its output is masked)")
CLIPBOARD_REASON = ("agents never read the clipboard (it may hold a secret the owner copied); ask the owner, or inject "
                    "the value with `node scripts/secret.js run`")
SET_REASON = "`secret.js set` is owner-only: the owner runs it in their own terminal (hidden prompt)"


def split_on(text, breaks):
    """Pieces of `text` between characters of `breaks`, empty pieces dropped."""
    out = []
    current = ""
    for c in text:
        if c in breaks:
            if current:
                out.append(current)
            current = ""
        else:
            current += c
    if current:
        out.append(current)
    return out


def norm_path(word):
    """Lower case, '/' separators, single slashes, Git Bash drives (/c/x becomes drive c), no trailing slash."""
    p = re.sub(r"/{2,}", "/", "/".join(lower(word).split("\\")))
    drive = re.match(r"^/([a-z])(?=/|(?![\s\S]))", p)
    if drive:
        p = f"{drive.group(1)}:{p[2:]}"
    if len(p) > 1 and p.endswith("/") and not p.endswith(":/"):
        p = p[:-1]
    return p


def glob_source(glob, store):
    """Regex source of a registry glob, matched against the end of a normalized path."""
    g = norm_path(glob)
    out = "(?:^|/)"
    i = 3 if g.startswith("**/") else 0
    if store and "/" not in g and g.startswith("*") and not g.startswith("**"):
        out += "[^/.][^/]*"
        i = 1
    while i < len(g):
        if g.startswith("**/", i):
            out += "(?:[^/]*/)*"
            i += 3
        elif g.startswith("**", i):
            out += r"[\s\S]*"
            i += 2
        elif g[i] == "*":
            out += "[^/]*"
            i += 1
        elif g[i] == "?":
            out += "[^/]"
            i += 1
        else:
            out += "\\" + g[i] if g[i] in SPECIAL else g[i]
            i += 1
    return out


def env_styles(name):
    return [f"${name}", f"${{{name}}}", f"%{name}%", f"$env:{name}", f"${{env:{name}}}"]


def anchor_forms(anchor, env):
    """Every spelling of a path anchor ('~' or '$VAR'): the variable forms and the resolved value."""
    forms = []
    resolved = []
    if anchor == "~":
        forms += ["~", *env_styles("home"), *env_styles("userprofile")]
        resolved += [env.get("USERPROFILE"), env.get("HOME")]
    elif anchor.startswith("$"):
        forms += env_styles(lower(anchor[1:]))
        resolved.append(env.get(anchor[1:]))
    else:
        forms.append(norm_path(anchor))
    for value in resolved:
        if not isinstance(value, str):
            continue
        normal = norm_path(value)
        if len(normal) > 3:
            forms.append(normal)
    return unique(forms)


def split_anchor(entry, env):
    slash = entry.find("/")
    anchor = entry if slash < 0 else entry[:slash]
    return anchor_forms(anchor, env), "" if slash < 0 else lower(entry[slash + 1:])


def expand_path(entry, env):
    forms, rest = split_anchor(entry, env)
    return [f"{form}/{rest}" if rest else form for form in forms]


def cooccurrence(entry, env):
    """The folder forms and the file name of a registry path: both named in one command count as a mention."""
    forms, rest = split_anchor(entry, env)
    parts = rest.split("/")
    leaf = parts.pop()
    folder = "/".join(parts)
    return {"parents": [f"{form}/{folder}" if folder else form for form in forms], "leaf": leaf}


_compiled = None


def registry(env=None):
    """The registry, compiled once per process for `env` (tests pass their own and call reset())."""
    global _compiled
    if _compiled is not None:
        return _compiled
    env = os.environ if env is None else env
    with open(REGISTRY_FILE, encoding="utf-8") as handle:
        data = json.load(handle)

    def store(entry):
        return {
            "id": entry["id"],
            "consumers": entry.get("consumers") or [],
            "standalone": entry.get("standalone") is True,
            "regexes": [re.compile(glob_source(glob, True) + END) for glob in entry.get("globs") or []],
            "forms": [form for item in entry.get("paths") or [] for form in expand_path(item, env)],
            "cooc": [cooccurrence(item, env) for item in entry.get("paths") or []],
        }

    def folder(entry):
        return {
            "id": entry["id"],
            "consumers": entry.get("consumers") or [],
            "regexes": [re.compile(glob_source(glob, False) + "(?:/[^/]*)?" + END) for glob in entry.get("globs") or []],
            "forms": [form for item in entry.get("paths") or [] for form in expand_path(item, env)],
        }

    _compiled = {
        "stores": [store(entry) for entry in data["stores"]],
        "dirs": [folder(entry) for entry in data["dirs"]],
        "allow": [re.compile(glob_source(glob, False) + END) for glob in data["allow"]],
        "safe": set(data["safePrograms"]),
        "ignore": set(data["ignoreWords"]),
        "names": data["secretEnvNames"],
        "publicKeys": data["publicKeys"],
        "aliases": data["aliases"],
    }
    return _compiled


def reset():
    global _compiled, _output_names
    _compiled = None
    _output_names = None


def stores_of(word, standalone, reg):
    """Registry stores a word names; `standalone` says it is a whole argument (see the registry's 'standalone')."""
    if word.startswith("\\."):
        return []
    w = norm_path(word)
    if not w or w in reg["ignore"] or any(regex.search(w) for regex in reg["allow"]):
        return []
    slashed = "/" in w
    return [store for store in reg["stores"] if (not store["standalone"] or standalone or slashed)
            and (w in store["forms"] or any(regex.search(w) for regex in store["regexes"]))]


def dirs_of(word, reg):
    """Registry folders a word names: the folder itself or one of its direct children."""
    w = norm_path(word)
    if not w or any(regex.search(w) for regex in reg["allow"]):
        return []
    return [d for d in reg["dirs"] if any(regex.search(w) for regex in d["regexes"])
            or any(w == form or (w.startswith(form + "/") and "/" not in w[len(form) + 1:]) for form in d["forms"])]


def ancestors_of(word, reg):
    """Registry folders below an absolute (or anchored) word: a search there reads them."""
    w = norm_path(word)
    first = w[:1]
    if not (re.match(r"^[a-z]:", w) or (first != "" and first in "/~$%")):
        return []
    prefix = w if w.endswith("/") else w + "/"
    return [d for d in reg["dirs"] if any(form.startswith(prefix) for form in d["forms"])]


# ---- shell commands -------------------------------------------------------------------------------------------------
def strip_quotes(token):
    t = token
    while t and t[0] in QUOTES:
        t = t[1:]
    while t and t[-1] in QUOTES:
        t = t[:-1]
    return t


def tokenize(text):
    return [t for t in (strip_quotes(token) for token in split_on(text, WHITESPACE)) if t]


ASSIGNMENT = re.compile(r"^[A-Za-z_][A-Za-z0-9_]*=")


def standalone_of(token):
    """The value a whitespace token passes as a whole argument: @file, <file, $(file), --opt=file, NAME=file."""
    t = strip_quotes(token)
    while t and t[0] in "@<>($`":
        t = t[1:]
    while t and t[-1] in ")`;,":
        t = t[:-1]
    t = strip_quotes(t)
    if t.startswith("-") and "=" in t:
        t = t[t.index("=") + 1:]
    elif ASSIGNMENT.search(t):
        t = t[t.index("=") + 1:]
    return strip_quotes(t)


def program_name(token):
    parts = "/".join(lower(token).split("\\")).split("/")
    name = parts[-1]
    for ext in (".exe", ".cmd", ".bat", ".com", ".ps1"):
        if name.endswith(ext) and len(name) > len(ext):
            name = name[:-len(ext)]
            break
    return name


WRAPPERS = {"sudo", "command", "exec", "time", "nice", "nohup", "builtin", "xargs", "doas", "call"}


def program_of(tokens):
    """The program a segment runs, past assignments and wrappers (`env` alone is the program `env`)."""
    i = 0
    while i < len(tokens):
        t = tokens[i]
        if ASSIGNMENT.search(t):
            i += 1
            continue
        name = program_name(t)
        if name == "env":
            j = i + 1
            while j < len(tokens) and (tokens[j].startswith("-") or ASSIGNMENT.search(tokens[j])):
                j += 1
            if j >= len(tokens):
                return {"name": "env", "index": i}
            i = j
            continue
        if name in WRAPPERS:
            i += 1
            while i < len(tokens) and tokens[i].startswith("-"):
                i += 1
            continue
        return {"name": name, "index": i}
    return {"name": "", "index": len(tokens)}


def subcommand(tokens, index, name):
    """The first argument that is not a flag (git skips `-C dir` and `-c k=v`)."""
    i = index + 1
    while i < len(tokens) and tokens[i].startswith("-"):
        i += 2 if name == "git" and tokens[i] in ("-C", "-c") else 1
    return lower(tokens[i]) if i < len(tokens) else ""


INLINE_FLAGS = {
    "python": ["-c"], "python3": ["-c"], "py": ["-c"], "pythonw": ["-c"], "node": ["-e", "--eval", "-p", "--print"],
    "bun": ["-e", "--eval", "-p", "--print"], "php": ["-r"], "bash": ["-c"], "sh": ["-c"], "zsh": ["-c"], "dash": ["-c"],
    "ksh": ["-c"], "osascript": ["-e"], "lua": ["-e"],
}
VALUE_FLAGS = ["-X", "-W", "-r", "--require", "--import", "--loader", "--env-file"]
INTERPRETERS = set(INLINE_FLAGS) | {"deno", "ruby", "perl", "pwsh", "powershell", "cmd"}
POWERSHELL_INLINE = ["-c", "-command", "-encodedcommand", "-ec", "-e"]
PERL_INLINE = re.compile(r"^-[a-zA-Z0-9]*e")


def interpreter_info(tokens, index, name):
    """{inline, script, scriptIndex} of an interpreter call: inline code (-c, -e, heredoc, stdin) or a script file."""
    shell = name in ("pwsh", "powershell")
    inline = {"inline": True, "script": None, "scriptIndex": -1}
    i = index + 1
    while i < len(tokens):
        t = tokens[i]
        lt = lower(t)
        if t in INLINE_FLAGS.get(name, []):
            return inline
        if name in ("perl", "ruby") and PERL_INLINE.search(t):
            return inline
        if shell and lt in POWERSHELL_INLINE:
            return inline
        if name == "cmd" and lt in ("/c", "/k"):
            return inline
        if shell and lt == "-file":
            return {"inline": False, "script": tokens[i + 1] if i + 1 < len(tokens) else None, "scriptIndex": i + 1}
        if name.startswith("py") and t == "-m":
            return {"inline": False, "script": None, "scriptIndex": -1}
        if t == "-":
            return inline
        if t in VALUE_FLAGS and not shell:
            i += 2
            continue
        if t.startswith("-") or (name == "cmd" and t.startswith("/")):
            i += 1
            continue
        if name == "deno" and lt in ("run", "eval"):
            if lt == "eval":
                return inline
            i += 1
            continue
        if shell and not lt.endswith(".ps1"):
            return inline
        return {"inline": False, "script": t, "scriptIndex": i}
    return inline


def secret_tool(tokens, program):
    """{index, sub} when the segment runs scripts/secret.js (directly or through node/bun)."""
    index = program["index"]
    if program["name"] in ("node", "bun"):
        info = interpreter_info(tokens, index, program["name"])
        if info["inline"] or info["scriptIndex"] < 0:
            return None
        index = info["scriptIndex"]
    if index >= len(tokens) or program_name(tokens[index]) != "secret.js":
        return None
    return {"index": index, "sub": lower(tokens[index + 1]) if index + 1 < len(tokens) else ""}


def units_of(command):
    """Segments of a command; the argv after `secret.js run ... --` is a segment of its own whose output is masked."""
    units = []
    for raw in split_on(command, SEGMENT_BREAKS):
        tokens = tokenize(raw)
        if not tokens:
            continue
        program = program_of(tokens)
        tool = secret_tool(tokens, program)
        if not tool:
            units.append({"raw": raw, "tokens": tokens, "program": program, "sanctioned": False, "masked": False, "sub": ""})
            continue
        dashes = tokens.index("--", tool["index"] + 1) if "--" in tokens[tool["index"] + 1:] else -1
        head = tokens if dashes < 0 else tokens[:dashes]
        units.append({"raw": " ".join(head), "tokens": head, "program": program, "sanctioned": True, "masked": False,
                      "sub": tool["sub"]})
        tail = [] if dashes < 0 else tokens[dashes + 1:]
        if tail and tool["sub"] == "run":
            units.append({"raw": " ".join(tail), "tokens": tail, "program": program_of(tail), "sanctioned": False,
                          "masked": True, "sub": ""})
    return units


HARMLESS_REDIRECT = re.compile(r"[0-9]?>&[0-9]|[0-9]?>>?[ \t]*(?:/dev/null|nul|\$null)")


VARIABLE = re.compile(r"^\$(?:env:)?[A-Za-z_][A-Za-z0-9_]*(?![\s\S])")
VARIABLE_SET = re.compile(r"^\$(?:env:)?[A-Za-z_][A-Za-z0-9_]*=")


def literal_assignment(unit):
    """`X=value` alone, or PowerShell `$env:X = value` with one literal value (no command on the right)."""
    t = unit["tokens"]
    if unit["program"]["name"] == "":
        return True
    if len(t) == 3 and t[1] == "=" and VARIABLE.search(t[0]):
        return True
    return len(t) == 1 and bool(VARIABLE_SET.search(t[0]))


def safe_for(unit, hit, reg):
    """A segment may name a store when it only looks at it (safe programs) or is a registered consumer."""
    if ">" in HARMLESS_REDIRECT.sub("", lower(unit["raw"])):
        return False
    if literal_assignment(unit):
        return True
    name = unit["program"]["name"]
    if name in reg["safe"] or f"{name} {subcommand(unit['tokens'], unit['program']['index'], name)}" in reg["safe"]:
        return True
    return name in hit["consumers"]


SEARCHERS = {"rg", "grep", "egrep", "fgrep", "findstr", "select-string", "sls", "ag", "ack", "ugrep", "find",
             "fd", "tar", "zip", "7z", "7za", "cp", "copy", "copy-item", "cpi", "robocopy", "xcopy", "rsync", "scp",
             "compress-archive", "get-content", "gc", "cat", "type", "git"}
PRINTERS = {"echo", "printf", "print", "write-output", "write", "write-host", "out-host", "out-string",
            "write-information", "write-warning", "write-error", "write-verbose", "write-debug", "out-file", "set-content",
            "add-content", "tee", "tee-object", "say", "cat", "printenv"}
ENV_DRIVE_READERS = {"get-item", "gi", "get-childitem", "gci", "ls", "dir", "get-content", "gc", "cat", "type"}
DUMP_FLAGS = ["-p", "-x", "-px", "-xp"]
VAR_PATTERNS = [re.compile(r"\$\{?(?:env:)?([a-z_][a-z0-9_]*)"), re.compile(r"%([a-z_][a-z0-9_]*)%"),
                re.compile(r"env:[\\/]?([a-z_][a-z0-9_]*)"),
                re.compile(r"getenvironmentvariable\([ \t]*['\"]([a-z_][a-z0-9_]*)")]
CODE_DUMPS = [re.compile(r"process\.env(?![ \t]*\.[ \t]*[a-z_$]|[ \t]*\[)"),
              re.compile(r"os\.environ(?![ \t]*\[|\.get\(|\.setdefault\(|\.pop\(|\.copy\()"),
              re.compile(r"%env(?![a-z0-9_{])"), re.compile(r"getenvironmentvariables\(")]
CODE_PRINTS = re.compile(r"print|console\.|stdout|stderr|puts|pp |say |echo|write-host|write-output|json\.dumps|logging|log\(")
CODE_NAMES = [re.compile(r"process\.env\.([a-z_$][a-z0-9_$]*)"), re.compile(r"process\.env\[[ \t]*['\"]([^'\"]+)"),
              re.compile(r"environ\[[ \t]*['\"]([^'\"]+)"), re.compile(r"environ\.get\([ \t]*['\"]([^'\"]+)"),
              re.compile(r"getenv\([ \t]*['\"]([^'\"]+)"), re.compile(r"env\[[ \t]*['\"]([^'\"]+)"),
              re.compile(r"\$env\{[ \t]*['\"]?([a-z0-9_]+)"),
              re.compile(r"getenvironmentvariable\([ \t]*['\"]([a-z_][a-z0-9_]*)")]
CLIPBOARD_FRAGMENTS = ["get-clipboard", "pbpaste", "wl-paste", "termux-clipboard-get", "clipboard]::get"]
XSEL_WRITES = ["-i", "--input", "-a", "--append", "-c", "--clear", "-k", "--keep", "-d", "--delete", "-x", "--exchange"]


def matches_of(patterns, text):
    return [match.group(1) for pattern in patterns for match in pattern.finditer(text)]


def secret_name(name, reg):
    """True when an environment variable NAME looks like it holds a secret (registry secretEnvNames)."""
    n = upper(name)
    if n in reg["names"]["notSecret"]:
        return False
    if any(part in n for part in reg["names"]["substrings"]):
        return True
    return any(part in reg["names"]["parts"] for part in n.split("_"))


def env_printed(unit, reg):
    name = unit["program"]["name"]
    args = unit["tokens"][unit["program"]["index"] + 1:]
    low = lower(unit["raw"])
    if name == "env" or (name in ("printenv", "set") and not args):
        return True
    if name == "printenv" and any(secret_name(arg, reg) for arg in args):
        return True
    if name in ("export", "declare", "typeset") and all(arg in DUMP_FLAGS for arg in args):
        return True
    if "getenvironmentvariables(" in low:
        return True
    for token in unit["tokens"]:
        t = lower(token)
        if t in ("env:", "env:\\", "env:/") or (t.startswith("env:") and "*" in t):
            return True
    first = name[:1]
    outputs = name in PRINTERS or name in ENV_DRIVE_READERS or (first != "" and first in "$%[" and "=" not in unit["raw"])
    return outputs and any(secret_name(found, reg) for found in matches_of(VAR_PATTERNS, low))


def clipboard_read(units, low):
    if any(fragment in low for fragment in CLIPBOARD_FRAGMENTS):
        return True
    for unit in units:
        args = [lower(arg) for arg in unit["tokens"][unit["program"]["index"] + 1:]]
        name = unit["program"]["name"]
        if name == "gcb":
            return True
        if name == "xclip" and ("-o" in args or "-out" in args):
            return True
        if name == "xsel" and ("-o" in args or "--output" in args or not any(arg in XSEL_WRITES for arg in args)):
            return True
    return False


def code_reads_env(low, reg):
    """Inline interpreter code that dumps the environment, or reads a secret-named variable."""
    if any(pattern.search(low) for pattern in CODE_DUMPS) and CODE_PRINTS.search(low):
        return True
    return any(secret_name(found, reg) for found in matches_of(CODE_NAMES, low))


def command_reasons(command, reg):
    reasons = []

    def add(reason):
        if reason not in reasons:
            reasons.append(reason)

    units = units_of(command)
    standalone = {standalone_of(token) for token in split_on(command, WHITESPACE)}
    words = []
    for unit in units:
        unit_words = [word for token in unit["tokens"] for word in split_on(token, WORD_BREAKS)]
        words += unit_words
        if unit["sanctioned"]:
            if unit["sub"] == "set":
                add(SET_REASON)
            continue
        for word in unit_words:
            hits = stores_of(word, word in standalone, reg) + dirs_of(word, reg)
            if unit["program"]["name"] in SEARCHERS:
                hits += ancestors_of(word, reg)
            for hit in hits:
                if not safe_for(unit, hit, reg):
                    add(store_reason(hit["id"]))
    normal = [norm_path(word) for word in words]
    leaves = {word[word.rfind("/") + 1:] for word in normal}
    for store in reg["stores"]:
        for cooc in store["cooc"]:
            if cooc["leaf"] not in leaves or not any(
                    word == parent or word.startswith(parent + "/") for word in normal for parent in cooc["parents"]):
                continue
            if any(not unit["sanctioned"] and not safe_for(unit, store, reg) for unit in units):
                add(store_reason(store["id"]))
    low = lower(command)
    open_units = [unit for unit in units if not unit["sanctioned"] and not unit["masked"]]
    inline = any(unit["program"]["name"] in INTERPRETERS
                 and interpreter_info(unit["tokens"], unit["program"]["index"], unit["program"]["name"])["inline"]
                 for unit in open_units)
    # [Environment]::GetEnvironmentVariable('X') spans segments (its parentheses split them), so it is read on the whole text.
    getter = any(secret_name(found, reg) for found in matches_of([VAR_PATTERNS[3]], low))
    if getter or any(env_printed(unit, reg) for unit in open_units) or (inline and code_reads_env(low, reg)):
        add(ENV_REASON)
    if clipboard_read(units, low):
        add(CLIPBOARD_REASON)
    return reasons


# ---- file tools -----------------------------------------------------------------------------------------------------
PATH_TOOL_FIELDS = ["file_path", "path", "notebook_path", "glob"]


def path_reasons(tool_name, tool_input, reg):
    reasons = []
    fields = PATH_TOOL_FIELDS + ["pattern"] if tool_name == "Glob" else PATH_TOOL_FIELDS
    for field in fields:
        value = tool_input.get(field)
        if not isinstance(value, str) or not value:
            continue
        hits = stores_of(value, True, reg) + dirs_of(value, reg)
        if tool_name == "Grep" and field == "path":
            hits += ancestors_of(value, reg)
        for hit in hits:
            reason = store_reason(hit["id"])
            if reason not in reasons:
                reasons.append(reason)
    return reasons


def violations(tool_name, tool_input, env=None):
    """The secret-store reasons to block a call (empty: allowed)."""
    if not isinstance(tool_input, dict):
        return []
    reg = registry(env)
    reasons = path_reasons(tool_name, tool_input, reg)
    command = tool_input.get("command") if tool_name in ("Bash", "PowerShell") else None
    if isinstance(command, str):
        for reason in command_reasons(command, reg):
            if reason not in reasons:
                reasons.append(reason)
    return reasons


def legacy_text(command):
    """The command text the legacy overlay check reads: without the arguments of sanctioned secret.js calls."""
    units = units_of(command)
    if not any(unit["sanctioned"] for unit in units):
        return command
    return "\n".join(unit["raw"] for unit in units if not unit["sanctioned"])


# ---- PostToolUse: secret-shaped output ------------------------------------------------------------------------------
OUTPUT_PATTERNS = [
    ("github-token", re.compile(r"(?<![A-Za-z0-9_])gh[pousr]_[A-Za-z0-9]{36,255}")),
    ("github-token", re.compile(r"(?<![A-Za-z0-9_])github_pat_[A-Za-z0-9_]{22,255}")),
    ("private-key", re.compile(r"-----BEGIN[A-Z ]*PRIVATE KEY[A-Z ]*-----[A-Za-z0-9+/=\\\r\n\t :,-]*")),
    ("jwt", re.compile(r"(?<![A-Za-z0-9_-])eyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}")),
    ("aws-access-key", re.compile(r"(?<![A-Z0-9])(?:AKIA|ASIA)[0-9A-Z]{16}(?![0-9A-Z])")),
    ("slack-token", re.compile(r"(?<![A-Za-z0-9])xox[abprs]-[A-Za-z0-9-]{10,}")),
    ("stripe-key", re.compile(r"(?<![A-Za-z0-9])[rs]k_live_[0-9A-Za-z]{20,}")),
    ("api-key", re.compile(r"(?<![A-Za-z0-9])sk-(?:ant-|proj-)?[A-Za-z0-9_-]{32,}")),
    ("npm-token", re.compile(r"(?<![A-Za-z0-9])npm_[A-Za-z0-9]{36}(?![A-Za-z0-9])")),
    ("gitlab-token", re.compile(r"(?<![A-Za-z0-9])glpat-[A-Za-z0-9_-]{20,}")),
    ("google-oauth", re.compile(r"(?<![A-Za-z0-9])ya29\.[0-9A-Za-z_-]{20,}")),
    ("url-credentials", re.compile(r"(?<![a-z0-9+.-])[a-z][a-z0-9+.-]{0,30}://[^/ \t\r\n:@'\"]{1,200}:[^/ \t\r\n:@'\"]{6,200}@")),
]
FINDING_KINDS = frozenset([kind for kind, _ in OUTPUT_PATTERNS] + ["assigned-secret"])
# Every repetition is bounded and every pattern starts with a literal or a guarded first character: the scan stays
# linear on long tool results (an unbounded scheme prefix took 19 s on 60 KB of letters).
#
# "key = value" text counts (kind assigned-secret) only when BOTH sides look secret (2026-10-26, ADR-0028 tuning):
#   key   - the whole identifier before the `=`/`:` (letters, digits, `_`, `.`, `-`; at most 96 characters) passes the
#           guard's own env-var name rule (secretEnvNames of secret_paths.json: TOKEN, SECRET, PASSWORD, PASSWD,
#           PASSPHRASE, CREDENTIAL, PRIVATE, APIKEY, ACCESSKEY substrings or a KEY/PASS/PAT/PWD part, notSecret names
#           excluded) or contains AUTH (not AUTHOR), and does not end in a descriptive word (HINT, LABEL, FILE, PATH, ...);
#   value - 8..200 characters of the value alphabet, not true/false/null/none/nil/empty/undefined, not a dotted code
#           reference (config.token), not code-identifier-like (words, camelCase, digit runs joined by `_ . / -`, e.g.
#           allowsEconomy, hints_50, emulator-5554), holds a letter and a digit or symbol, at least 6 distinct characters
#           and a Shannon entropy of at least 2.5 bits per character (random 8+ character passwords and keys measure
#           about 2.8-4.5, words and repeats stay under 2.5). `$VAR` / `${VAR}` never match: `$` is not in the alphabet.
ASSIGNED = re.compile(r"(?<![a-z0-9_.-])([a-z0-9_.-]{1,96})['\"]?[ \t]{0,8}[=:][ \t]{0,8}['\"]?(?=([a-z0-9+/=_!#%^&*.~-]{8,200}))")
DOTTED = re.compile(r"^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)+(?![\s\S])")
VALUE_PIECES = re.compile(r"[A-Za-z]+|[0-9]+|[^A-Za-z0-9]+")
VALUE_SEPARATORS = re.compile(r"[_./-]+")
VALUE_WORD = re.compile(r"(?:[A-Z]?[a-z]{2,})+|[A-Z]{2,}")
VALUE_HEX = re.compile(r"[0-9a-fA-F]{16,}")
NOT_VALUES = {"true", "false", "null", "none", "nil", "empty", "undefined"}
# HELPER: git's credential.helper names a program (`!gh auth git-credential`), never a secret (2026-10-29).
DESCRIPTIVE_ENDINGS = ("HINT", "LABEL", "PLACEHOLDER", "ALIAS", "FILE", "PATH", "DIR", "URL", "TYPE", "LENGTH", "ENABLED",
                       "HELPER")
SCAN_LIMIT = 2000000
ENTROPY_MIN = 2.5

_output_names = None


def digest(text):
    return hashlib.sha256(text.encode("utf-8", "surrogatepass")).hexdigest()[:12]


def output_names():
    """secretEnvNames of the registry (read once, without compiling the stores); None when unreadable (fail closed)."""
    global _output_names
    if _output_names is None:
        try:
            with open(REGISTRY_FILE, encoding="utf-8") as handle:
                _output_names = json.load(handle)["secretEnvNames"]
        except (OSError, ValueError, KeyError):
            _output_names = False
    return _output_names or None


def secret_key(key):
    """True when the name left of `=`/`:` looks like it holds a secret (the guard's env-var rule plus AUTH)."""
    # The guard's own labels ("assigned-secret:0152f3fd74b6" in a warning or a report) are never a secret (2026-10-29).
    if lower(key) in FINDING_KINDS:
        return False
    names = output_names()
    if names is None:
        return True
    n = upper(key).replace(".", "_").replace("-", "_")
    if n in names["notSecret"] or n.endswith(DESCRIPTIVE_ENDINGS):
        return False
    if any(part in n for part in names["substrings"]) or ("AUTH" in n and "AUTHOR" not in n):
        return True
    return any(part in names["parts"] for part in n.split("_"))


def code_identifier(value):
    """True for words, camelCase and digit runs joined by `_ . / -` (allowsEconomy, hints_50, emulator-5554)."""
    for segment in VALUE_SEPARATORS.split(value):
        for piece in VALUE_PIECES.findall(segment):
            if "a" <= lower(piece[0]) <= "z":
                if not VALUE_WORD.fullmatch(piece):
                    return False
            elif not "0" <= piece[0] <= "9":
                return False
    return True


def entropy(value):
    """Shannon entropy in bits per character."""
    total = len(value)
    return -sum((count / total) * math.log2(count / total) for count in (value.count(ch) for ch in set(value)))


def assigned_value(value):
    if lower(value) in NOT_VALUES or DOTTED.search(value):
        return False
    if not re.search(r"[A-Za-z]", value) or not re.search(r"[0-9+/=!#%^&*~-]", value):
        return False
    if len(set(value)) < 6 or entropy(value) < ENTROPY_MIN - 1e-9:
        return False
    return bool(VALUE_HEX.fullmatch(value)) or not code_identifier(value)


def find_secrets(text):
    """[{kind, hash, start, end}] of secret-shaped substrings of one string, sorted by start."""
    if len(text) > SCAN_LIMIT:
        text = text[:SCAN_LIMIT]
    found = []
    for kind, pattern in OUTPUT_PATTERNS:
        for match in pattern.finditer(text):
            found.append({"kind": kind, "hash": digest(match.group(0)), "start": match.start(), "end": match.end()})
    low = lower(text)
    at = 0
    while True:
        match = ASSIGNED.search(low, at)
        if match is None:
            break
        start = match.end()
        end = start + len(match.group(2))
        at = start  # past the key and `=`: a rejected pair never hides a `token=...` inside its value
        if not secret_key(match.group(1)) or not assigned_value(text[start:end]):
            continue
        found.append({"kind": "assigned-secret", "hash": digest(text[start:end]), "start": start, "end": end})
        at = end
    found.sort(key=lambda item: (item["start"], -item["end"]))
    return found


def redact_text(text, found):
    """`text` with every finding replaced by [REDACTED:kind:hash] (overlaps: the earlier, longer one wins)."""
    out = ""
    at = 0
    for item in found:
        if item["start"] < at:
            continue
        out += text[at:item["start"]] + f"[REDACTED:{item['kind']}:{item['hash']}]"
        at = item["end"]
    return out + text[at:]


def scan_value(value):
    """(value, findings): a JSON value with every string (keys too) redacted, and the sorted unique findings."""
    findings = set()

    def walk(item):
        if isinstance(item, str):
            found = find_secrets(item)
            for entry in found:
                findings.add(f"{entry['kind']}:{entry['hash']}")
            return redact_text(item, found) if found else item
        if isinstance(item, list):
            return [walk(inner) for inner in item]
        if isinstance(item, dict):
            return {walk(key): walk(inner) for key, inner in item.items()}
        return item

    redacted = walk(value)
    return redacted, sorted(findings)


def output_warning(findings):
    return (f"SECRET-SHAPED OUTPUT ({', '.join(findings)}): this tool result contains text shaped like a secret. "
            "If it is a real secret: stop, do not repeat, copy or use it, and tell the owner which tool call showed it so "
            "they rotate it. If it is a fixture or an example, continue. Values reach tools only through "
            "`node scripts/secret.js` (ADR-0028).")
