#!/usr/bin/env python3
import sys, json
from pathlib import Path
# Soft feedback on stop: do not block every chat, but remind if files changed and gate absent.
state = Path('.claude/state/tool_audit.log')
flag = Path('.claude/state/quality_gate_passed.json')
if state.exists() and not flag.exists():
    print('NOTE: Files/tools were used and quality gate is not marked PASS. Before commit/release run `/mandatory-quality-gate`.', file=sys.stderr)
sys.exit(0)
