---
name: factory-adr-update
description: Create/update ADR for architecture changes. Только для инфры Software Factory (в корне: AGENTS.md с Factory City + cli/bin/infra.js).
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


# factory-adr-update

Create/update ADR for architecture changes.

## Procedure


1. Copy `docs/adr/0000-template.md` to next numbered ADR.
2. Record context, decision, alternatives, consequences, rollback.
3. Link affected modules and tests.


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
