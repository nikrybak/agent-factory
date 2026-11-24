#!/usr/bin/env python3
import sys
from pathlib import Path
if not Path('.claude/state/quality_gate_passed.json').exists():
    print('TaskCompleted gate: no PASS quality gate found. Do not mark implementation done until tests/docs gates pass.', file=sys.stderr)
    # non-blocking by default; change to sys.exit(2) if you want hard block
sys.exit(0)
