---
name: factory-city
description: Operate and certify the complete stack-agnostic software factory. Use for project onboarding, implementation planning, workforce routing, stack adapters, traceability, trust/SBOM/provenance, evaluations, control-plane health, delivery preparation, or any request to finish a project with current machine-readable evidence.
---

# Factory City

Use `factory/project.json` as authored intent and authority. Never infer outward authority
from a successful check.

## Procedure

1. Run `infra detect --project <root> --write --json` and reject unknown required capabilities.
2. Run `infra plan --project <root> --run-id <id> --json`; follow only ready DAG steps.
3. Run `infra trace`, `workforce`, `adapters`, and `trust`; resolve every gap rather than narrating it away.
4. Produce `sbom` and `attest`; use Ed25519 signing when approved key material is provided.
5. Run `eval`, `observe`, `control`, and `release-plan`; require a rollback phase.
6. Run `infra certify --project <root> --json`. Treat anything except `COMPLETE` with zero gaps as FAIL.
7. Run the self-hosted workflow and mandatory quality gate before proposing commit, push, publish, deploy, or release.

## Invariants

- Accept commands only as argv; never translate catalog operations into shell strings.
- Keep paths inside approved roots and generated state under ignored `.factory/`.
- Preserve separation of duties between implementation, review, security, quality, and release approval.
- Treat missing adapters, artifacts, evidence, trust declarations, eval facts, or authority as blockers.
- Bind evidence, SBOM, provenance, ledger entries, and certification to current source identity.
- A delivery plan must contain verify, action, and rollback phases; execution still needs explicit authority.

## Completion response

Report `COMPLETE` only with the certification tree hash, test/coverage evidence, traceability
coverage, eval score, security verdict, and explicit confirmation that gaps are empty.

<!-- city-fabric-child-context -->
## City Fabric child scope

When the work concerns a registered child application, resolve it before applying
this gate: run `infra project resolve <key>` from the Factory City root, or run
`infra project resolve` from inside that child. Treat the returned `knowledge`
directory as the tracked project context. Application checkout and `_output/`
remain local boundaries; this gate never authorizes a deploy, publish, release, or
mutation outside its declared task.
