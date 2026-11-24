# ADR-0014: Operator-enrolled physical toolchain trust

**Date**: 2026-08-30
**Status**: accepted
**Deciders**: it-orchestrator, solution architect, application-architecture guardian,
security engineer, infrastructure engineer, QA lead, documentation engineer

## Context

An immutable argv and a physically resolved executable identity prevent simple command
substitution, but they do not authorize the selected bytes. Treating a basename found through
`PATH` as trusted would let a newly installed or substituted binary become governed merely by
being discoverable. Trust-on-first-use would preserve the same weakness in a local file.

The Factory needs a host-local authority for non-Node tools while keeping the existing exact
process runtime as the only bootstrap anchor. That authority must participate in planning,
freshness, runtime validation and evidence receipts without being confused with release-grade
provenance or a claim that every child adapter is operationally closed.

## Decision

### Exact process anchors are closed and non-extensible

Only the exact logical executable strings `node`, `npm`, and `npx` are process anchors. `node`
binds to the current process executable. `npm` and `npx` bind to that same opened executable plus
the fixed runtime-relative `node_modules/npm/bin/npm-cli.js` or `npx-cli.js` opened bytes; no
`.cmd`, shell, shebang, `/usr/bin/env`, or other wrapper is trusted as the anchor.

The runtime-relative location follows the Node install layout (amended 2026-10-04): on Windows
the CLI sits beside `node.exe` (`<dir>/node_modules/npm/bin/...`); on POSIX it sits under the
install prefix (`<prefix>/bin/node`, `<prefix>/lib/node_modules/npm/bin/...`). Both are fixed and
never searched. The anchor executable is never accepted through a symbolic link: Node reports the
physical executable as `process.execPath`, so a linked anchor is a substitution.

The local overlay cannot add or replace these three names. Case variants, extensions and
lookalikes are not anchors. Every other executable is a non-anchor even when it resolves to the
same physical file as the current Node process.

### Non-anchor authority is an ignored, operator-confirmed exact-digest overlay

The only local non-anchor authority is `<project>/.factory/toolchain-trust.json`. `.factory/` is
ignored by Git, so the document is machine/operator state: it is never authored project policy,
never copied into the child registry, and never a release artifact. The exact schema is
`factory/schema/toolchain-trust.schema.json` version `1.0.0`:

```json
{
  "schemaVersion": "1.0.0",
  "platformFamily": "win32",
  "entries": [
    {
      "logicalExecutable": "python",
      "sha256": ["<64 lowercase hexadecimal characters>"]
    }
  ]
}
```

`platformFamily` is exactly `win32` on Windows and `posix` elsewhere. The object and each entry
have no additional properties. There are at most 256 entries; every normalized logical name is
unique, lowercase, matches `^[a-z][a-z0-9._+-]{0,63}$`, and is not `node`, `npm`, or `npx`.
Entries are sorted by logical name. Each entry contains one to 64 unique lowercase SHA-256
digests, sorted lexically. Duplicate JSON keys, a BOM, trailing non-whitespace, prototype keys,
links, non-regular objects, hard links, oversized input, invalid opened identities and platform
mismatch fail closed.

The operator must supply an absolute executable path and independently confirm its exact digest.
The internal `enrollToolchainExecutable` primitive also requires the expected current overlay
content digest as a compare-and-swap input before atomic replacement. It never searches `PATH`,
never accepts an observed digest as implicit consent, and rejects anchors and control
interpreters. It is an internal module primitive, not a public CLI. This ADR intentionally adds
no `infra enroll`, public enrollment command, network enrollment API, TOFU flow, or automatic
catalog-to-overlay enrollment.

`PATH` may locate a candidate for an already governed command, but contributes no authority. A
candidate executes only when its opened-byte SHA-256 is already present under the normalized
logical name in the exact current overlay.

### Opened-byte identity spans plan, freshness, runtime and receipt

`loadToolchainTrust` reads the overlay through the ADR-0013 opened-object boundary and returns a
snapshot containing presence, exact content digest, serialized opened path identity, filesystem
boundary version/capability digest and validated entries. Absence is also a deterministic
snapshot. The plan stores the path-free trust identity and includes it in `planHash`; each
non-anchor launch authorization additionally embeds the same trust-document identity and the
exact executable content digest in its sealed launch binding.

Plan freshness re-resolves the overlay. Appearance, disappearance, raw-byte change, opened-object
identity change, platform change, filesystem-capability change, or launch-authorization change
stales the plan and requires re-plan. A self-rehashed old plan cannot upgrade itself.

Immediately before spawn, `resolveLaunch` reopens and hashes the resolved executable, checks its
physical identity, validates the sealed authorization, and reloads the overlay for non-anchors.
For `node`/`npm`/`npx`, it also proves the executable is the current process executable; `npm` and
`npx` additionally reopen the fixed CLI bytes. Immediately after the child exits and before a
receipt can be sealed, the runner repeats `resolveLaunch`. Overlay or executable drift therefore
cannot produce PASS evidence. The command receipt retains the exact planned command with its
sealed launch binding, while each process component repeats `launchDigest`; receipt assessment
requires exact command equality and digest parity with the selected plan.

### Native formats and wrappers fail closed

Windows direct tools are limited to opened regular `.exe` or `.com` files; `.cmd`, `.bat`,
`.ps1`, shells and control interpreters are rejected. POSIX candidates require execute
permission and platform-matched native magic: ELF on the supported ELF platforms or thin Mach-O
on Darwin. Shebang scripts, environment wrappers, text files, Java class files, an unsupported
native format, or a native format for another platform fail with capability unavailable. This is
deliberately narrower than operating-system executability.

