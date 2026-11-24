#!/bin/bash
# base-gate.sh [runId]: the base quality gate in one command (see docs: base gate procedure).
# Plans a fresh workflow run (or resumes runId), runs every ready step one at a time (plannedNa steps end NA), then
# verify, certify and scripts/quality_gate.py. The factory launcher accepts only the real governed Python (one hard link),
# so GOVERNED_PYTHON_DIR must name its folder (the interpreter, not a shim) and is put first on PATH.
set -u
cd "$(dirname "$0")/.." || exit 2
if [ -z "${GOVERNED_PYTHON_DIR:-}" ]; then
  echo "[base-gate] set GOVERNED_PYTHON_DIR to the governed Python folder (the plan policy is blocked without it)" >&2
  exit 2
fi
export PATH="$GOVERNED_PYTHON_DIR:$GOVERNED_PYTHON_DIR/Scripts:$PATH"
I="node cli/bin/infra.js"
RID=${1:-$($I plan --project . --json 2>/dev/null | python -I -c "import json,sys; print(json.load(sys.stdin)['data']['plan']['runId'])")}
echo "run: $RID"
for _ in $(seq 1 40); do
  NEXT=$($I status --project . --run "$RID" --json 2>/dev/null | python -I -c "
import json,sys; w=json.load(sys.stdin)['data']['workflow']; r=w.get('ready') or []; print(r[0] if r else '')")
  [ -z "$NEXT" ] && break
  ST=$($I run --project . --run "$RID" --step "$NEXT" --json 2>/dev/null | python -I -c "
import json,sys
try: d=json.load(sys.stdin); print(d['status'], (d.get('data',{}).get('evidence') or {}).get('reason') or '', [x.get('message') for x in d.get('diagnostics',[])][:2])
except Exception as e: print('ERR', e)")
  echo "step $NEXT: $ST"
done
$I status --project . --run "$RID" --json 2>/dev/null | python -I -c "
import json,sys; w=json.load(sys.stdin)['data']['workflow']; print('runState', w['runState']); [print(' ',k,v.get('state')) for k,v in w['steps'].items() if v.get('state')!='PASS']"
$I verify --project . --run "$RID" 2>&1 | tail -2
$I certify --project . --run "$RID" --json 2>/dev/null | python -I -c "import json,sys; d=json.load(sys.stdin); print('certify', d['status'])"
python scripts/quality_gate.py 2>&1 | tail -4
