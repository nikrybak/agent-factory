# Quality Gates

- Architecture gate for medium/large changes.
- Changed-module tests, coverage, lint, type-check, and build as detected.
- Browser and accessibility evidence for user-facing flows.
- API compatibility evidence for changed contracts.
- Security, secrets, dependency, and trust review.
- Documentation, OpenSpec/ADR traceability, memory, and task-state synchronization.
- Canon drift and skill-reference validation.
- Aggregate quality decision before any commit, push, publish, deploy, or release.

Every applicable gate produces concrete evidence. Missing, stale, skipped, or
unsupported evidence is FAIL; N/A requires a written applicability reason.