### Failures are fixed, path-free and actionable

| Code | Fixed message | Meaning |
|---|---|---|
| `FACTORY_TOOLCHAIN_TRUST_INVALID` | `local toolchain trust is invalid` | Overlay bytes, schema, platform or opened-object contract is invalid |
| `FACTORY_TOOLCHAIN_UNAUTHORIZED` | `governed executable is not authorized` | No exact anchor or enrolled logical-name/digest authority exists |
| `FACTORY_TOOLCHAIN_TRUST_CHANGED` | `local toolchain trust changed` | Sealed local authorization no longer matches the current overlay |
| `FACTORY_TOOLCHAIN_ENROLLMENT_INVALID` | `local toolchain enrollment is invalid` | Internal enrollment inputs, confirmation, CAS or executable policy failed |
| `FACTORY_LAUNCH_BINDING_INVALID` | `governed launch binding is invalid` | Persisted launch shape or digest is malformed |
| `FACTORY_LAUNCH_IDENTITY_CHANGED` | `governed launch identity changed` | Opened executable/CLI identity differs from the sealed binding |
| `FACTORY_LAUNCH_CAPABILITY_UNAVAILABLE` | `governed launch capability is unavailable` | The host/path/format cannot provide the required physical binding |

Planning maps non-anchor authorization failure to the explicit
`EVIDENCE_TOOLCHAIN_UNAUTHORIZED` capability gap. Messages contain no filesystem path, native
error, file identifier, or bytes.

### Trust domains and scope stay separate

Exact local tool authorization is operator-grade execution trust only. It is not a signature,
release-grade provenance, manifest authority, deploy/publish permission, software-vendor trust,
or proof that a binary is safe. ADR-0012 release trust remains an independent completed-run,
policy and Ed25519 assessment.

Every binary update changes the digest and requires explicit re-enrollment followed by re-plan
and re-run. A child adapter using a non-anchor remains blocked until the operator enrolls the
exact host binary. This implementation does not claim that all child adapters, package managers,
SDKs, hosts, native formats, or external toolchains are enrolled or closed.

### Public API and compatibility

The public CLI command/option set and the JSON/human envelope remain unchanged. The ignored file
is a versioned local filesystem contract, not a public network API; Postman, OpenAPI, browser E2E
and public-API migration are therefore N/A. Existing plans/evidence without the new trust identity
remain integrity-auditable but are not current trusted execution evidence.

## Module and test contracts

- `cli/lib/factory/toolchain-trust.js` solely validates, loads, identities, authorizes,
  revalidates and internally enrolls the local overlay.
- `factory/schema/toolchain-trust.schema.json` owns the portable document shape; stricter sorting,
  duplicate-key, opened-object, platform and CAS invariants are runtime requirements.
- `cli/lib/factory/launcher.js` owns physical executable/Node CLI identity, native-format policy,
  sealed authorization and pre/post runtime revalidation.
- `cli/lib/factory/evidence-providers.js` maps missing authority to an explicit planning gap;
  `runner.js`, `evidence.js`, and `engine.js` preserve plan/freshness/receipt parity.
- `factory-toolchain-trust.test.js` must cover schema, exact anchors, exact digest authorization,
  no-PATH/no-TOFU enrollment, raw-byte/physical drift, CAS and fixed errors.
- Launcher, runner, provider, evidence and engine tests must cover native/wrapper fail-closed
  behavior, exact process anchoring, pre/post drift, receipt parity, explicit gap and stale plan.
  The new trust module requires 100% statements, branches, functions and lines.

## Alternatives considered

### Authorize whatever `PATH` resolves

- **Pros**: no local enrollment step.
- **Cons**: search order, install state and working environment become authority.
- **Why not**: discovery cannot grant execution trust.

### Trust on first use

- **Pros**: automatic local setup.
- **Cons**: the first malicious or accidental candidate becomes trusted without operator intent.
- **Why not**: observation is not confirmation.

### Add a public enrollment CLI now

- **Pros**: convenient operator workflow.
- **Cons**: creates a new authority-bearing public surface before authentication, UX, audit and
  recovery policy are designed.
- **Why not**: the bounded local file/internal primitive closes runtime authorization without
  granting new public authority.

## Consequences

### Positive

- Only exact current process anchors or pre-confirmed non-anchor bytes can execute a governed
  evidence command.
- Trust changes stale planning and cannot be hidden by PATH substitution or receipt rehashing.
- Wrapper/interpreter chains and unsupported native formats are explicit capability gaps.
- Fixed diagnostics are actionable without disclosing host paths.

### Negative

- Operators must re-enroll after every legitimate binary update and rerun affected plans.
- A portable repository cannot carry machine-local executable trust in Git.
- Some otherwise executable POSIX tools and child adapters remain unsupported until a safe native
  binding and explicit enrollment are available.

### Risks

The launcher opens and validates bytes, then the operating system spawns by pathname. Node does
not provide the descriptor-relative spawn/mutation primitive required to exclude malicious
same-principal ABA or replacement between the final check and process creation. Post-exit
revalidation detects ordinary drift but cannot prove which bytes the kernel executed during an
exact ABA. This remains the explicit `FC-FILESYSTEM-FENCE-P2` capability gap from ADR-0013; local
toolchain trust must not be described as full adversarial filesystem assurance.
