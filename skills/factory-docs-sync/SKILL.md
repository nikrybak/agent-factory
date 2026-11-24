---
name: factory-docs-sync
description: Авто-синхронизация документации и памяти базы после задачи. Из реальных фактов (память ролей + результаты текущей сессии: изменённые файлы, коммиты, вердикты гейтов) переписывает docs/operations/MEMORY.md (Текущее состояние / Активные риски / Открытые вопросы / Последние изменения), дописывает строку в docs/operations/CHECKPOINTS.md (Дата|Изменение|Тесты|Docs/ADR|Риск|Commit) и обновляет tasks/CURRENT_SPRINT.md и tasks/DONE.md. Также обновляет app architecture docs и ADR при изменении архитектуры. Шаг 11 Workflow и инвариант AGENTS.md п.8. Только для инфры Software Factory (в корне: AGENTS.md с Factory City + cli/bin/infra.js).
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


> Полное тело вынесено в references/_full.md (split под лимит Codex 8KB).

<!-- city-fabric-child-context -->
## City Fabric child scope

When the work concerns a registered child application, resolve it before applying
this gate: run `infra project resolve <key>` from the Factory City root, or run
`infra project resolve` from inside that child. Treat the returned `knowledge`
directory as the tracked project context. Application checkout and `_output/`
remain local boundaries; this gate never authorizes a deploy, publish, release, or
mutation outside its declared task.
