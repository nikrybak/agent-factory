---
name: factory-mandatory-test-gate
description: Run unit/integration/coverage checks for all changed modules. Только для инфры Software Factory (в корне: AGENTS.md с Factory City + cli/bin/infra.js).
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


# factory-mandatory-test-gate

Run unit/integration/coverage checks for all changed modules.

## Procedure


1. Run `python scripts/quality_gate.py` (the default local scope includes Factory City
   certification; hosted CI uses `--scope ci`, which never authorizes commit or release — ADR-0019).
2. If JS/TS exists: run lint, typecheck, tests, coverage if scripts exist.
3. If Python exists: run pytest/ruff/mypy when configured.
4. If PHP exists: run composer test/phpunit when configured.
5. If UI exists: require factory-browser-e2e-gate.
6. Do not PASS with missing tests for changed modules.


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
