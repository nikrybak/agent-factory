# API Contracts

| Endpoint/Method | Consumer | Request | Response | Errors | Tests | Postman/OpenAPI |
|---|---|---|---|---|---|---|
| `infra init` | operator/AI harness | project root, profile, dry-run/force | manifest/schema creation envelope | usage, validation, existing manifest | factory engine + CLI E2E | N/A local CLI |
| `infra detect` | planner | project root, depth, write | components, capabilities, confidence, evidence, gaps | unsafe root, detector failure | detector + CLI E2E | N/A local CLI |
| `infra plan` | orchestrator | manifest, detection, goal/run id | policy-bound workflow DAG | invalid/stale manifest, capability gap | policy/workflow/engine | N/A local CLI |
| `infra run` | executor | ready step and optional argv exactly matching its plan-time semantic binding | bounded provider-bound evidence carrying source and certification-context identities | unbound/legacy plan, command/cwd/provider mismatch, not ready, policy denied, timeout, mutation, exit failure | provider + runner + CLI E2E | N/A local CLI |
| `infra status/resume` | operator/AI harness | project/run | derived states and ready/failed/blocked work | missing/corrupt run | workflow/engine | N/A local CLI |
| `infra verify/explain` | quality/review | project/run/optional step | fresh aggregate verdict or decision trace with additive contextual identity | missing/tampered/stale/context-mismatched evidence | evidence/engine/CLI E2E | N/A local CLI |
| `infra trace/workforce/adapters/trust` | orchestrator | project and optional operation/tool | district plan/report and gaps | invalid catalog, orphan, unsupported, denied | district + CLI tests | N/A local CLI |
| `infra sbom/attest/eval` | QA/security | project, explicit governed run for eval; external signing/public inspection key for attest | inventory, current provider-bound provenance with separate advisory/release assessment, candidate-level semantic evaluation | wrong stage/run, malformed manifest, missing evidence, chain/binding/identity/policy/key mismatch, threshold failure | supply-chain + stage/eval tests | N/A local CLI |
| `infra observe/control/release-plan` | operations | project, explicit governed run for record/delivery, action | read-only ledger health or candidate record; identity-bound reversible plan | wrong stage/run, broken chain, denied authority, incomplete City/workflow | operations + stage/CLI tests | N/A local CLI |
| `infra certify` | quality gate | project, explicit governed run, current tree and resolver layout | City verdict plus independent workflow completion state | wrong stage/run, changed input, unbound evidence, failing district | identity + provider/stage + City integration | N/A local CLI |
| `infra project resolve [key]` | gates/operator | explicit registry key, cwd, or `--cwd` | scope, registry key, root-bounded knowledge/app/output/runtime context | no Factory root, unknown key, malformed registry or escaping path | resolver + CLI tests | N/A local CLI |
| `infra project list/paths/scan` | planner/operator | optional key/version | declared children, derived paths, or registry-drift report | unknown key, invalid schema, disk/registry mismatch | resolver + CLI tests | N/A local CLI |

All command names, options, and existing `treeHash` semantics remain unchanged by ADR-0009.
The contextual identity fields are additive. Historical v1 attestations and ledger entries remain
cryptographically auditable but cannot satisfy a current certification.
The internal eval path neutralizes only ledger currentness because eval precedes observability in
the governed DAG; the public certify path always requires a current matching PASS ledger event.
A passing delivery plan preserves `treeHash`, `certificationIdentityDigest`, and
`layoutInputDigest`, and requires `certification-identity` in its verification phase.
City completion before downstream quality/checkpoint is prepare-only; release, deploy, and
publish independently require the selected workflow run to be COMPLETE.

`infra attest` keeps its existing command and options. A signing key derives its public SPKI
fingerprint and must select one unique governed key identity; filenames never become key IDs.
Unsigned current output is `ADVISORY`. A supplied `--public-key` can inspect a signature but never
creates release trust. Release-grade assessment applies to the exact completed run and is an
additional mandatory input to outward delivery; prepare-only planning remains advisory-capable.
The trust-policy provenance section is additive and missing legacy sections deny release grade.

All CLI responses and errors pass through the same versioned recursive redaction boundary.
Governed plans reject credential-bearing argv instead of serializing resolved secrets. Evidence
bindings and receipts expose only sanitized bounded output and the same current policy version
used before their plan/evidence digests. Missing or mismatched versions require re-plan/re-run.
This contract covers Factory command envelopes and Factory errors handled by `cli/bin/infra.js`;
it does not silently change unrelated legacy compiler output.

Candidate observation records through one project-scoped ledger transaction. Its calculation,
event status, expected head/sequence, atomic replacement, and returned post-state refer to the
same locked snapshot. Lock timeout, owner mismatch, invalid chain, and head conflict are named
fail-closed errors.

Stage-provider failures expose only a versioned allowlisted diagnostic record. Known failures may
replace the former generic code in a new failed receipt; successful receipts are unchanged and
historical failed receipts are never rewritten.

