# ADR-0015: Component-owned adapter variants and operation-scoped evidence targets

**Date**: 2026-08-30
**Status**: accepted
**Deciders**: it-orchestrator, solution architect, application-architecture guardian,
integration engineer, security engineer, QA lead, documentation engineer

## Context

ADR-0010 binds semantic evidence to detected components and adapter operations, but its v1.0
catalog shape assumes one adapter per family and applies every composite operation to every
component. Composite products need several same-family adapters, multiple commands for one
operation, build-root ownership of nested module markers, and explicit operation-specific target
sets. Without those identities, a duplicate Java adapter is ambiguous, a nested module may become
a false component, and an unsupported operation may be silently omitted or treated as a pass.

## Decision

Adopt project, detection, adapter, and evidence-provider catalog version `1.1.0` as one coordinated
contract. Each declared component has an exact stable `id`, `family`, root-relative `root`, and
`adapterId`; both `id` and the normalized `(family, root)` identity are unique within the
manifest. Detection groups only by catalog-declared marker ownership: `component` and
`build-root` markers create component roots, `build-root` may own named nested module families,
and a `module` marker joins its nearest eligible owner. Independent families at the same root
remain distinct components. An orphan module marker or one with equally near eligible owners is
reported as a blocking detection gap and is excluded from the component projection; marker
presence never creates an implicit component.

The project, stack-signal, adapter, and evidence-provider JSON Schemas use explicit `1.0.0` and
`1.1.0` conditional branches. Fields from one version cannot leak into the other version's
document shape. `infra init` distributes these coordinated schemas, including the
`toolchain-trust.schema.json` needed by the physical-launch contract, without creating or
enrolling a local trust overlay.

Adapter `1.1.0` permits duplicate family variants. Selection uses the component's exact
`adapterId`; omission is valid only when exactly one adapter exists for that family. Multiple
candidates without `adapterId`, an unknown ID, or a family mismatch is a blocking ambiguity. No
generic, core, first-match, or catalog-order fallback is permitted.

Each adapter operation declares exactly one legacy `argv` or one ordered non-empty
`commands: [{id, argv}]` list. Command IDs are unique within the operation. All commands remain
shell-free and execute in authored order; one failure fails the target and aggregate receipt.
The existing physical toolchain authorization, opened-byte catalog boundary, credential
rejection, pre/post launch validation, and authority checks apply independently to every command.

An adapter `1.1.0` command may additionally declare `timeoutMs` in the closed interval
1,000–21,600,000 milliseconds. A single-argv operation owns the value beside `argv`; a
multi-command operation owns it on each command child, and an ambiguous operation-level timeout
is invalid. The resolved timeout participates in the command and binding hashes and overrides
only a shorter runtime fallback. Adapter `1.0.0` cannot acquire this field. Missing, non-integral,
out-of-range, moved, or post-plan timeout values fail closed or require re-plan/re-run.

Evidence-provider `1.1.0` declares each composite operation with exact component-ID selectors.
Every selected `(componentId, operation)` becomes an auditable binding target. A target may be
`N/A` only when the selected adapter explicitly lists that operation as unsupported and the
provider supplies a stable reason code and bounded justification. An adapter-supported operation
cannot be relabelled `N/A`, and an undeclared omission cannot satisfy the provider.

If an otherwise selected executable target cannot create its physical launch binding, planning
retains that identity as `kind: blocked` with a fixed, path-free reason code. The blocked target
participates in the target aggregate and produces a policy gap; the workflow policy therefore
prevents execution. A launch failure is never erased from the selector projection and is never
converted to `N/A` or PASS.

Evidence bindings use version `1.1.0`. Evidence receipts use schema version `2` and contain every
selected target as either ordered command children or an auditable `N/A` child. Target and command
aggregate hashes bind exact component, adapter, operation, order, cwd, argv, launch identity, and
N/A justification. The composite provider passes only when all selected targets are represented
and every executable child passes.

Version `1.0.0` project and catalog documents remain readable for migration and audit. A legacy
binding or receipt does not acquire v1.1 identity by rehashing: it is stale for current planning,
verification, provenance, certification, and delivery, and requires re-plan/re-run. Governed
catalogs never fall back to embedded defaults. Tracked manifests, catalogs, bindings, receipts,
and documentation contain only root-relative paths; absolute machine paths remain forbidden.

