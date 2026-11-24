# ADR-0019: CI scope of the quality gate

Date: 2026-10-04
Status: Accepted — refines how `scripts/quality_gate.py` runs in hosted CI; ADR-0014 is unchanged

## Context

`scripts/quality_gate.py` is the blocking, tree-bound gate behind Absolute Rule 4. Besides the
Node and Python suites, coverage and the required documents, it selects the latest Factory run
and requires `infra certify` to return `COMPLETE` for it.

Hosted CI (`.github/workflows/ci-universal.yml`) ran the same script on a clean checkout. That
can never pass:

1. A clean checkout has no `.factory/` run, so run selection and `certify` fail with
   `no factory run exists`.
2. Even with a fresh run, the base's own Python component is a non-anchor tool. ADR-0014 lets
   only the operator enrol it, locally, by exact digest, with no TOFU and no automatic
   enrollment, so a runner's interpreter stays `EVIDENCE_TOOLCHAIN_UNAUTHORIZED` and the
   workflow policy is blocked.

The job was therefore red regardless of the change, and the checks it could prove were hidden
behind the one it could not.

## Decision

1. `quality_gate.py` takes `--scope local|ci`, default `local`. The local scope is unchanged:
   run selection and `certify` stay mandatory, and only a PASS writes
   `.claude/state/quality_gate_passed.json`.
2. The `ci` scope runs every check a clean runner can prove: required documents, the Node
   suite, the Factory coverage suite and threshold, the Python suite and the guarantee that the
   checks did not modify the certification input.
3. In the `ci` scope Factory City certification is not run, and that is stated, not hidden:
   the report records `"scope": "ci"` and `"certification": "operator-local, not run"`, and the
   console says so.
4. A `ci`-scope result never writes the PASS flag and grants no authority to commit, push,
   publish, deploy or release. Those still require the local gate with certification.
5. `ci-universal.yml` runs `python scripts/quality_gate.py --scope ci`.

## Consequences

- CI is green exactly when everything a runner can verify passes, and red otherwise.
- Certification evidence stays operator-local, as ADR-0014 requires; CI never enrols tools.
- A failing check fails both scopes; the `ci` scope removes only the step a runner cannot run.

## Alternatives

- **Enrol the runner's interpreter in CI.** Rejected: it would be TOFU enrollment, which
  ADR-0014 forbids, and setup-python binaries change with every patch release.
- **Skip certification silently.** Rejected: a skipped mandatory step must be explicit.
- **Drop the CI job.** Rejected: the suites and the input-mutation guard are worth running on
  every push and pull request.
