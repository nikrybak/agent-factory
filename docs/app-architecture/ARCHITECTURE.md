# Software Factory Architecture

## System purpose

This repository is a stack-agnostic governance and generation layer for building,
reviewing, testing, documenting, and releasing software with multiple AI tools. It
contains infrastructure and reusable procedures, not an embedded application stack.

## Layers

1. **Canon** — `AGENTS.md`, `agents.json`, and repository-local `skills/` define policy, tools, and repeatable workflows.
2. **Compiler** — `cli/` validates the canon and generates tool-specific targets.
3. **Operating model** — role definitions, playbooks, hooks, quality gates, and project memory coordinate work.
4. **Knowledge and specifications** — `docs/`, `openspec/`, and `sources/` make decisions and evidence traceable.
5. **Optional adapters** — templates, MCP servers, and stack packs are opt-in extensions; none is privileged by the core.
6. **Factory kernel** — project manifest, evidence-based detector, policy profiles,
   workflow DAG, checkpoint store, safe command runner, and verification engine.
7. **City Fabric registry** — `app_entry_root/_registry/registry.json` declares
   independently versioned child applications by key; the resolver derives their
   knowledge, app, output and optional AI-runtime metadata without guessing paths.
8. **Filesystem assurance** — one opened-object boundary consumes governed catalog bytes and
   exposes a versioned host capability identity; one catalog loader prevents domain modules from
   recreating pathname checks.
9. **Physical toolchain trust** — exact Node process anchors plus an ignored operator-confirmed
   digest overlay authorize the opened bytes behind non-anchor evidence commands.

## Boundaries

- The core does not bundle a product framework, UI kit, CRM, runtime, database, or cloud vendor.
- Stack-specific knowledge belongs in optional skills, plugins, templates, or a target project's own sources.
- A child application is addressed only by a registry key. Its tracked `_project/`
  knowledge is separate from its ignored `<key>-<version>/` application repositories and
  ignored `_output/<key>-<version>/` output (ADR-0008, ADR-0018).
- AI-runtime metadata is declarative only; it cannot contain credentials or grant
  execution, network, publishing, deployment, or platform-account authority.
- Secrets remain in ignored local overlays and never enter the canon or generated artifacts.
- Generated targets are outputs and are never edited manually.

## Cross-cutting invariants

- `REQ-UNI-001`: one canon produces consistent instructions for every supported AI tool.
- `REQ-UNI-002`: optional integrations cannot become mandatory dependencies of the core workflow.
- `REQ-UNI-003`: every changed module has proportionate automated verification and traceable documentation.
- `REQ-UNI-004`: destructive and outward-facing actions require explicit authority and quality-gate evidence.
- `REQ-FK-001..006`: factory state is validated, evidence-based, dependency-governed,
  safely executed, freshness-bound, and explainable.
- `REQ-CITY-006` / `REQ-CF-007`: source-only `treeHash` remains stable while one
  canonical contextual identity binds the resolver-owned registry/layout slice across
  evidence, provenance, ledger, certification, delivery planning, and quality reports.
- `REQ-FK-004` / `REQ-CITY-007`: every semantic gate is bound at plan time to a governed
  evidence provider, and every stage-sensitive operation consumes one explicit run snapshot.
- `REQ-CITY-011`: adapter `${projectRoot}` values are derived from the trusted repository and
  relative component root, canonicalized before binding, and included in direct shell-free
  command identity; authored catalogs never embed an operator machine path.
- City completion and workflow completion are independent facts; only prepare is permitted at
  the City boundary, while outward delivery also requires the complete workflow.
- Ledger observation is a project-scoped transaction from one verified head through candidate
  calculation and atomic durable replacement; concurrent writers cannot overwrite one another.
- One versioned leaf redaction policy removes sensitive material before any evidence hash,
  persistence, ledger event, diagnostic, JSON envelope, or human output.
- The redaction-policy version is bound into every semantic evidence binding and plan hash;
  plan, runtime, and evidence versions must match the current policy exactly.
- The filesystem-boundary version and capability digest are bound into the same semantic
  evidence path; governed catalog decisions use only exact opened regular-file bytes.
- `REQ-FK-010`: only exact `node`/`npm`/`npx` process anchors or a non-anchor logical
  executable with an exact current operator-enrolled digest may reach governed execution. PATH
  discovery, TOFU and child runtime metadata never grant authority.
- Workflow run-lock expiry is informational and never transfers ownership automatically.

