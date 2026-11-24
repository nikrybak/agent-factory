---
name: factory-ecc-starter
description: Read-only session bootstrap that loads the project contract, skills, roles, memory, active tasks, integration declarations, and detected target stack before workflow execution. Только для инфры Software Factory (в корне: AGENTS.md с Factory City + cli/bin/infra.js).
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


# Session Starter

Run first in every new or compacted session.

1. Read `AGENTS.md` and record absolute rules, workflow, boundaries, and generated-file policy.
2. Inventory canonical skills, roles, plugins, and available tools without installing anything.
3. Read `docs/operations/MEMORY.md`, recent checkpoints, current sprint, backlog, and done log.
4. Read `agents.json` and compare declared integrations with tools actually available in the session.
5. Use `infra detect --project <root> --json` when available to detect stack,
   capabilities, package managers, runtimes, CI, deployment, and gaps from evidence.
6. Return `READY` or `READY WITH GAPS`, listing unavailable capabilities and the current focus.

This skill is read-only: do not edit, connect services, run destructive commands, or create persistent configuration.

<!-- city-fabric-child-context -->
## City Fabric child scope

When the work concerns a registered child application, resolve it before applying
this gate: run `infra project resolve <key>` from the Factory City root, or run
`infra project resolve` from inside that child. Treat the returned `knowledge`
directory as the tracked project context. Application checkout and `_output/`
remain local boundaries; this gate never authorizes a deploy, publish, release, or
mutation outside its declared task.
