# Mobile and Kotlin capability packs

## Purpose

City Fabric keeps mobile and Kotlin expertise inside the repository without
making any platform SDK, account, runtime, or product framework a prerequisite
of the infrastructure. `factory-mobile-platform-gate` selects the native
verification lane; `factory-kotlin-backend-gate` selects backend guidance.

## Capability coverage

| Area | Packs | Required boundary |
|---|---|---|
| Android | 34 source-pinned `android-*` packs: architecture, Compose, Material 3, accessibility, Gradle, networking, persistence, security, testing, emulator automation, releases and modernization | Android result requires the detected Gradle checks and an emulator/device lane for changed native behavior. |
| iOS / SwiftUI | `swiftui-expert-skill`, `swiftui-patterns`, Swift concurrency, actor persistence and DI/testing packs | Native proof requires macOS/Xcode and a simulator or device when behavior changes. |
| Kotlin Multiplatform | `compose-multiplatform-patterns`, Kotlin language/tooling/coroutine packs | Common-code tests do not replace each changed platform consumer. |
| Kotlin backend | Ktor patterns plus 25 source-pinned Kotlin + Spring packs for API/error, security, transactions, JPA, configuration, tests, observability and resilience | Framework and storage are detected first; API/security/migration evidence is selected by change scope. |
| Flutter, React Native, Unity | Existing Flutter and Unity packs plus `react-native-mobile-patterns` | A shared/Dart/JS check never substitutes for the changed native platform lane. |
| Data | Prisma Client, CLI, Postgres, migration and upgrade packs | Guidance cannot authorize a schema/data mutation. |

## Imported source snapshots

| Source | Revision | License | Intake decision |
|---|---|---|---|
| [android-agent-skills](https://github.com/krutikJain/android-agent-skills) | `c5bf6731b8441019418784484cca1578413e6ad3` | MIT | Imported after static inspection: 34 packages, linked references and opt-in helpers. |
| [Kotlin backend agent skills](https://github.com/yalishevant/kotlin-backend-agent-skills) | `fd0ed521d22efd28221d532c9abab97af0b9bf0e` | MIT | Imported after static inspection: 25 Kotlin + Spring guidance packages, no vendor coupling. |
| [SwiftUI Agent Skill](https://github.com/AvdLee/SwiftUI-Agent-Skill) | `4c6a97d15aa5e023538c3cb06b5192f241dd451d` | MIT | Imported after static inspection: one SwiftUI guidance package and opt-in Instruments helpers. |
| [Kotlin agent skills](https://github.com/Kotlin/kotlin-agent-skills) | `08d7ad0d74a9a5a548287b2bd4926180fab56cac` | Apache-2.0 | Retained publisher-owned Kotlin/Android/Native tooling pack. |
| [Unity skills](https://github.com/Unity-Technologies/skills) | `3cba0ced12be52be708d8977d99f7af50709122a` | Unity Companion License | Retained opt-in Unity/mobile/UI pack. |

The generated `skills/REGISTRY.json` is the integrity and source-of-truth index
for individual package digests. Required MIT texts are in `skills/.licenses/`.

## Authority and runtime rules

1. Imported helper scripts are not automatic actions. Inspect them, verify the
   target, and obtain authority before any action that installs, rewrites,
   changes a device, signs, publishes, deploys, or releases.
2. The active application controls framework versions and commands. A skill does
   not introduce a dependency or assume a package manager.
3. iOS remains explicitly host-bound: Windows can prepare code and evidence but
   cannot produce native Apple verification.
4. Android and iOS are equal verification lanes. Cross-platform success is the
   conjunction of applicable platform evidence, not a passing build on one OS.
5. The core Factory City flow remains usable with no mobile pack invoked.

## Primary technical references

- [Android architecture recommendations](https://developer.android.com/topic/architecture/recommendations)
- [Compose UI architecture](https://developer.android.com/develop/ui/compose/architecture)
- [SwiftUI apps](https://developer.apple.com/documentation/technologyoverviews/swiftui)
- [SwiftUI performance analysis](https://developer.apple.com/documentation/Xcode/understanding-and-improving-swiftui-performance)
- [Ktor documentation](https://ktor.io/docs/welcome.html)