For the registered Worlio child, the exact projection is five components:
`unity-preview-client`, `java-backend`, `container-backend`,
`java-thin-client-android`, and `python-content-pipeline`. Docker coverage is an explicit
adapter-declared `N/A` target, and Unity security is an explicit adapter-declared `N/A` target.
All other selected test, coverage, and security targets are executable and all-or-fail.
Worlio binds its measured long Python test and coverage targets to 1,800,000 milliseconds. Its
Docker buildx, compose, and Scout operations bind the respective plugin executable directly;
authorizing only the parent `docker` CLI cannot authorize dynamically discovered plugin bytes.

This decision partially amends ADR-0010's component/adapter resolution and composite-receipt
shape. It does not supersede ADR-0010; semantic provider binding and workflow-stage authorization
remain in force.

## Alternatives considered

### Infer adapters from family or catalog order

- **Pros**: smaller manifests.
- **Cons**: duplicate-family repositories become order-dependent and non-auditable.
- **Why not**: discovery and catalog position cannot grant semantic execution authority.

### Treat every marker as an independent component

- **Pros**: simple detection.
- **Cons**: Gradle modules, package descriptors, and other nested markers create false duplicate
  gates while same-root product families may still be collapsed incorrectly.
- **Why not**: component ownership is a catalog contract, not a pathname heuristic.

### Omit unsupported operation targets

- **Pros**: shorter bindings and receipts.
- **Cons**: absence is indistinguishable from an accidental coverage or security gap.
- **Why not**: every selected target must have executable evidence or an auditable justified N/A.

### Keep one argv per operation

- **Pros**: simpler receipt shape.
- **Cons**: real build systems require several ordered validators and could hide partial success
  behind wrapper scripts.
- **Why not**: explicit command children preserve shell-free execution and per-command evidence.

## Consequences

### Positive

- Multi-component products retain exact component and adapter ownership.
- Duplicate-family adapters are explicit and deterministic.
- Same-root multi-family components and nested module ownership are independently testable.
- Every selected operation has command evidence or a justified, adapter-declared N/A child.
- A selected launch failure remains visible as a blocked target while policy prevents execution.
- Ordered multi-command operations expose partial failure instead of hiding it in a wrapper.
- Long-running commands can declare a bounded, immutable timeout without weakening the global
  fail-closed default.

### Negative

- Composite manifests and provider catalogs must maintain stable component IDs.
- Adapter variants and operation target sets require coordinated catalog changes.
- Existing v1.0 bindings and receipts must be regenerated before they can satisfy current gates.
- Host operators must make every directly bound tool discoverable through a trusted local runtime
  context; tracked catalogs never contain absolute machine paths.

### Risks

- A broad build-root ownership declaration could absorb an unrelated module; nearest-owner and
  same-root multi-family fixtures must reject over-collapse.
- Component renames could invalidate provider selectors; planning must fail on missing IDs rather
  than silently retarget.
- N/A reasons could become ceremonial; validation requires exact adapter unsupported declarations
  and tests cover support/N/A conflicts.
- Multi-command targets increase runtime work; execution remains bounded, ordered, shell-free,
  physically authorized, and all-or-fail.
- An excessive authored timeout could delay feedback; the schema caps each command at six hours
  and receipts retain exact duration and timeout-bound identity.

## Verification

Focused manifest, detection, adapter, provider, runner, evidence, and engine tests cover exact
component/adapter matching, duplicate-family ambiguity, marker ownership, same-root multi-family
preservation, orphan/ambiguous module exclusion, exact versioned-schema branching, ordered
multi-command execution and failure, selected-target launch blocking, selector drift, justified N/A conflict,
v1.0 readability with stale binding rejection, no catalog fallback, shell rejection, physical
toolchain parity, init-time toolchain schema distribution, and path-free tracked artifacts. The Worlio fixture asserts exactly five
components, Docker coverage N/A, and Unity security N/A.
Timeout regressions cover single-argv and per-child propagation, command-hash sealing, runtime
precedence, v1.0 rejection, ambiguous multi-command placement, and both numeric bounds.