## Architectural principles

- Detect the target stack before selecting stack-specific skills or tools.
- Define behavior and acceptance criteria before implementation.
- Keep policy declarative, generation deterministic, and integrations replaceable.
- Prefer evidence-producing gates over narrative claims.
- Capture structural decisions in ADRs and stable behavior in OpenSpec requirements.

## Factory kernel boundaries

- Authored project intent lives in `factory/project.json`; generated observations never rewrite it.
- Declarative schemas/catalogs live in `factory/`; executable CommonJS modules live in `cli/lib/factory/`.
- Local mutable state/evidence lives under target `.factory/` and is never product source.
- The CLI is the shell layer; validation, policy, workflow, evidence, and execution remain independently testable modules.
- Project and legacy compiler validation commands fail closed with non-zero exit codes while retaining their documented output contract.

## Factory City districts

7. **Artifact registry** — requirement-to-release graph and orphan validation.
8. **Typed workforce** — canonical role manifests, routing, handoffs, and separation of duties.
9. **Adapter utilities** — universal stack-operation contracts and authority-aware argv plans.
10. **Public safety** — trust tiers, egress policy, SBOM, structurally current advisory
    provenance, and separately governed release-grade Ed25519 provenance.
11. **School and observatory** — golden evaluations, append-only ledger, and health summaries.
12. **Delivery and certification** — reversible release plans and aggregate current-tree verdict.
13. **Semantic evidence providers** — governed built-in and composite adapter validators resolved
    into immutable plan bindings which runtime argv cannot create or change.
14. **Workflow-stage authorization** — candidate eval, observation, City, prepare, and outward
    delivery permissions derived from one explicit selected-run snapshot.
15. **Transactional evidence storage** — pure ledger semantics plus locked, CAS-checked,
    same-directory atomic persistence.
16. **Secret-free evidence boundary** — credential-free plans and deterministic pre-seal
    sanitization for runtime output and structured reports.
17. **Opened governed inputs** — descriptor-read catalog bytes, static link rejection and exact
    binding/receipt/runtime filesystem-capability parity.
18. **Owner-safe run locks** — cooperative exclusive ownership without TTL stealing and with
    fail-closed release confirmation.
19. **Operator-enrolled toolchain** — opened executable and Node CLI identity, path-free fixed
    failures, pre/post runtime validation, and exact plan/freshness/receipt authorization parity.
20. **Bounded runtime-path environment** — a closed non-secret allowlist includes Windows
    application-data paths and Android SDK roots required by Unity UPM and AGP; arbitrary variables
    remain excluded and every command still executes as exact argv with `shell: false`.
21. **Manifest-owned documentation parity** — the base verifies its own documentation root, while a
    child with one required `kind: docs` source verifies that root (normally `_project`); multiple or
    escaping documentation roots fail closed.
22. **Deterministic self-hosted Node boundary** — root and nested CLI packages invoke one explicit
    discovery script for tests and coverage, so fixtures and child build reports cannot become tests;
    standard `.coverage` runtime state is excluded from certification identity like other generated
    coverage/build output.
    Skill-registry content hashing applies the same rule to conventional Python coverage/cache
    entries while continuing to hash every authored skill file.

`REQ-CITY-001..006` require closed lineage, typed/segregated workers,
authority-aware adapters, trusted provenance, evaluated operations, and aggregate certification.

Release provenance follows ADR-0012: City and prepare-only delivery stay acyclic with explicit
advisory structural proof, while only a completed selected run can be assessed against the
current governed public-key allowlist for outward release, deploy, or publish planning. Stage
exceptions cross a bounded fixed-code classifier before evidence construction; raw exception
state is never part of the stage receipt contract.

Governed catalog reads follow ADR-0013. The boundary rejects static symlink/junction/reparse
ancestors and leaves, non-regular or hard-linked leaves, oversized input, and any
captured/opened/current identity mismatch. Evidence bindings and receipts carry the exact current
filesystem-boundary version and capability digest, so weaker runs require re-plan and re-run.
This is opened-byte/static-alias assurance, not descriptor-relative mutation or spawn; the latter
remains an explicit P2 capability gap.

Toolchain authorization follows ADR-0014. The exact strings `node`, `npm`, and `npx` are the only
process anchors; `npm`/`npx` use the current Node executable and fixed opened CLI bytes rather than
platform wrapper scripts. Every other logical executable requires its exact opened-byte digest in
the current `<project>/.factory/toolchain-trust.json`. The ignored overlay is strict versioned
operator-local state, participates in plan identity/freshness and sealed command receipts, and is
revalidated before and after process execution. PATH may locate a candidate but cannot authorize
it; TOFU and public enrollment commands do not exist.