The exact diagnostic record is `{schemaVersion, operation, code, category, retryable}`. Its stable
allowlist is: lock timeout → `STAGE_PROVIDER_LEDGER_LOCK_TIMEOUT/contention/true`; head conflict →
`STAGE_PROVIDER_LEDGER_HEAD_CONFLICT/conflict/true`; unconfirmed commit →
`STAGE_PROVIDER_LEDGER_COMMIT_UNCONFIRMED/durability/false`; invalid JSON/chain →
`STAGE_PROVIDER_LEDGER_INVALID/integrity/false`; unsafe path →
`STAGE_PROVIDER_LEDGER_PATH_UNSAFE/policy/false`; owner mismatch →
`STAGE_PROVIDER_LEDGER_OWNER_MISMATCH/integrity/false`; redaction failure →
`STAGE_PROVIDER_REDACTION_FAILED/security/false`. Every other input maps to
`STAGE_PROVIDER_EXECUTION_FAILED/internal/false`.

Evidence bindings and receipts add `filesystemBoundaryVersion` and
`filesystemCapabilityDigest`. Both are exact current-runtime trust inputs, participate in the
binding/evidence digest, and are intentionally required: historical objects without them are
untrusted and require re-plan/re-run. No filesystem path, native error or object identity is
added to the public envelope.

Run-lock expiry is informational and never permits automatic stealing. Release succeeds only for
the exact owner and exact observed lock object; any mismatch is `RUN_LOCK_OWNER_MISMATCH`, while
acquisition of any existing lock is `RUN_LOCK_HELD`. The public command surface is unchanged.

## Local toolchain trust file contract

`<project>/.factory/toolchain-trust.json` is an ignored operator-local input validated against
`factory/schema/toolchain-trust.schema.json`. Its exact top-level fields are `schemaVersion`,
`platformFamily`, and sorted `entries`; every entry contains one normalized non-anchor
`logicalExecutable` and a sorted unique list of exact lowercase SHA-256 values. Unknown fields,
duplicate keys, reserved `node`/`npm`/`npx` names, platform mismatch, unsafe opened identity and
non-canonical ordering fail closed.

There is deliberately no public enrollment endpoint, CLI command, option, or network transport.
The internal enrollment primitive requires an absolute native executable path, an independently
operator-confirmed digest, and compare-and-swap against the current overlay digest. Consequently
OpenAPI, Postman, browser E2E and public API versioning are N/A. Existing `infra plan`, `status`,
`run`, `verify`, and receipt formats consume the trust identity internally; missing non-anchor
authority is the explicit `EVIDENCE_TOOLCHAIN_UNAUTHORIZED` planning gap.

The local file authorizes only exact opened bytes on one platform family. It is not release-grade
provenance or external authority. Binary updates require re-enrollment/re-plan/re-run, and no
claim is made that registered child adapters or all host-native formats are enrolled.

## Component, adapter, and operation evidence contracts

Project, detection, adapter, stack-signal, and provider documents support schema `1.1.0` while
retaining read-only compatibility with `1.0.0`. A v1.1 declared stack component supplies exact
`id`, `family`, root-relative `root`, and `adapterId`; detection output preserves those identities.
Absolute tracked paths are invalid. Duplicate-family adapters are resolved only by exact
`adapterId`, except when the family has one unique candidate. Unknown, mismatched, or ambiguous
adapter identity is a blocking gap; no catalog fallback exists.

An adapter operation contains exactly one `argv` or one ordered
`commands: [{id, argv}]` collection. Command IDs are unique within that operation. Every argv is
credential-free, shell-free, authority-checked, and physically authorized independently.
Adapter `1.1.0` additionally permits a per-command integer `timeoutMs` from 1,000 through
21,600,000. For one `argv` it is authored beside `argv`; for ordered commands it is authored on
each child. The value is sealed into the command/binding hashes and the runner uses it instead of
a shorter fallback. Top-level multi-command timeouts, v1.0 timeouts, drift, and out-of-range values
fail closed.

`${projectRoot}` is a reserved whole-argv-token context value. At plan time it resolves from the
trusted repository root plus the unique declared or detected component's relative root to an existing,
canonical, boundary-confined absolute directory. It cannot be embedded in a larger token; missing,
unsafe, malformed, unknown, non-directory, and escaping contexts fail closed. The authored catalog
remains machine-neutral, while ignored local plans necessarily bind the resolved host path and must
be regenerated after checkout relocation. Expanded argv is covered by command/aggregate/binding and
receipt identity; executable identity remains the separate launch-binding responsibility.

A composite provider v1.1 operation contains a `name` and an exact
`selector.componentIds` set. An optional N/A entry contains `componentId`, stable `reasonCode`,
and bounded `reason`, and is valid only when the selected adapter explicitly lists the named
operation in `unsupported`. A supported operation cannot be N/A; an unsupported operation without
the exact justified N/A target blocks planning.

Binding `1.1.0` exposes exact target and command children plus target/command aggregate hashes.
Receipt schema version `2` repeats every target as executable child results or an auditable N/A
child. Partial execution, child failure, omission, order drift, selector drift, component/adapter
mismatch, N/A conflict, and aggregate mismatch fail the provider. Version 1.0 artifacts remain
readable for audit, but old bindings/receipts are stale for current evidence and require
re-plan/re-run. These are internal local CLI/file contracts; no network API, OpenAPI, Postman, or
browser surface is added.

Container CLI plugins are separate physical tools for this contract. A plan that executes
buildx, compose, or Scout binds the exact plugin executable and its enrolled digest; binding only
the parent Docker CLI does not authorize plugin discovery. Operator-local PATH order and copied
single-link tool views remain ignored host inputs, while tracked catalogs stay path-free.
