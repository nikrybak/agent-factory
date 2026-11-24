# Software Factory Blueprint

## Diagnosis

The repository now has an executable first-generation kernel in addition to its
governance foundation: schema-validated intent, stack detection, policy composition,
a checkpointable workflow DAG, safe command execution, and fresh tree-bound evidence.
The next maturity boundary is end-to-end artifact traceability, typed workers, complete
stack execution adapters, supply-chain trust, and evaluation-backed learning.

## City model

| City function | Factory capability | Current gap |
|---|---|---|
| City hall / constitution | Schema-validated project/factory manifest | Delivered in kernel v1; charter generation remains |
| Urban planning / zoning | Policy engine and project profiles | Delivered in kernel v1; profile catalog expands through adapters/evals |
| Dispatch center | Workflow DAG/state machine | Delivered in kernel v1 with checkpoint/resume and deterministic transitions |
| Land registry | Artifact/traceability graph | Requirements, ADRs, code, tests, evidence, and releases are not validated as one graph |
| Construction crews | Canonical role manifests and handoffs | Roles are harness-oriented and weakly typed |
| Utilities | Stack/source/tool adapter SDK | Broad detection is delivered; complete execution adapters remain |
| Building inspection | Truthful normalized evidence gate | Kernel evidence is fresh/tree-bound; signed remote evidence remains |
| Public safety | Execution trust, supply-chain, and data policy | MCP/tool scopes, egress, SBOM, provenance, and licenses need formal controls |
| Schools | Evaluation-backed learning loop | Learning promotion lacks benchmark deltas and rollback |
| Universal first district | Minimal external factory bootstrap + composable blueprints | A single technology starter must not become the core |

## P0 — executable foundation

1. **Factory manifest — delivered.** Schema-validated `factory/project.json` contains intent,
   sources, detected stacks with evidence/confidence, risk class, environments, data
   sensitivity, capabilities, deployment, profile, and authority boundaries.
2. **Policy profiles — delivered.** Declarative profiles for web, API, CLI, library, data/ML,
   mobile, embedded, and infrastructure; small/medium/high-risk predicates fail closed.
3. **Workflow kernel — delivered.** Typed DAG with step inputs/outputs, PASS/FAIL/N/A evidence,
   checkpoint/resume, retry, escalation, and deterministic applicability.
4. **Traceability graph.** Validate goal/acceptance criteria → spec → ADR/design →
   module/interface/schema → tests → evidence → release; reject orphans.
5. **Canonical roles.** Move roles to a neutral catalog with capabilities, authority,
   required context, deliverables, handoff, and evidence; generate harness adapters.
6. **Stack adapter SDK.** Standard interface for detect, plan, install, lint, typecheck,
   test, coverage, build, security, package, E2E, and deploy. Start with major runtime
   families; unknown stacks remain explicit gaps.

Stack discovery reads authored markers only. A Unity component is identified by
`ProjectSettings/ProjectVersion.txt` at its own root, whether that root is the inspected
project or a nested application inside a composite product; its generated `Library`,
`Logs`, `Temp`, `Obj`, `Build`, `Builds`, and `UserSettings` directories are excluded
relative to that component before signal grouping. Sibling backend and content-pipeline
roots remain visible. Authored Android plug-ins remain independently visible while
the child registry or manifest declares target platforms; the generic Unity marker does
not claim that every Unity project is mobile.

Supply-chain collection uses the same authored/generated boundary. It reads Unity's
`Packages/manifest.json` and `Packages/packages-lock.json` plus authored native plug-in
manifests, while excluding the editor cache and local build products from SBOM identity.
Gradle's checked-in `gradle.lockfile` is the authoritative complete JVM dependency set;
manifest parsing alone is not treated as transitive supply-chain evidence.
7. **Evidence engine — kernel slice delivered.** Execute argv without implicit shell, record tool versions,
   tree hash, time, coverage, artifacts, and freshness in signed/hashed JSON evidence.
8. **Trust and supply chain.** Tool/MCP trust tiers, allowed roots, egress profiles,
   secret sources, version/hash pinning, dependency/license policy, SBOM, and provenance.
9. **Factory evals.** Golden repositories and benchmark tasks per profile; measure
   success, false PASS, regression, cost, and time. Promote learning only through
   proposal → eval delta → review → versioned change → rollback.
10. **Neutral bootstrap.** Generate only factory metadata/docs/task/evidence structure
    into an external repository, then compose optional capability packs.

## P1 — operations

- CLI: `init`, `detect`, `plan`, `run`, `status`, `resume`, `verify`, `doctor`, `explain`, with dry-run and JSON output.
- OpenTelemetry-compatible run ledger, SLO trends, incidents, and flaky-test quarantine policy.
- Versioned capability catalog with compatibility, maturity, owner, and selection rationale.
- Universal source adapters for local/git/archive/remote/docs/API/design with provenance digests.

## P2 — scale

- Model routing by risk, quality, cost, token, and time budgets.
- Control-tower UI for dependency, workflow, evidence, and fleet health.
- Internal marketplace for evaluated skills, adapters, roles, and blueprints.
- Conflict-aware parallel worktrees and agents.
- Migration and disaster-recovery simulation/digital twins.

## Recommended sequence

1. Preserve the clean neutral baseline with conformance tests.
2. Write the kernel/adapter ADR and schemas.
3. Implement manifest + policy + workflow/evidence engine.
4. Add stack adapters and truthful gates.
5. Generate role/harness views from canonical role manifests.
6. Build eval fixtures before expanding the capability catalog.

Do not grow the role/skill count as a proxy for capability. New capabilities should
arrive with a schema contract, adapter, evidence, security policy, and evaluation.

## Completion status

Factory City v1 completes the blueprint's executable core: manifest, policy, DAG,
artifact graph, canonical roles, adapter SDK, evidence, trust/SBOM/provenance, evals,
ledger/control, and reversible delivery are implemented and aggregated by `infra certify`.
The completion contract requires 100% traceability, 100% eval score, and zero gaps.
