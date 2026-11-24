# Test Strategy

## Component-owned adapter and operation evidence matrix

The v1.1 migration is verified at schema, pure-module, integration, and CLI boundaries. Fixtures
must prove stable component IDs and roots, catalog-owned build-root/module absorption,
same-root multi-family preservation, exact duplicate-family adapter selection, and blocking
ambiguity when `adapterId` is absent. Adapter tests cover exactly one argv or ordered command list,
unique command IDs, shell denial, and all-command failure propagation.

Provider/evidence tests select exact component IDs per operation and assert binding `1.1.0`,
receipt schema version `2`, exact child order, target and command aggregate hashes, and auditable
N/A children only for adapter-declared unsupported operations. Legacy v1.0 documents remain
readable, but legacy bindings cannot satisfy current plan, verify, provenance, City, or delivery
gates. Current physical toolchain trust and opened-catalog assurance remain mandatory for every
executable child.

The registered Worlio integration fixture is exact: five components; two Java components use
different explicit adapter IDs; Docker coverage is N/A; Unity security is N/A; every other
selected test, coverage, and security target must execute and pass for an aggregate PASS.

## Policy

- Changed modules must have tests.
- New modules require unit tests and docs.
- UI changes require browser/E2E tests.
- API changes require contract/API tests.
- Target coverage: 100% for changed/new modules unless explicitly lowered by the user.

## Test pyramid

- Unit/component tests: required.
- Integration tests: required for module boundaries, DB/API/external services.
- E2E tests: required for user-facing flows.

## Commands

Core verification for this repository:

```bash
node scripts/run_node_tests.js
node cli/bin/infra.js sync --check
node cli/bin/infra.js validate
node cli/bin/infra.js doctor
python scripts/quality_gate.py
```

Hosted CI runs `python scripts/quality_gate.py --scope ci` (ADR-0019): the same suites,
coverage, required documents and unchanged-input guard, with Factory City certification
reported as operator-local and not run. That result never writes the PASS flag; commit,
push and release still need the local gate with certification.

The suite runs on Windows and on Linux (a hosted runner: unprivileged user, LF checkout,
POSIX Node layout). Tests that model one platform use that platform's real file layout, and
skill registry hashes are computed over the LF bytes Git stores.

The bounded Node entry point discovers only `cli/test/*.test.js` and
`tests/*.test.js`. A City Fabric base can contain local registered child checkouts,
whose generated reports may include browser-side JavaScript under directories named
`test`; those local artifacts are not part of the base repository test surface.

## Contract for the universalization change

- Canon/config: generator and conformance tests must prove removed integrations are absent.
- Skills: validation must prove all remaining references resolve; repository search must prove removed skill names are absent.
- Templates: generic detection/version behavior remains covered while the registry may contain zero templates.
- Generated outputs: `sync --check` must pass after regeneration.
- UI/API/DB E2E: not required because this change removes an embedded stack and adds no runtime surface.

## Factory kernel contract

- Unit: manifest, detector, policy, DAG transitions, atomic store, evidence freshness, safe runner.
- Integration: initialize/plan/run/resume/verify against temporary repositories.
- CLI E2E: every command in human and JSON mode; legacy compiler commands remain green.
- Security: reject root escape, invalid step/status, shell metacharacter interpretation,
  oversized output, stale evidence, and premature downstream execution.
- Coverage: at least 80% lines/branches/functions for new kernel modules; target 100% for pure policy/DAG logic.
- Browser/API/DB E2E: N/A because the kernel adds a local CLI and file contracts only.

## Factory City v1 district contract

| Module | Unit contract | Integration contract | Security/failure contract |
|---|---|---|---|
| Traceability | graph validation, reachability, deterministic coverage | repository artifact graph | traversal, symlink, dangling/orphan rejection |
| Workforce | role schema and minimal routing | policy/detection to handoff plan | separation of duties and authority denial |
| Adapters | catalog and operation selection | detected families to argv plans | unknown operation, shell string, missing authority |
| Trust/SBOM/provenance | tier rules, inventory, hashes/signatures | manifest/tree/evidence attestation | egress denial, tamper and invalid signature |
| Evals/ledger | scoring and hash-chain verification | golden suite to durable observation | regression threshold and chain tamper |
| Control/delivery/city | aggregate health and reversible plan | CLI certification on this repository | missing district, denied action, stale tree |
| Semantic evidence providers | canonical binding and exact receipt validation | current detection/catalog re-resolution and complete multi-component execution | no-op, replay, self-rehash, detection drift, empty/partial/reordered receipt |
| Workflow stages | explicit-run purpose/state matrix | candidate eval/observe → City → quality → prepare-only checkpoint reaches COMPLETE | cross-run ledger, latest fallback, premature write/certification/outward action |
| Ledger transaction store | pure chain/head/sequence rules | 16–32 real concurrent process appends and candidate snapshot-to-commit flow | owner mismatch, orphan lock, invalid chain, pre-rename fault, CAS conflict, partial visibility |
| Evidence redaction | classifier, argv/value/text idempotence and safe near-misses | runner → receipt → disk round-trip plus JSON/human envelope parity | canary in every flag/header/URL/query/env/chunk/truncation/nested/error boundary; sanitizer fault fails closed |
| Opened catalog boundary | descriptor/path/ancestor identity, bounded bytes and capability identity | catalog loader → plan binding → receipt → runtime reassessment | static junction/link/non-regular/hardlink, deterministic replacement hooks, path/native canaries, authoritative-consumer enforcement |
| Owner-safe run locks | exact schema/token/object ownership and no expiry takeover | real process holds beyond TTL, contender blocks, release permits one successor | malformed/replaced/linked lock preserved; ignored release cannot return PASS |
| Physical toolchain trust | strict overlay schema, exact anchors, digest/CAS enrollment, native-format policy and fixed path-free errors | overlay/plan freshness plus pre-spawn, post-exit and receipt parity across provider/runner/evidence/engine | PATH without authority, TOFU absence, anchor collision, wrapper/control interpreter, binary/overlay drift and explicit planning gap |

Every new district requires behavior and error-path tests. Aggregate line, branch, and
function coverage remains at least the manifest threshold; security-critical pure modules
target 90%+ line coverage. Browser E2E is N/A because the control tower is a local JSON/CLI
surface and no browser UI or network API is added.

For ADR-0014, public API/browser E2E is N/A because the change adds no public enrollment command,
HTTP endpoint or UI. The operator-visible contract is the ignored local
`.factory/toolchain-trust.json` schema; its behavior is verified through unit and local CLI/engine
integration tests. Tests must not infer release trust or universal child-adapter readiness from a
locally authorized digest.
