---
name: factory-kotlin-backend-gate
description: Apply when a registered Factory City child changes a Kotlin server, Ktor or Spring backend, API contract, persistence workflow, or production-facing asynchronous behavior.
---

# Factory Kotlin backend gate

Resolve the registered child before use. This gate applies to Kotlin server work
only; Android client work belongs to `factory-mobile-platform-gate`.

## Detect and route

1. Identify the build tool, JDK, framework, persistence library, API protocol,
   authentication model, and actual test commands from the child application.
2. For **Ktor**, use `kotlin-ktor-patterns`, `kotlin-patterns`,
   `kotlin-coroutines-flows`, `kotlin-exposed-patterns`, and `kotlin-testing`
   only where the code calls for them.
3. For **Kotlin + Spring**, choose the focused source-pinned pack: API/error
   design, Spring Security, transaction consistency, JPA mapping, configuration,
   testing, observability, or integration resilience. Do not invoke all packs
   merely because the project uses Spring.
4. For database changes, add the relevant migration and Prisma/data contract
   guidance where applicable; do not treat a skill as authority to migrate data.

## Required engineering decisions

- State the API/error contract and input validation boundary.
- Keep coroutine and blocking I/O contexts explicit; preserve cancellation and
  structured concurrency.
- Place transactions at business consistency boundaries, never across slow
  network calls. Model retries, idempotency, locking and outbox/post-commit
  publication before implementation when side effects exist.
- Keep configuration typed and fail-safe; no credentials or secrets in tracked
  examples, logs or generated artifacts.
- Preserve least-privilege authentication and authorization, with allowed and
  denied path tests for security-sensitive changes.
- Add observability without leaking personal data, tokens, or internal topology.

## Verification and handoff

Run the detected formatter, compiler, unit/integration tests, contract checks,
and relevant migration verification. Use `factory-api-postman-gate` for a changed
API, `factory-mandatory-test-gate` for aggregate test evidence, and
`factory-security-gate` for the security review. If an environment, database or
credential-dependent check cannot run, record the exact gap; it is not PASS.

This gate is advisory and evidence-producing. It never grants data mutation,
deployment, publishing, or release authority.

<!-- city-fabric-child-context -->
## City Fabric child scope

When the work concerns a registered child application, resolve it before applying
this gate: run `infra project resolve <key>` from the Factory City root, or run
`infra project resolve` from inside that child. Treat the returned `knowledge`
directory as the tracked project context. Application checkout and `_output/`
remain local boundaries; this gate never authorizes a deploy, publish, release, or
mutation outside its declared task.
