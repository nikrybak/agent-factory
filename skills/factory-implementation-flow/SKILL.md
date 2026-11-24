---
name: factory-implementation-flow
description: Implementation workflow through correct engineering roles. Только для инфры Software Factory (в корне: AGENTS.md с Factory City + cli/bin/infra.js).
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


# factory-implementation-flow

Implementation workflow through correct engineering roles.

## Procedure


1. Confirm factory-feature-intake and app-arch gate exist.
2. Use backend/frontend/API/database/integration or other detected-stack engineer by affected area.
3. Make minimal changes.
4. Add/update tests in same cycle.
5. Update memory and docs.
6. Hand off to test and review gates.


## Required final report

- Status: PASS / FAIL / PASS WITH RISKS
- Roles used
- Skills/plugins/MCP used
- Files changed
- Tests/checks run
- Docs updated
- Open risks

<!-- city-fabric-child-context -->
## City Fabric child scope

When the work concerns a registered child application, resolve it before applying
this gate: run `infra project resolve <key>` from the Factory City root, or run
`infra project resolve` from inside that child. Treat the returned `knowledge`
directory as the tracked project context. Application checkout and `_output/`
remain local boundaries; this gate never authorizes a deploy, publish, release, or
mutation outside its declared task.