Windows direct tools are limited to `.exe`/`.com`. POSIX tools require execute permission and a
platform-matched supported native format; shebang/environment wrappers, control interpreters and
unsupported formats fail closed. A binary update requires explicit re-enrollment, re-plan and
re-run. This local execution trust is not ADR-0012 release trust and does not prove that every
registered child adapter or host toolchain is enrolled. Pathname-based spawn still leaves the
descriptor-relative/same-principal ABA risk under `FC-FILESYSTEM-FENCE-P2`.

Component-owned adapter selection follows ADR-0015. Project, detection, adapter, and provider
contracts at `1.1.0` preserve an exact component ID, root-relative root, family, and adapter ID
from declaration through binding and receipt. A v1.1 manifest requires all four fields and rejects
duplicate component IDs or duplicate normalized `(family, root)` identities. Catalog marker roles distinguish component and
build roots from nested modules; only declared ownership may absorb a module marker, while
independent families at one root remain separate. Orphan module markers and equally near owner
matches become detection gaps and do not materialize components. Duplicate-family adapters are valid only with
an exact component `adapterId`, unless the family has exactly one catalog candidate. There is no
catalog-order, generic-core, or embedded-default fallback.

Composite providers select exact component IDs per operation. Each selected target binds exactly
one legacy argv or one ordered command list and resolves to executable children or an explicit
adapter-declared unsupported N/A child. Binding `1.1.0` and receipt v2 aggregate every target and
command; omission, reordering, partial success, or relabeling supported work as N/A fails closed.
When physical launch binding fails for a selected executable target, the binding retains its exact
identity as `kind: blocked`; the fixed path-free gap blocks policy readiness and `run` refuses to
execute the workflow. It is neither an unsupported N/A nor an omitted selector.
All commands retain the opened-catalog, credential-free, shell-free, physical-toolchain, and
pre/post launch contracts from ADR-0013 and ADR-0014. Version 1.0 documents remain readable, but
their old bindings are stale and require re-plan/re-run.

The four coordinated JSON Schemas select exact, closed `1.0.0` or `1.1.0` shapes through explicit
conditional branches. `infra init` copies the project, stack-signal, adapter, evidence-provider,
and physical `toolchain-trust` schemas into a new project; it does not create trust entries or
grant launch authority. Unity discovery is isolated in `factory/unity.js`: a real
`ProjectSettings/ProjectVersion.txt` establishes the project root, while only generated paths
inside that root are pruned.

Unity Test Framework owns batch-process termination for adapter operations containing `-runTests`.
Those operations use `-batchmode` and `-nographics` but deliberately omit the generic `-quit` flag,
which can end Editor initialization before discovery and produce no test/coverage artifact. The
Factory runner still supplies the bounded timeout and verifies the resulting command receipt.

Workflow run locks are owner-token locks without automatic expiry takeover. `expiresAt` is
informational. Existing, malformed, unreadable or expired locks remain held; only the exact owner
may release the exact observed object, and unconfirmed release makes the step invocation fail.

`REQ-CF-001..007` require a unique validated City Fabric key, root-bounded derived
child paths, an auditable/provenanced local skill canon, child-aware gates,
platform-specific mobile evidence, explicit Kotlin backend decisions, and child-scoped
certification identity.

Canonical district contracts live under `factory/schema/` and `factory/catalog/`; pure
logic lives under `cli/lib/factory/`. Mutable observations remain under ignored `.factory/`.
The local JSON/CLI control tower has no privileged browser/cloud stack. External writes
remain denied until manifest authority is true. `city.js` cannot translate a district gap into PASS.

## City Fabric child-addressing flow

`cli/lib/project.js` is the sole resolver. It searches upward for the Factory City
root, distinguishes `base` from `child` scope, reads the registry, validates the
key and all relative paths, then returns the child knowledge root
`app_entry_root/<key>/_project/`, optional application root, and version-aware output
root. Gate procedures use this result before selecting documents or task files.

The resolver does not discover application folders by pattern, follow external paths,
or execute a child runtime. A missing key, malformed registry or escaping path is a
blocking diagnostic rather than a fallback guess. See
`PROJECT_REGISTRY_AND_SKILL_CANON.md` and ADR-0008.
