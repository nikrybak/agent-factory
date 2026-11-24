---
name: factory-mandatory-quality-gate
description: Final blocking evidence aggregator before commit, push, publish, deploy, or release; PASS requires every applicable test, security, architecture, documentation, and configuration check to provide current concrete evidence. Только для инфры Software Factory (в корне: AGENTS.md с Factory City + cli/bin/infra.js).
---

## Область применения (ПРОВЕРИТЬ ПЕРВЫМ ДЕЛОМ)

Этот скилл — часть инфраструктуры **Multi-AI Software Factory** (stack-agnostic база: `look-at-me`,
`vc_enterprise_it_infra`), а не универсальный справочник. В глобальном хранилище он лежит ради
доступности и применим ТОЛЬКО в проектах этой инфраструктуры.

Перед любым действием проверить в корне проекта оба маркера:

1. `AGENTS.md` существует и содержит `Factory City`;
2. существует `cli/bin/infra.js`.

**Оба есть** — выполнять как описано ниже.

**Хотя бы одного нет** — скилл неприменим. НЕ выполнять процедуру, НЕ требовать доказательств от
под-гейтов, НЕ блокировать commit / push / release. Одной строкой сообщить, что проект не на
инфраструктуре Software Factory, и продолжить обычным порядком.


---


# Mandatory Quality Gate

This skill fixes nothing. It aggregates current evidence and returns PASS or FAIL.

## Evidence contract

| Gate | Applies when | Required evidence |
|---|---|---|
| Tests | always | changed-module unit/integration results, coverage, lint/type/build as detected |
| Browser/E2E | user-facing browser flow | browser run and artifacts |
| API contract | API added or changed | contract/OpenAPI/Postman compatibility evidence |
| Security | always | secret, dependency, input/trust review; no unresolved Critical/High |
| Architecture | medium/large | updated architecture and accepted ADR when structural decisions changed |
| Documentation | always | module docs, specs, memory, checkpoints, and task state |
| Config drift | always | `node cli/bin/infra.js sync --check` reports `[infra] in sync` |
| Skill validation | always | `node cli/bin/infra.js validate` reports `[infra] skills valid` |
| Factory evidence | when `factory/project.json` exists | `infra verify --project <root> --json` PASS for the selected completed run |
| Factory City certification | when Factory City catalogs exist | `infra certify --project <root> --json` is `COMPLETE`, traceability/evals are 100%, and gaps are empty |

`N/A` is allowed only with a written applicability reason. Missing, stale, skipped,
or ambiguous evidence is FAIL. Impossible verification is FAIL plus a backlog/risk item.

## Procedure

1. Record every gate as PASS, FAIL, or justified N/A and link its evidence.
2. Run both infrastructure checks and capture their exact output.
3. Return PASS only when every applicable gate is PASS and no blocking risk remains.
4. On FAIL, identify each missing/failed artifact and the gate that must resume.
5. Never infer authority to commit, push, publish, deploy, or release from a PASS.

## Required report

- Final status
- Applicable gates and evidence
- N/A decisions and reasons
- Blocking failures and owners
- Files/docs updated
- Remaining risks

<!-- city-fabric-child-context -->
## City Fabric child scope

When the work concerns a registered child application, resolve it before applying
this gate: run `infra project resolve <key>` from the Factory City root, or run
`infra project resolve` from inside that child. Treat the returned `knowledge`
directory as the tracked project context. Application checkout and `_output/`
remain local boundaries; this gate never authorizes a deploy, publish, release, or
mutation outside its declared task.
