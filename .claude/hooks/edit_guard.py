#!/usr/bin/env python3
"""Edit-path guard (owner order 2026-10-26, ADR-0028 "Edits"): reference implementation of edit_rules.js.

Files are changed with the Edit tool, not with inline interpreter code, heredocs or ad-hoc read-replace-write
scripts. A script is the tool for ONE mechanical change across 10+ files, written to a file with the marker
`mass-edit: <reason>`. Ad hoc means outside version control: a script inside a Git work tree is reviewed with the
diff, so repository generators, build scripts and tests keep running. Exit 2 blocks; parse errors allow.
"""
import json
import os
import re
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from secret_rules import interpreter_info, lower, units_of  # noqa: E402

ADVICE = ("use the Edit tool (rg -n anchor, Read offset/limit, Edit); a script only for one change across 10+ files, "
          "written to a file with the marker `# mass-edit: <reason>`")
INLINE_REASON = f"inline interpreter code that writes files: {ADVICE}"
POWERSHELL_REASON = f"a PowerShell read-replace-write of a file: {ADVICE}"
HEREDOC_REASON = f"a heredoc redirected into a file of a Git work tree: {ADVICE}"
SCRIPT_REASON = f"an ad-hoc edit script (reads, replaces and writes files) without the `mass-edit:` marker: {ADVICE}"

WRITE_INTERPRETERS = {"python", "python3", "py", "pythonw", "node", "deno", "bun", "perl", "ruby"}
SCRIPT_RUNNERS = WRITE_INTERPRETERS | {"pwsh", "powershell"}
SCRIPT_EXTENSIONS = (".py", ".js", ".mjs", ".cjs", ".ts", ".ps1", ".pl", ".rb")
SCRIPT_LIMIT = 512 * 1024
MARKER = "mass-edit:"

WRITE_CODE = re.compile("|".join([
    r"open\([^)]*,[ \t]*(?:mode[ \t]*=[ \t]*)?['\"][rbt]*[wax+]", r"\.write_text\(", r"\.write_bytes\(",
    r"\.writelines\(", r"(?<!stdout)(?<!stderr)\.write\(", "writefilesync", r"writefile\(",
    "appendfilesync", r"appendfile\(", "createwritestream", r"file\.open\([^)]*['\"][wa]",
    r"open[ \t]*\(?[ \t]*(?:my[ \t]+)?[$a-z_]+[ \t]*,[ \t]*['\"][ \t]*\+?>", r"fileinput\.input\([^)]*inplace",
]))
SCRIPT_WRITE = re.compile(WRITE_CODE.pattern + "|set-content|out-file|add-content|writealltext|writealllines")
SCRIPT_READ = re.compile(r"open\(|read_text\(|read_bytes\(|\.read\(|readfilesync|readfile\(|get-content|readalltext"
                         r"|readalllines|fileinput\.input")
SCRIPT_REPLACE = re.compile(r"\.replace\(|\.replaceall\(|\.subn?\(|-replace|gsub")
PERL_IN_PLACE = re.compile(r"^-[a-zA-Z0-9]*i")
PS_WRITERS = {"set-content", "add-content", "out-file"}
PS_WRITE_FRAGMENTS = ["]::writealltext(", "]::writealllines(", "]::appendalltext(", "]::writeallbytes("]
PS_READ_FRAGMENTS = ["-replace", ".replace(", "get-content", "]::readall"]
PS_PATH_FLAGS = ["-path", "-filepath", "-literalpath", "-pspath"]
PS_VALUE_FLAGS = ["-encoding", "-value", "-width", "-delimiter", "-stream", "-filter", "-include", "-exclude"]
REDIRECT = re.compile(r"(?:^|[^0-9&>])>>?[ \t]*['\"]?([^ \t'\"|;&<>()]+)")


def is_edit_script(text):
    """True when `text` reads a file, replaces text and writes a file, and carries no mass-edit marker."""
    low = lower(text)
    return MARKER not in low and bool(SCRIPT_READ.search(low)) and bool(SCRIPT_REPLACE.search(low)) \
        and bool(SCRIPT_WRITE.search(low))


def resolve_in(cwd, target):
    """An absolute path for `target` (Git Bash /c/x spelling accepted) relative to `cwd`."""
    drive = re.match(r"^/([a-zA-Z])/", target) if os.name == "nt" else None
    if drive:
        target = f"{drive.group(1)}:/{target[3:]}"
    return os.path.abspath(os.path.join(str(cwd), target))


