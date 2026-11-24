# Mobile platform verification

## Decision table

| Target | Minimum evidence after a relevant change | Cannot be substituted by |
|---|---|---|
| Android | Detected Gradle unit/lint checks; emulator or device evidence for changed native/user behavior | iOS simulator, browser tests, static review only |
| iOS/iPadOS | Xcode build/test on macOS; simulator or device evidence for changed native/user behavior | Android results, Windows-only checks |
| Kotlin Multiplatform | Shared-module tests plus each changed platform consumer's lane | A passing common-test suite alone |
| Flutter / React Native | Detected JavaScript/Dart checks plus each changed native platform lane | A bundle build with no native validation |
| Unity | Detected Unity project checks plus target-platform build/device evidence when behavior changes | Generic C# compilation only |

## Source links

- Android architecture and Compose state flow: <https://developer.android.com/topic/architecture/recommendations>
- Compose UI architecture: <https://developer.android.com/develop/ui/compose/architecture>
- Apple SwiftUI app lifecycle: <https://developer.apple.com/documentation/technologyoverviews/swiftui>
- Apple SwiftUI performance tooling: <https://developer.apple.com/documentation/Xcode/understanding-and-improving-swiftui-performance>
- Kotlin server documentation: <https://ktor.io/docs/welcome.html>

These links guide technical choices. They do not supply credentials, signing
material, store authority, or permission to run platform commands.
