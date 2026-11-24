#!/usr/bin/env python3
import json, sys, datetime
from pathlib import Path
Path('.claude/state').mkdir(parents=True, exist_ok=True)
try:
    payload = json.load(sys.stdin)
except Exception:
    payload = {}
log = Path('.claude/state/tool_audit.log')
with log.open('a', encoding='utf-8') as f:
    f.write(datetime.datetime.utcnow().isoformat() + 'Z ' + json.dumps(payload, ensure_ascii=False)[:2000] + '\n')
# invalidate previous PASS after file edits
flag = Path('.claude/state/quality_gate_passed.json')
if flag.exists():
    flag.unlink()
sys.exit(0)
