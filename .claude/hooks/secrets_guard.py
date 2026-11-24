#!/usr/bin/env python3
"""Claude Code PreToolUse guard for secret overlays (every tool, main session and subagents).

Blocks any tool call that would read, search or write an ignored secret overlay:
- a path into a `.secrets` directory, or the real vault files `global.env` / `test.env`
  (their `*.env.example` templates stay allowed), in file paths, search roots, globs and
  shell commands;
- recursive `grep` (it ignores `.gitignore` and reads `.secrets/`): use `rg` or `git grep`;
- searches that switch ignore handling off (`rg -u`/`--no-ignore`, `git grep --no-exclude-standard`).
Document text written by Edit/Write is not inspected, so docs may still mention `.secrets/`.
Since ADR-0028 it also applies the registry rules of secret_rules.py (secret stores of secret_paths.json, printed
environment variables, clipboard reads); the arguments of a `scripts/secret.js` call are the sanctioned access.
Exit 2 blocks the call; the message tells the agent what to use instead. Parse errors allow the call.
"""
import json
import os
import re
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import secret_rules  # noqa: E402

SECRET_PATH = re.compile(r"(^|[\\/\s'\"=:])\.secrets([\\/\s'\"]|$)", re.IGNORECASE)
VAULT_FILE = re.compile(r"(?<![\w.-])(global|test)\.env(?![\w.])", re.IGNORECASE)
RECURSIVE_GREP = re.compile(
    r"(^|[\s;|&(`])(e|f)?grep\s+(?:[^|;&]*\s)?(-[a-zA-Z]*[rR][a-zA-Z]*|--recursive|--dereference-recursive)(\s|=|$)"
)
NO_IGNORE = re.compile(
    r"(^|[\s;|&(`])rg\s+(?:[^|;&]*\s)?(-[a-zA-Z]*u[a-zA-Z]*|--no-ignore\S*|--unrestricted)(\s|$)"
    r"|git\s+grep\s+(?:[^|;&]*\s)?--no-exclude-standard"
)
PATH_FIELDS = ("file_path", "path", "notebook_path", "pattern", "glob")


def violations(tool_name, tool_input):
    """Return the reasons a tool call must be blocked (empty when it is allowed)."""
    if not isinstance(tool_input, dict):
        return []
    found = []
    texts = [str(tool_input.get(field, "")) for field in PATH_FIELDS if tool_input.get(field)]
    command = tool_input.get("command") if tool_name in ("Bash", "PowerShell") else None
    if isinstance(command, str):
        texts.append(secret_rules.legacy_text(command) if "secret.js" in command else command)
        if RECURSIVE_GREP.search(command):
            found.append("recursive grep ignores .gitignore and reads secret overlays; use `rg` or `git grep`")
        if NO_IGNORE.search(command):
            found.append("searching with ignore rules switched off can read secret overlays")
    for text in texts:
        if SECRET_PATH.search(text) or VAULT_FILE.search(text):
            found.append("secret overlays (.secrets/, global.env, test.env) are owner-only; never read, search or write them")
            break
    for reason in secret_rules.violations(tool_name, tool_input):
        if reason not in found:
            found.append(reason)
    return found


def main():
    try:
        payload = json.load(sys.stdin)
    except Exception:
        return 0
    reasons = violations(payload.get("tool_name", ""), payload.get("tool_input", {}))
    if reasons:
        print("BLOCKED by secrets_guard.py: " + "; ".join(reasons), file=sys.stderr)
        return 2
    return 0


if __name__ == "__main__":
    sys.exit(main())
