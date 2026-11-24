#!/usr/bin/env python3
"""Claude Code PreToolUse guard.
Blocks destructive shell commands and blocks commit/push/release commands unless quality gate passed.
Reads JSON from stdin. Exits 2 to block in Claude Code hook conventions.
"""
import json, sys, os, re, time
from pathlib import Path

payload = {}
try:
    payload = json.load(sys.stdin)
except Exception:
    payload = {}

raw = json.dumps(payload, ensure_ascii=False).lower()
command = ""
for key in ("command", "cmd", "input"):
    val = payload.get(key)
    if isinstance(val, str): command += " " + val
    elif isinstance(val, dict): command += " " + json.dumps(val, ensure_ascii=False)
command = (command or raw).lower()

blocked_patterns = [
    r"rm\s+-rf\s+[/~.]", r"sudo\s+rm", r"del\s+/s\s+/q", r"format\s+[a-z]:",
    r"git\s+reset\s+--hard", r"git\s+clean\s+-fd", r"curl\s+.*\|\s*sh", r"wget\s+.*\|\s*sh",
    r"npm\s+publish", r"gh\s+pr\s+merge"
]
for pat in blocked_patterns:
    if re.search(pat, command):
        print(f"BLOCKED by pretool_guard.py: dangerous command matched `{pat}`. Ask user for explicit confirmation and safer plan.", file=sys.stderr)
        sys.exit(2)

quality_required = [r"git\s+commit", r"git\s+push", r"gh\s+pr\s+create", r"gh\s+release", r"npm\s+version", r"docker\s+push"]
if any(re.search(pat, command) for pat in quality_required):
    flag = Path('.claude/state/quality_gate_passed.json')
    if not flag.exists():
        print("BLOCKED: quality gate has not passed. Run `/mandatory-quality-gate` or `python scripts/quality_gate.py` first.", file=sys.stderr)
        sys.exit(2)
    try:
        data = json.loads(flag.read_text(encoding='utf-8'))
        if data.get('status') != 'PASS':
            raise ValueError('status not PASS')
    except Exception:
        print("BLOCKED: quality gate flag is invalid or not PASS.", file=sys.stderr)
        sys.exit(2)

sys.exit(0)
