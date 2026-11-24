# ADR 0016: Bounded runtime-path environment

## Status

Accepted — 2026-08-30.

## Context

The Factory runner intentionally removes ambient environment variables before launching adapter
commands. Android Gradle Plugin requires an Android SDK root, while Unity Package Manager on
Windows requires standard application-data roots for its local IPC process. Removing those
non-secret path variables made trusted, pinned tools fail before tests could execute.

## Decision

Keep a closed allowlist and add only `APPDATA`, `LOCALAPPDATA`, `PROGRAMDATA`, `ANDROID_HOME`, and
`ANDROID_SDK_ROOT`. They join the existing OS, temporary-directory, user-home, path, CI and terminal
keys. Arbitrary variables remain absent. Explicit per-run values remain subject to the shared
redaction policy, and commands remain exact argv with `shell: false` and pre/post launch identity
validation.

## Consequences

- AGP can locate the enrolled SDK and Unity UPM can establish its local Windows IPC channel.
- The runner does not inherit tokens, credentials, proxy configuration, or application-specific
  variables by default.
- Unit tests prove required-path preservation and arbitrary-variable exclusion; governed Android
  and Unity runs provide integration evidence.
