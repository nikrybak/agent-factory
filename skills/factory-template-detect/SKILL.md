---
name: factory-template-detect
description: Detect optional project-template provenance from `.template-ref` or fingerprints declared by registered manifests, without assuming a default stack. Только для инфры Software Factory (в корне: AGENTS.md с Factory City + cli/bin/infra.js).
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


# Template Detect

1. Read `.template-ref` when present and validate its `template` and `version` fields.
2. Check whether the named template is explicitly present in `templates/REGISTRY.md` and `templates/<name>/.template.json`.
3. Without a marker, compare project artifacts only against fingerprints declared by registered manifests.
4. Return exactly one verdict: `known-template`, `external-template`, or `unknown`.
5. Report evidence, registry support, recorded/current version when available, and limitations.

An empty registry is valid and produces `external-template` or `unknown`; never invent a default.
Run before `factory-template-sync` and during onboarding when template provenance matters.

<!-- city-fabric-child-context -->
## City Fabric child scope

When the work concerns a registered child application, resolve it before applying
this gate: run `infra project resolve <key>` from the Factory City root, or run
`infra project resolve` from inside that child. Treat the returned `knowledge`
directory as the tracked project context. Application checkout and `_output/`
remain local boundaries; this gate never authorizes a deploy, publish, release, or
mutation outside its declared task.
