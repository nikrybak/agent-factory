---
name: factory-continuous-learning-flow
description: Пер-сессионная обёртка над глобальным скиллом continuous-learning-v2 (инстинкты). Замыкает петлю непрерывного обучения базы. Запускается после /factory-docs-sync и перед /factory-release-checkpoint. Берёт факты текущей сессии (изменённые файлы, коммиты, результаты гейтов, ошибки и ловушки), явно вызывает continuous-learning-v2, чтобы отличить durable-паттерн (а не разовый факт), и промоутит его в .claude/agent-memory/<role>/MEMORY.md соответствующей роли (при общем значении - ещё и в docs/operations/MEMORY.md). Отдельного сессионного журнала нет: источник - сама сессия и память ролей. Периодическую дедупликацию и промоушен устойчивых паттернов выше (в skills/rules) делает скилл factory-consolidate-memory - этот скилл работает по одной сессии. Только для инфры Software Factory (в корне: AGENTS.md с Factory City + cli/bin/infra.js).
---

> Full body moved to references/_full.md (split to fit the 8KB SKILL.md limit).

<!-- city-fabric-child-context -->
## City Fabric child scope

When the work concerns a registered child application, resolve it before applying
this gate: run `infra project resolve <key>` from the Factory City root, or run
`infra project resolve` from inside that child. Treat the returned `knowledge`
directory as the tracked project context. Application checkout and `_output/`
remain local boundaries; this gate never authorizes a deploy, publish, release, or
mutation outside its declared task.
