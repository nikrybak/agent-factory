# Dispatch Routing

## Canonical path

`starter → intake → plan → architecture → implementation → test contract → tests → optional browser/API gates → security → docs → aggregate quality → release checkpoint`

## Predicates

| Predicate | Additional route | Evidence |
|---|---|---|
| medium/large or cross-boundary | architecture guardian + ADR/OpenSpec | architecture PASS |
| user-facing/browser | UX, frontend, E2E roles | accessibility and browser artifacts |
| API contract changed | API engineer + API gate | schema/compatibility results |
| data/schema changed | database + security roles | migration/rollback evidence and explicit authority |
| production incident | observability + security | timeline, telemetry, containment evidence |
| outward-facing action | release role + user authority | aggregate quality PASS and rollback plan |

## Routing rules

1. Intake derives predicates from evidence and records them in the current sprint.
2. Stack-specific roles or skills are selected only after stack detection.
3. Failed gates return to the owner of the failed artifact, then resume from that checkpoint.
4. Unsupported capabilities remain explicit gaps and cannot be converted to PASS by prose.
5. This human view must agree with `AGENTS.md`; a future workflow schema should generate both.
