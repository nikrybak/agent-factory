#!/usr/bin/env bash
# One ephemeral job (ADR-0022): a clean workspace, the slot's Docker daemon, then the runner with its
# just-in-time configuration. The runner takes exactly one job and the container exits with it.
set -euo pipefail

if [ -z "${INFRA_RUNNER_JITCONFIG:-}" ]; then
  echo "[infra-runner] no just-in-time configuration" >&2
  exit 64
fi
jit="$INFRA_RUNNER_JITCONFIG"
unset INFRA_RUNNER_JITCONFIG

# the work volume is shared with the slot's Docker daemon and survives the container: start clean
find /home/runner/_work -mindepth 1 -maxdepth 1 -exec rm -rf {} + 2>/dev/null || true

for _ in $(seq 1 60); do
  docker info > /dev/null 2>&1 && break
  sleep 1
done
docker info > /dev/null 2>&1 || { echo "[infra-runner] the slot's Docker daemon is not reachable" >&2; exit 69; }

cd /home/runner
exec ./run.sh --jitconfig "$jit"
