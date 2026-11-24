# ADR 0017: Deterministic self-hosted Node boundary

## Status

Accepted — 2026-08-30.

## Context

The base and nested CLI are detected as separate Node components. A bare `node --test` from the CLI
also discovers executable fixture files, while generic Python coverage writes `.coverage` beside
source. Both behaviours can fail a correct suite or mutate certification identity.

## Decision

All root and CLI Node test/coverage scripts call `scripts/run_node_tests.js`. That script discovers
only top-level `*.test.js` files in `cli/test` and `tests`; coverage adds only Node's explicit
coverage flag to the same ordered file list. The standard `.coverage` file is classified as
generated runtime state and excluded wherever it appears, matching existing exclusions for
`coverage`, `.pytest_cache`, build and test-result directories.

Every declared npm component also tracks a version-3 `package-lock.json`, including a component
whose dependency graph is empty. The lock is generated without lifecycle scripts or dependency
installation. This gives `npm audit` an exact graph to inspect instead of treating `ENOLOCK` as
security evidence or weakening the adapter with an implicit pass.

## Consequences

- Fixture helpers and child reports cannot be executed as root tests.
- Test and coverage commands exercise the same deterministic suite.
- Empty npm dependency graphs remain auditable and return an explicit zero-vulnerability result.
- Authored source still changes certification identity; only conventional generated coverage state
  is ignored.
