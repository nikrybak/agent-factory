#!/usr/bin/env python3
"""Claude Code PreToolUse guard for Bash (main session and subagents).

- Blocks destructive shell commands.
- Blocks foreground polling loops (`until|while …; do … sleep …`): wait for a background task's completion
  notification instead (ADR-0021). The same loop with `run_in_background` (one notification) is allowed.
- Blocks RELEASE commands (merge/push/pull request into main or master, tags, gh release, npm version, docker push) that
  target THIS base repository unless the base quality gate passed; commits and pushes on dev only need the fast checks
  (owner 2026-10-26).
  Commands addressed with `git -C <path>` to another repository (child application repositories, agent
  worktrees) are outside what the base gate certifies; those repositories gate through their own full runs.
Only the command text is inspected, never the tool description. Exit 2 blocks; parse errors allow.
"""
import json
import os
import re
import shlex
import sys
from pathlib import Path

BLOCKED = [
    r"rm\s+-rf\s+[/~.]", r"sudo\s+rm", r"del\s+/s\s+/q", r"format\s+[a-z]:",
    r"git\s+reset\s+--hard", r"git\s+clean\s+-fd", r"curl\s+.*\|\s*sh", r"wget\s+.*\|\s*sh",
    r"npm\s+publish", r"gh\s+pr\s+merge",
]
POLLING = re.compile(r"\b(until|while)\b[^\n]*?;\s*do\b[\s\S]*?\bsleep\b")
# `tail -f/-F … | grep -m1/-q`: grep exits on the match but tail never notices until its next write, so the
# waiter hangs forever, in the foreground and in the background alike.
FOLLOW_WAIT = re.compile(r"\btail\b[^|;&\n]*\s(?:-[a-zA-Z]*[fF][a-zA-Z]*|--follow\S*)(?=\s|$)[^|;&\n]*\|")
QUALITY = [r"git\s+(?:-C\s+\S+\s+)?commit", r"git\s+(?:-C\s+\S+\s+)?push", r"gh\s+pr\s+create", r"gh\s+release\s",
           r"npm\s+version", r"docker\s+push"]
GIT_TARGETED = re.compile(r"git\s+-c\s+(\"[^\"]+\"|'[^']+'|\S+)\s+(commit|push|tag|merge)\b")
# Owner 2026-10-26: the full gate is for releases, not for development. Commits and pushes on dev pass with the fast checks;
# the gate is required to merge, push or open a pull request into main/master, to tag, and to release or publish.
RELEASE = [r"gh\s+release\s", r"npm\s+version", r"docker\s+push", r"git\s+(?:-c\s+\S+\s+)?tag\b",
           r"git\s+(?:-c\s+\S+\s+)?(?:push|merge)\b[^\n;&|]*\b(?:main|master)\b", r"git\s+(?:-c\s+\S+\s+)?push\b[^\n;&|]*--tags",
           r"gh\s+pr\s+(?:create|merge)\b[^\n;&|]*\b(?:main|master)\b"]


def release_targeted(command):
    """True when the (lower-cased) `command` releases: into main/master, a tag, a release or a publish."""
    return any(re.search(pattern, command) for pattern in RELEASE)


def is_child_or_outside(path_text, root):
    """True when a `git -C` target is a different repository than the base itself."""
    try:
        raw = shlex.split(path_text)[0] if path_text[:1] in "\"'" else path_text
        raw = re.sub(r"^/([a-zA-Z])/", r"\1:/", raw)
        target = os.path.normcase(os.path.abspath(os.path.join(str(root), raw)))
        base = os.path.normcase(os.path.abspath(str(root)))
        relative = os.path.relpath(target, base)
    except (ValueError, OSError, IndexError):
        return True  # another drive: outside the base tree
    if relative == os.pardir or relative.startswith(os.pardir + os.sep):
        return True
    parts = Path(relative).parts
    return len(parts) >= 3 and parts[0] == "app_entry_root" and parts[1] != "_registry" and parts[2] != "_project"


def base_targeted(command, root):
    """True when a commit/push/release in the (lower-cased) `command` may act on the base repository."""
    if not any(re.search(pattern, command, re.I) for pattern in QUALITY) and not release_targeted(command):
        return False
    addressed = GIT_TARGETED.findall(command)
    plain = re.findall(r"git\s+(?:-c\s+\S+\s+)?(commit|push|tag|merge)\b", command)
    other = any(re.search(pattern, command, re.I) for pattern in QUALITY[2:])
    if other or len(plain) > len(addressed):
        return True
    return not all(is_child_or_outside(path, root) for path, _ in addressed)


def gate_passed(root):
    flag = root / ".claude" / "state" / "quality_gate_passed.json"
    try:
        return json.loads(flag.read_text(encoding="utf-8")).get("status") == "PASS"
    except Exception:
        return False


def decide(payload, root):
    """Return a blocking message, or None to allow."""
    tool_input = payload.get("tool_input") if isinstance(payload.get("tool_input"), dict) else {}
    command = tool_input.get("command") if isinstance(tool_input.get("command"), str) else payload.get("command")
    if not isinstance(command, str):
        return None
    lowered = command.lower()
    for pattern in BLOCKED:
        if re.search(pattern, lowered):
            return f"BLOCKED by pretool_guard.py: dangerous command matched `{pattern}`. Ask user for explicit confirmation and safer plan."
    if FOLLOW_WAIT.search(command):
        return ("BLOCKED by pretool_guard.py: `tail -f | …` never exits after a match. Start the job itself in the "
                "background and wait for its completion notification, then read the log once (ADR-0021).")
    if POLLING.search(command) and not tool_input.get("run_in_background"):
        return ("BLOCKED by pretool_guard.py: foreground polling loop. Run the job in the background and wait for its "
                "completion notification (ADR-0021).")
    if release_targeted(lowered) and base_targeted(lowered, root) and not gate_passed(root):
        return "BLOCKED: quality gate has not passed. Run `/mandatory-quality-gate` or `python scripts/quality_gate.py` first."
    return None


def main():
    try:
        payload = json.load(sys.stdin)
    except Exception:
        return 0
    message = decide(payload if isinstance(payload, dict) else {}, Path.cwd())
    if message:
        print(message, file=sys.stderr)
        return 2
    return 0


if __name__ == "__main__":
    sys.exit(main())
