# ADR-0010: Semantic evidence providers and workflow-stage authorization

**Date**: 2026-08-30
**Status**: accepted
**Deciders**: it-orchestrator, solution-architect, app-architecture guardian, security engineer, QA lead

## Context

The executable workflow currently accepts caller-supplied argv for any ready step. An exit-zero
no-op can therefore produce structurally valid evidence for a semantic gate. City candidate and
full certification also consume the latest run without proving that the selected workflow has
reached the stage which authorizes eval, observation, certification, or outward delivery.

Shell-free execution, source identity, contextual identity, and evidence digests prevent command
injection and later byte tampering, but they do not prove that the command was the approved
validator for the claimed step. City `COMPLETE` alone also cannot mean that the downstream
quality and release-checkpoint workflow steps have passed.

## Decision

Introduce a governed evidence-provider catalog and schema. Every applicable workflow step is
assigned one semantic provider. Planning resolves that provider from canonical workflow,
provider, adapter, and detection catalogs into an immutable `evidenceBinding`. The binding
contains its schema version, provider and adapter identities, operation, deterministic command
list, component-relative cwd values, required authority, catalog digests, command hashes, and a
binding digest. The plan hash includes the complete binding.

Runtime argv can select only the single command already present in a single-command binding; it
can never create or modify a binding. Executable, argument order, cwd, adapter, operation, and
hash must match before spawn. Built-in providers are pure validators. Composite providers run
every deterministically ordered command bound for every applicable detected component. Missing
providers or required adapter operations are named planning gaps.

Evidence stores provider identity, binding digest, and canonical command hash. Evidence
assessment compares those values with the selected plan as well as its existing plan, source,
context, TTL, and content digests. Plans without bindings and evidence without binding metadata
remain integrity-auditable but are `LEGACY_UNBOUND_PLAN` or `UNTRUSTED_LEGACY_COMMAND`; they
cannot satisfy current provenance, certification, or delivery and require re-plan/re-run.

The canonical provider map is:

| Workflow step | Semantic provider |
| --- | --- |
| intake | built-in manifest intent and requirement-root validation |
| plan | built-in plan, policy, DAG, and provider-binding integrity |
| architecture | built-in requirement-to-spec/ADR/architecture lineage |
| implementation | built-in requirement/spec-to-module lineage |
| test-contract | built-in module-to-test and declared test-contract lineage |
| tests | composite adapter test and coverage operations for every detected component |
| browser-e2e | composite adapter E2E operations or policy-owned N/A |
| api-contract | built-in API requirement/spec/module/test parity or policy-owned N/A |
| traceability | Factory trace provider |
| workforce | Factory workforce provider |
| adapters | Factory adapter provider |
| trust | Factory trust provider |
| supply-chain | Factory SBOM and current bound-provenance provider |
| evals | Factory candidate-eval provider |
| observability | Factory candidate-observation record provider |
| security | composite adapter security operations plus Factory trust/security validation |
| docs | built-in OpenSpec, architecture, operations-memory, task, and graph parity |
| city-certification | Factory full City certification provider |
| quality | built-in ancestor, City, and configured quality-check provider |
| release-checkpoint | Factory prepare-only identity and rollback-plan provider |

Introduce one pure workflow-stage assessment port. Every stage-sensitive operation must use the
same explicit selected run snapshot for plan freshness, policy, workflow state, evidence
selection, plan hash, and certification identity. A stage-sensitive workflow provider never
falls back to `.factory/latest.json`.

| Purpose | Required selected-run state |
| --- | --- |
| eval | `evals` is `READY` |
| observe record | `observability` is `READY` |
| full City certification / prepare | `city-certification` is `READY`, or the run is `COMPLETE` |
| release / deploy / publish | the run is `COMPLETE` independently of City and manifest authority |

Read-only observation remains available outside the observation stage. Candidate eval and
observation return `PASS` with `level: candidate`, never `COMPLETE`. Observation may append a
candidate PASS/FAIL ledger event but cannot grant full certification. Full City certification
at its workflow boundary may return `COMPLETE` while explicitly reporting
`workflowComplete: false`; delivery treats that as prepare-only. Release, deploy, and publish
remain blocked until the full run, including `release-checkpoint`, is complete.

The `release-checkpoint` provider always requests prepare-only planning. This prevents the
outward-delivery COMPLETE requirement from creating a dependency cycle with the step whose
purpose is to finish the workflow.

Existing command names and the `infra run -- <argv>` shape remain compatible for bound
single-command providers. Explicit run selection for stage-sensitive public commands is an
additive option; unscoped results are advisory and cannot become release-grade evidence.

## Alternatives considered

### Allowlist executable names

Rejected because an allowlisted runtime can still execute a no-op or unrelated program.

### Bind the first runtime argv

Rejected because the same caller could bind and execute an arbitrary no-op.

### Treat City COMPLETE as workflow completion

Rejected because City certification precedes quality and release checkpoint in the governed
DAG.

### Require workflow completion before City certification

Rejected because it creates a cycle: quality depends on City certification and release
checkpoint depends on quality.

## Consequences

### Positive

- Cross-step replay, no-op substitution, cwd substitution, and imported command evidence fail
  closed
- Composite repositories prove every required detected component operation
- Candidate evaluation and observation remain possible without weakening full certification
- Prepare-only work remains possible at the City boundary while outward delivery requires the
  completed workflow
- Existing public command names remain stable

### Negative

- Existing plans and command-only evidence require a fresh plan and workflow run
- Provider predicates for architecture, API, docs, and quality become governed security-critical
  code
- Composite execution and fixtures must consume plan-provided bindings instead of arbitrary argv

### Risks and controls

- Shallow filename checks could become ceremonial gates; providers validate artifact graph
  relationships and exact requirement coverage rather than names alone
- Catalog substitution could change approved commands; catalog digests are bound into the plan,
  certification identity, and evidence
- Latest-run substitution could mix snapshots; stage-sensitive evidence requires an explicit
  run id and one status snapshot
- The aggregate Python quality gate resolves the latest run once through the canonical
  `statusProject` engine using a shell-free bridge that emits only the bounded identifier, then
  passes that exact id to `infra certify --run`; it never serializes the full status receipt or
  relies on a second implicit latest-run lookup after tests.
- A source-identity replay retains old receipts as audit history. Stage readiness therefore uses
  the canonical ready queue (plus explicit failed-step retry), and stage evidence is scoped strictly
  to plan steps before the step being executed. Unknown-step evidence, stale plans, identity drift,
  invalid bindings and rejected prior-step evidence remain blocking.
- City COMPLETE could be misread as release readiness; responses expose workflow completion and
  delivery rechecks it independently

## Verification

Focused tests reject exit-zero no-ops, cross-step replay, argv/cwd/adapter differences, legacy
bindings, imported wrong-command evidence, partial-stage certification, latest-run substitution,
and outward delivery before workflow completion. Composite fixtures prove every bound operation,
and a complete workflow proves prepare-only release checkpoint without a cycle.
