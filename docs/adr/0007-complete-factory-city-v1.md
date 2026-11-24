# ADR-0007: Complete Factory City v1 as composable certified districts

## Status

Accepted — 2026-07-12.

## Context

ADR-0006 delivered an executable workflow kernel, but artifact lineage, typed workers,
adapter execution contracts, supply-chain trust, evaluation, observability, and delivery
planning were separate roadmap items. Declaring the system an autonomous software
factory while these remained narrative would repeat the false-PASS problem the kernel
was built to prevent.

## Decision

Complete a closed Factory City v1 through independently validated districts:

1. artifact graph and traceability validator;
2. canonical workforce catalog and deterministic routing;
3. stack adapter SDK with authority-aware argv plans;
4. trust policy, SBOM, and optionally signed provenance;
5. golden-scenario evaluation and append-only hash-chain ledger;
6. control-plane health report and reversible delivery planner;
7. aggregate certification bound to the current manifest and source tree.

Each district exposes pure CommonJS modules and declarative JSON. The CLI composes them
but does not own their logic. Unknown or incomplete capability is a blocking gap.

## Invariants

- Certification is `COMPLETE` only if every mandatory district is `PASS`.
- Artifact coverage is graph reachability, not filenames mentioned in prose.
- Workforce routing cannot assign conflicting author/reviewer authority to one role.
- Adapters return argv plans only and cannot weaken manifest authority.
- Trust is default-deny; SBOM/provenance are deterministic and content-addressed.
- Ledger records form a verifiable hash chain; tampering invalidates observation.
- Delivery plans always contain verification and rollback before any outward action.

## Consequences

- The factory can prove its own local completeness without credentials or external writes.
- Adding a new ecosystem becomes catalog/adapter work under the same certification contract.
- Real deployment remains authority-gated; this is a safety property, not missing automation.
