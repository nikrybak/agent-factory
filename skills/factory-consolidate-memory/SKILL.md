---
name: factory-consolidate-memory
description: Периодическая консолидация памяти базы. Дедуплицирует записи в .claude/agent-memory/*/MEMORY.md и docs/operations/MEMORY.md, продвигает устойчивые (повторяющиеся ≥2 раз у разных ролей или в разных датированных записях) durable-паттерны в MEMORY.md соответствующей роли, а кандидатов-инварианты - дальше в skills/ или rules/. Запускать периодически: после N сессий (ориентир - каждые 5-10), при разрастании памяти ролей или docs/operations/MEMORY.md, либо перед релизом, как догоняющий проход за пер-сессионным скиллом factory-continuous-learning-flow. Отличать durable-паттерн от разового факта; разовое не промоутить. Не дублировать существующие пункты - обновлять их. Опирается на глобальный continuous-learning-v2 (инстинкты) и не делает деструктивных git-операций. Только для инфры Software Factory (в корне: AGENTS.md с Factory City + cli/bin/infra.js).
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
