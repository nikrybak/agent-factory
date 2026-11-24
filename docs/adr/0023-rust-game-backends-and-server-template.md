# ADR-0023: Rust game backends and the game-server template

Date: 2026-10-07
Status: Accepted by owner decision, 2026-10-07

## Context

Every game of the owner has its own backend so that nothing of value is decided on the device (cheating,
purchases, rewards). The player platform (Player Center) and the payment platform (Billing Center) are Rust
services with the same conventions: axum, sqlx with offline metadata, a crate per module behind seams, nextest,
llvm-cov, cargo-deny, OpenAPI with contract tests. Worlio, the first game, has a Kotlin backend that grew its own
copies of platform plumbing (session trust, webhook verification, ordering and catch-up), which the owner saw as
about seventy integration files and asked to make "unrealistically simple" for the next games.

## Decision

1. **One stack for game backends: Rust**, the same as the platforms. The platform-side code a game needs
   (Standard Webhooks verification with key rotation, replay protection, per-player ordering, the catch-up feed,
   JWKS session verification, the Billing Center client) is published from the platform repositories as crates
   and used as they are: no port, so a game and the platform cannot disagree.
2. **A game-server template** in this repository (`templates/`, registered in `templates/REGISTRY.md`): a
   workspace with the server kit wired in, sessions, rate limits, idempotency, server-authoritative progress,
   currency and rewards, signed run tickets, migrations, OpenAPI, CI with the routed `runs-on`, container image and
   k3s manifests in the platform's shape. A new game is the template plus its game logic, a manifest and one SDK
   dependency on the client.
3. **Security is the template's default, not the game's task**: every value-bearing change is decided by the server;
   clients send intents; integrity signals (Play Integrity, HMS SafetyDetect) are risk inputs, never the only
   defence; no secret ever ships in a client.
4. **Worlio moves to Rust** (owner decision of the same day) as the template's first user: the same HTTP API, the
   same PostgreSQL schema and migrations byte for byte, every existing check green, proven by a differential
   harness that runs the Kotlin and the Rust server against the same database and request corpus. Kotlin stays
   deployable until the Rust server has run in production without regression; rollback is one image switch.
5. **Other stacks** remain possible for special cases; they must pass the kit's published conformance vectors.

## Consequences

- The platform repositories gain a publishable kit crate and its conformance vectors.
- The second game is built from the template and measures the real integration cost (files and hours).
- Worlio's port is planned in waves with an exhaustive inventory (routes, tables, jobs, tests, dependents) as the
  completion checklist; its own ADR records the switch.
