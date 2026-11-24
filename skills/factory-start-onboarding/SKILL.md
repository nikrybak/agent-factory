---
name: factory-start-onboarding
description: Universal project onboarding that discovers intent, repository evidence, stack, sources, risks, template provenance, and required capability profile before work begins. Только для инфры Software Factory (в корне: AGENTS.md с Factory City + cli/bin/infra.js).
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


# Start Onboarding

1. Run `factory-ecc-starter` and read the target project's own agent contract and documentation.
2. Establish intent, users, success measures, constraints, risk class, environments, and authority boundaries.
3. Detect languages, frameworks, package managers, runtimes, data stores, APIs, infrastructure, CI, deployment, and observability from repository evidence.
4. Register sources using `sources/SOURCES.md`; distinguish product truth, baseline/reference, external standards, and historical context.
5. Run `factory-template-detect`. Offer only explicitly registered templates; template-less operation is first-class.
6. Select a playbook and capability profile from evidence, not from a default stack.
7. Produce or update the project charter, acceptance criteria, architecture gaps, test strategy, security risks, task state, and next gated action.
8. When the target opts into executable governance, initialize/review
   `factory/project.json`, persist detection, and generate the first `infra plan`.

## Output

- Project intent and risk class
- Detected stack with confidence and evidence
- Source roles and conflicts
- Template verdict
- Required roles, skills, tools, and gates
- Open decisions and first executable task

Unknowns remain explicit. Do not install dependencies, scaffold, migrate, publish, or mutate external systems without authority.

<!-- city-fabric-child-context -->
## City Fabric child scope

When the work concerns a registered child application, resolve it before applying
this gate: run `infra project resolve <key>` from the Factory City root, or run
`infra project resolve` from inside that child. Treat the returned `knowledge`
directory as the tracked project context. Application checkout and `_output/`
remain local boundaries; this gate never authorizes a deploy, publish, release, or
mutation outside its declared task.
