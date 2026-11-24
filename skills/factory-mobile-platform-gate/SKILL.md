---
name: factory-mobile-platform-gate
description: Apply when a registered Factory City child changes an iOS, Android, Kotlin Multiplatform, Flutter, React Native, or Unity mobile surface and needs the correct platform-specific evidence plan.
---

# Factory mobile platform gate

Use this gate only in a Factory City repository. Resolve the child first with
`infra project resolve <key>` (or from inside the child) and use the returned
`knowledgeRoot` as the tracked project context. The application checkout and
`_output/` remain local boundaries.

## Choose the smallest applicable lane

- **Android / Compose:** use the relevant `android-*` capability pack, then
  `android-clean-architecture`, `kotlin-coroutines-flows`, and
  `kotlin-testing` where applicable.
- **iOS / SwiftUI:** use `swiftui-expert-skill`, `swiftui-patterns`, and the
  focused Swift concurrency, actor persistence, or DI/testing pack as needed.
- **Kotlin Multiplatform:** use `compose-multiplatform-patterns` and keep
  platform adapters explicit; shared-code tests do not prove either native UI.
- **Flutter:** use `dart-flutter-patterns` and `flutter-dart-code-review`.
- **React Native / Expo:** use `react-native-mobile-patterns`; preserve native
  Android and Apple verification lanes rather than treating JavaScript tests as
  universal proof.
- **Unity:** use `new-unity-project`, `unity-cli`, `ui-uitk` or the targeted
  Unity pack. Install or release actions still require explicit authority.

## Evidence contract

1. Identify the changed platform, app module, supported OS range, real device or
   emulator availability, and any shared API/data contract before editing.
2. For Android UI or behavior changes, run the detected Gradle unit/lint checks
   and obtain emulator/device evidence when the user flow or platform behavior
   changed. Report a missing SDK/device as a gap, not a pass.
3. For Apple targets, a macOS/Xcode/simulator-or-device lane is required for
   native build or UI proof. A non-macOS host may review and test shared code,
   but cannot certify the Apple lane.
4. For shared products, prove each changed consumer independently. Do not infer
   iOS validity from Android success, or the reverse.
5. Include accessibility, localization, offline/error state, and performance
   impact when the changed UI can affect them.
6. Hand the gathered evidence to `factory-mandatory-test-gate` and
   `factory-security-gate`. This skill cannot publish to a store, sign an
   artifact, mutate a device, or authorize a release.

## Required report

State the selected platform lane, applicable capability packs, commands and
evidence actually run, unavailable host/tooling, and the remaining verification
owner. Read `references/mobile-platform-verification.md` for the decision table
and official source links.

<!-- city-fabric-child-context -->
## City Fabric child scope

When the work concerns a registered child application, resolve it before applying
this gate: run `infra project resolve <key>` from the Factory City root, or run
`infra project resolve` from inside that child. Treat the returned `knowledge`
directory as the tracked project context. Application checkout and `_output/`
remain local boundaries; this gate never authorizes a deploy, publish, release, or
mutation outside its declared task.
