# ADR-0009: Unified certification identity for contextual Factory evidence

**Date**: 2026-08-29
**Status**: accepted
**Deciders**: it-orchestrator, solution-architect, security-engineer, QA lead

## Context

Factory evidence currently binds to the authored source-tree hash, while the City Fabric
layout district computes a separate registry/layout digest. A registered child can therefore
retain apparently fresh workflow evidence after its registry slice or same-key illegal output
layout changes. City certification, workflow verification, provenance, ledger observation,
and the Python quality snapshot also do not consume one contextual identity.

`treeHash` is already a public source-only field used by existing receipts. Redefining it as a
composite digest would silently change its meaning and break historical comparisons.

## Decision

Introduce an internal leaf module, `cli/lib/factory/identity.js`, that returns both the stable
source tree hash and a separate certification-context identity. The contextual digest is the
canonical hash of schema version, base/child/standalone scope, registered child key when
applicable, source tree hash, and normalized resolver-owned layout input digest.

Every current workflow evidence item, City certification, verification response, v2
attestation, certification ledger event, and passing delivery plan must carry the same
`certificationIdentityDigest`. `treeHash` remains source-only. Historical v1 provenance and
ledger entries remain integrity-verifiable but cannot satisfy the current certification
contract. Python calls the internal Node identity module rather than reimplementing the
algorithm.

A passing delivery plan also carries `layoutInputDigest` and names `certification-identity`
in its required verification phase. Blocked or denied plans remain compatibility-shaped
diagnostics and do not claim current identity evidence.

For the selected local run, provenance deterministically selects the authoritative latest
attempt for every step that has evidence. A selected attempt is accepted only when its digest
is valid, its plan/source/context identities are current, and its status is PASS or a
policy-valid N/A. Any present invalid/stale/failed authoritative attempt creates an explicit
provenance gap; an empty accepted set also fails. Workflow completeness remains the separate
responsibility of `verify`, which prevents a certification-step bootstrap cycle.

Runner evidence records both `inputCertificationIdentityDigest` and
`certificationIdentityDigest`, in parallel with input/output source hashes. Any before/after
contextual difference fails the command even when authored child bytes are unchanged.

Ledger chain integrity remains a pure structural check so an empty chain can be appended to.
Normal City certification uses a separate current-certification assessment that fails for an
empty chain or a latest matching certification event whose status is not PASS. The record path
first calculates a candidate verdict with only currentness provisionally neutralized while
retaining chain integrity and every other mandatory district, appends PASS or FAIL, and then
recomputes full certification from the new ledger head.

The workflow `evals` step precedes `observability`, so its internal semantic evaluation uses the
same candidate ledger view. It neutralizes only missing/stale current-certification state while
still failing on chain tampering and every non-ledger assertion. The public `certify` command and
all final verification remain full-mode and require a current matching PASS ledger head.

## Alternatives Considered

### Overload `treeHash` with the composite identity

- **Pros**: one visible digest field.
- **Cons**: changes an established contract, obscures source-only comparisons, and breaks old receipts.
- **Why not**: compatibility and clarity require distinct source and certification-context identities.

### Keep layout digest only inside the City district

- **Pros**: minimal code change.
- **Cons**: workflow evidence, attestations, and ledger events can remain fresh after layout drift.
- **Why not**: it preserves the split-brain condition this decision closes.

### Reimplement identity independently in Python

- **Pros**: avoids invoking Node from the quality script.
- **Cons**: canonicalization and path normalization can diverge across runtimes and hosts.
- **Why not**: there must be exactly one identity algorithm.

### Grandfather historical evidence as current

- **Pros**: avoids a fresh Factory run.
- **Cons**: old evidence never observed the contextual identity and therefore cannot prove it.
- **Why not**: fail-closed freshness takes precedence over reuse.

## Consequences

### Positive

- Registry or same-key layout drift immediately invalidates contextual evidence.
- Certify, verify, attest, observe, and the quality gate agree on one current identity.
- Source-only `treeHash` consumers remain compatible.
- Child evidence ignores unrelated sibling drift while retaining its exact resolver-owned slice.

### Negative

- Existing workflow evidence becomes stale and a fresh root and child run are required.
- Current provenance moves to v2 and gains additional required digest fields.
- The Python quality gate requires the already-mandatory Node runtime to compute identity.

### Risks

- Absolute paths or platform-specific separators could make identity host-dependent; only
  normalized non-machine fields are hashed.
- Updating only one consumer would recreate split-brain evidence; parity tests cover every
  current consumer.
- A ledger bootstrap cycle could prevent PASS recording; observation uses a candidate verdict,
  appends one event, then recomputes the full current-ledger verdict.
- The workflow eval step could deadlock before observability; only that internal eval path shares
  candidate ledger currentness, while final City certification stays fail-closed.
- Selecting all planned steps during the mid-workflow City step would deadlock the DAG;
  provenance binds all authoritative attempts that exist, while `verify` owns completeness.
