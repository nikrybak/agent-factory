#!/usr/bin/env python3
"""PostToolUse audit for Edit/Write/MultiEdit: log the call and invalidate a stale quality-gate PASS.

The PASS flag certifies the base source tree only, so it is removed only when the edited file belongs to
that tree. Files outside the base (child application repositories, agent worktrees, temp and scratch
files) and local state do not change what the gate proved (ADR-0021).
Since ADR-0028 it runs for every tool: an edit (or an unknown payload) is logged with secret-shaped text redacted; any
result holding secret-shaped text gets a WARNING line (hashes only, never the value) and a message to the model on
stderr with exit 2 (PostToolUse cannot block, the tool already ran). Exits 0 on any error.
"""
import datetime
import json
import os
import sys
from pathlib import Path

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import secret_rules  # noqa: E402

LOCAL_PATHS = {(".claude", "state")}
EDIT_TOOLS = ("Edit", "Write", "MultiEdit", "NotebookEdit")


def in_certified_tree(file_path, root):
    """True when `file_path` is part of the base tree the quality gate certifies."""
    if not file_path:
        return True  # unknown target: stay conservative
    try:
        relative = Path(file_path).resolve().relative_to(Path(root).resolve())
    except (ValueError, OSError):
        return False
    parts = relative.parts
    if any(parts[: len(local)] == local for local in LOCAL_PATHS):
        return False
    is_child_repository = (
        len(parts) > 2 and parts[0] == "app_entry_root" and parts[1] != "_registry" and parts[2] != "_project"
    )
    return not is_child_repository and ".git" not in parts and ".factory" not in parts


def stamp():
    return datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.%f")[:-3] + "Z"


def main():
    state = Path(".claude/state")
    try:
        payload = json.load(sys.stdin)
    except Exception:
        payload = {}
    tool_name = payload.get("tool_name") if isinstance(payload, dict) else None
    value, findings = secret_rules.scan_value(payload if isinstance(payload, dict) else {})
    logged = not isinstance(tool_name, str) or tool_name in EDIT_TOOLS
    if logged or findings:
        state.mkdir(parents=True, exist_ok=True)
    log_path = state / "tool_audit.log"
    if logged:
        with log_path.open("a", encoding="utf-8") as log:
            log.write(stamp() + " " + json.dumps(value, ensure_ascii=False)[:2000] + "\n")
        tool_input = payload.get("tool_input") if isinstance(payload, dict) else None
        file_path = tool_input.get("file_path") if isinstance(tool_input, dict) else None
        flag = state / "quality_gate_passed.json"
        if flag.exists() and in_certified_tree(file_path, Path.cwd()):
            flag.unlink()
    if not findings:
        return 0
    name = "" if tool_name is None else str(tool_name)
    with log_path.open("a", encoding="utf-8") as log:
        log.write(f"{stamp()} WARNING secret-shaped output tool={json.dumps(name, ensure_ascii=False)} "
                  f"findings={','.join(findings)}\n")
    print(secret_rules.output_warning(findings), file=sys.stderr)
    return 2


if __name__ == "__main__":
    try:
        sys.exit(main())
    except Exception:
        sys.exit(0)
