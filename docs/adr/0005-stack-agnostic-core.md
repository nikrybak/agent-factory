# ADR-0005: Stack-agnostic core with optional adapters

Date: 2026-07-12
Status: Accepted

## Context

The repository was described as universal but privileged one application platform,
one UI library, one REST integration, one bundled starter, and platform-specific roles.
Those dependencies leaked into the canon, generated configurations, onboarding,
quality routing, documentation, and tests.

## Decision

The core SHALL be stack-agnostic. Remove the bundled vendor platform, UI library,
MCP endpoint, specialist roles and skills, embedded starter, and starter-specific
update automation. Retain generic template provenance and synchronization contracts,
but ship with an empty registry and require templates to be added explicitly.

Stack-specific capabilities may return only as optional, independently installable
adapters that do not alter the default workflow.

## Alternatives considered

- Keep the existing integration but label it optional: rejected because default roles,
  gates, onboarding, and generated configuration still privileged it.
- Remove the entire template system: rejected because template provenance and safe
  synchronization are useful across stacks.
- Replace the removed starter immediately with another default: rejected because it
  would reproduce the same architectural coupling.

## Consequences

- The base becomes smaller, neutral, and easier to apply to arbitrary repositories.
- New projects need an explicit template or can start template-less.
- Historical platform-specific artifacts disappear from the current tree; git history
  remains the recovery source.
- Stack discovery and capability selection become the next major product investment.

## Tests required

- Full Node test suite and generator conformance tests.
- `infra sync --check`, `infra validate`, and `infra doctor`.
- Repository-wide forbidden-term and broken-reference scans.
- Security, documentation, and aggregate quality gates.

## Rollback plan

Restore removed files from git history, re-add the optional integration declarations,
and regenerate tool-specific targets from the canon.