def in_work_tree(file):
    """True when a `.git` entry exists in the folder of `file` or above it."""
    folder = os.path.dirname(file)
    while True:
        if os.path.exists(os.path.join(folder, ".git")):
            return True
        parent = os.path.dirname(folder)
        if parent == folder:
            return False
        folder = parent


def read_small(file):
    try:
        if not os.path.isfile(file) or os.path.getsize(file) > SCRIPT_LIMIT:
            return None
        with open(file, encoding="utf-8", errors="replace") as handle:
            return handle.read()
    except OSError:
        return None


def powershell_target(unit):
    args = unit["tokens"][unit["program"]["index"] + 1:]
    i = 0
    while i < len(args):
        flag = lower(args[i])
        if flag in PS_PATH_FLAGS:
            return args[i + 1] if i + 1 < len(args) else None
        if args[i].startswith("-"):
            i += 2 if flag in PS_VALUE_FLAGS else 1
            continue
        return args[i]
    return None


def command_reasons(command, cwd):
    reasons = []

    def add(reason):
        if reason not in reasons:
            reasons.append(reason)

    units = units_of(command)
    low = lower(command)
    for unit in units:
        name = unit["program"]["name"]
        if name not in SCRIPT_RUNNERS:
            continue
        info = interpreter_info(unit["tokens"], unit["program"]["index"], name)
        if name == "perl" and any(PERL_IN_PLACE.search(t) for t in unit["tokens"][unit["program"]["index"] + 1:]):
            add(INLINE_REASON)
        if info["inline"]:
            if name in WRITE_INTERPRETERS and WRITE_CODE.search(low):
                add(INLINE_REASON)
            continue
        if not info["script"] or not lower(info["script"]).endswith(SCRIPT_EXTENSIONS):
            continue
        file = resolve_in(cwd, info["script"])
        if not os.path.isfile(file) or in_work_tree(file):
            continue  # repository scripts are never read: one stat and a short walk
        text = read_small(file)
        if text is not None and is_edit_script(text):
            add(SCRIPT_REASON)
    writes = any(unit["program"]["name"] in PS_WRITERS for unit in units) or any(f in low for f in PS_WRITE_FRAGMENTS)
    if writes:
        reads = any(f in low for f in PS_READ_FRAGMENTS) or any(unit["program"]["name"] in ("gc", "cat", "type")
                                                               for unit in units)
        if reads:
            add(POWERSHELL_REASON)
        for unit in units:
            if unit["program"]["name"] not in PS_WRITERS:
                continue
            target = powershell_target(unit)
            if target:
                file = resolve_in(cwd, target)
                if os.path.isfile(file) and in_work_tree(file):
                    add(POWERSHELL_REASON)
    if "<<" in command:
        for line in command.split("\n"):
            if "<<" not in line:
                continue
            for match in REDIRECT.finditer(line):
                file = resolve_in(cwd, match.group(1))
                if os.path.isfile(file) and in_work_tree(file):
                    add(HEREDOC_REASON)
    return reasons


def violations(tool_name, tool_input, cwd=None):
    """The edit-path reasons to block a call (empty: allowed)."""
    cwd = os.getcwd() if cwd is None else cwd
    if not isinstance(tool_input, dict):
        return []
    if tool_name in ("Bash", "PowerShell"):
        command = tool_input.get("command")
        return command_reasons(command, cwd) if isinstance(command, str) else []
    if tool_name == "Write":
        target = tool_input.get("file_path")
        content = tool_input.get("content")
        if not isinstance(target, str) or not target or not isinstance(content, str):
            return []
        if not lower(target).endswith(SCRIPT_EXTENSIONS):
            return []
        file = resolve_in(cwd, target)
        if os.path.exists(file) or in_work_tree(file):
            return []
        return [SCRIPT_REASON] if is_edit_script(content) else []
    return []


def main():
    try:
        payload = json.load(sys.stdin)
    except Exception:
        return 0
    if not isinstance(payload, dict):
        return 0
    cwd = payload.get("cwd") if isinstance(payload.get("cwd"), str) and payload.get("cwd") else None
    reasons = violations(payload.get("tool_name", ""), payload.get("tool_input", {}), cwd)
    if reasons:
        print("BLOCKED by edit_guard.py: " + "; ".join(reasons), file=sys.stderr)
        return 2
    return 0


if __name__ == "__main__":
    sys.exit(main())
