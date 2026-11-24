# ADR-0013: Opened catalog bytes and owner-safe run locks

**Date**: 2026-08-30
**Status**: accepted
**Deciders**: it-orchestrator, solution architect, application-architecture guardian,
security engineer, infrastructure engineer, QA lead

## Context

Factory policy, provider, adapter, workflow and evaluation catalogs are governed inputs, but
several consumers resolve a pathname and later call `readFileSync`. On Windows a project catalog
directory can be a junction to an external directory: changing an external trust policy changes
the bytes consumed by planning or certification while the source-tree hash remains unchanged.

Factory run locks also treat `expiresAt` as permission to delete an existing lock. A legitimate
step that runs longer than its nominal TTL can therefore lose ownership to another process, and
`runProjectStep` currently ignores a failed owner release.

The broader ADR-0011 residual risk remains: pure Node v26 on this Windows host exposes neither
descriptor-relative open/rename/unlink/spawn nor `O_NOFOLLOW`/`O_DIRECTORY`. Static identity
comparison is not a proof against a malicious same-principal ABA filesystem actor.

## Decision

### Governed catalog bytes use one opened-object boundary

`filesystem-boundary.js` is the only primitive for reading an authoritative bounded file.
`catalog-loader.js` is the only loader for governed Factory JSON catalogs. The boundary:

1. lexically confines a relative path to its declared canonical root;
2. captures every existing ancestor and the final path identity;
3. rejects symlink, junction or reparse entries, non-directory ancestors, non-regular final
   objects, hard-linked final objects and oversized input;
4. opens the final file once, compares the opened descriptor identity to the captured path
   identity, and reads only that descriptor;
5. rechecks ancestor and final identities after open and after read; and
6. exposes only fixed path-free failure codes.

The exact boundary constants are:

The current Windows capability object is exactly:

```json
{
  "schemaVersion": "1.0.0",
  "provider": "node-opened-descriptor-static-fence",
  "platformFamily": "win32",
  "openedDescriptorBytes": true,
  "ancestorIdentityComparison": true,
  "finalIdentityComparison": true,
  "staticLinkRejection": true,
  "descriptorRelativeResolution": false,
  "descriptorRelativeMutation": false,
  "samePrincipalAbaResistance": false
}
```

On every non-Windows host the exact object differs only in
`"platformFamily":"posix"`. `FILESYSTEM_BOUNDARY_VERSION` is exactly `1.0.0`. The capability
digest is `hashValue(capability)` over the actual one-value canonical object, never over a
placeholder or a union value. Every evidence binding carries exact
`filesystemBoundaryVersion` and `filesystemCapabilityDigest` before its `bindingDigest` is
sealed. Every receipt repeats both fields. Planning, runtime selection and evidence assessment
require binding, receipt and current runtime parity. Missing or mismatched values require re-plan
and re-run and cannot reach provider execution.

The canonical root is the first checked ancestor. Every ancestor identity comes from
`lstatSync(path, {bigint:true})` and is exactly `{dev, ino, type:"directory"}`. The final pre-open
and post-read path identities and the opened `fstatSync(fd, {bigint:true})` identity are exactly
`{dev, ino, type:"regular", nlink}` and require `nlink === 1n`. `dev` and `ino` must be usable
BigInt values and `ino > 0n`; otherwise capability is unavailable. Every tuple comparison is
exact. A catalog is read once from that descriptor into one bounded `Buffer`, its content digest
is lowercase `sha256(Buffer)` hexadecimal, and JSON is parsed from that same buffer. A capability
digest never substitutes for this raw-byte catalog content identity.

The fixed errors are:

| Code | Meaning |
|---|---|
| `FACTORY_FILESYSTEM_PATH_UNSAFE` | A path component or final object is outside the bounded regular-file contract |
| `FACTORY_FILESYSTEM_IDENTITY_CHANGED` | Captured, opened and current object identities differ |
| `FACTORY_FILESYSTEM_CAPABILITY_UNAVAILABLE` | The host cannot provide a required opened-object identity primitive |

Messages do not contain paths, native errors, file IDs or file bytes.

### Run locks are never stolen and release is owner-confirmed

`expiresAt` is informational. An existing, expired, malformed or unreadable lock always yields
fixed `RUN_LOCK_HELD`; automatic deletion is forbidden. Crash recovery remains an explicit
external destructive operation and is not added here.

Release reads the lock through the opened-object boundary, validates the exact schema, run ID and
token, rechecks the observed identity immediately before unlink, and removes only that owner file.
A wrong token, replacement, malformed file or unlink failure yields `RUN_LOCK_OWNER_MISMATCH`.
Successful unlink completes release. A different object that legitimately appears afterward is a
permitted successor, is preserved, and is not a release contradiction. Same-principal replacement
between the final identity check and pathname unlink remains the explicit P2.

`runProjectStep` does not return success when owner release is unconfirmed. A release failure is
path-free and blocks the invocation; it does not grant another process ownership or convert a
failed execution into PASS.

### Compatibility and scope

Public commands and the Factory JSON envelope remain unchanged. Binding and receipt fields are
additive but deliberately invalidate weaker plans/evidence. Existing plans must be recreated and
their steps rerun.

This decision closes static external-catalog aliasing and cooperative run-lock stealing. It does
not close descriptor-relative mutation/spawn, same-principal concurrent ABA, same-inode content
mutation, malicious replacement after the final recheck, or network/removable filesystem
assurance. Those remain `FC-FILESYSTEM-FENCE-P2`; the canonical nine-part Factory closure count
does not decrease in this bounded sub-slice.

## Alternatives considered

### Continue realpath/lstat checks

- **Pros**: no compatibility change.
- **Cons**: check-then-use accepts changed objects and already permits a stable-hash external
  junction bypass.
- **Why not**: it does not bind decisions to the bytes actually opened.

### Claim full Node-only TOCTOU protection

- **Pros**: superficially closes the risk without another provider.
- **Cons**: Node has no descriptor-relative mutation/spawn API on the current host, so the claim
  is untestable and false under same-principal ABA.
- **Why not**: unsupported assurance must remain an explicit gap.

### Steal expired leases automatically

- **Pros**: automatic crash recovery.
- **Cons**: wall-clock expiry cannot prove the owner process stopped; two writers can persist
  conflicting checkpoint/evidence state.
- **Why not**: correctness requires explicit recovery authority and fencing.

## Consequences

### Positive

- Governed plan and certification inputs come from exact opened regular-file bytes.
- Static external junctions and leaf links fail before planning, execution or certification.
- Weak pre-ADR plans and receipts cannot be silently treated as current.
- A long-running cooperative step retains exclusive ownership beyond its nominal TTL.

### Negative

- Existing Factory runs require re-plan and re-run.
- A crash leaves an orphan lock for explicit operator recovery.
- Full adversarial filesystem P2 remains open until a descriptor-relative provider exists.

## Verification

Tests cover regular opened bytes, ancestor junctions, final links, non-regular/hard-linked and
oversized files, ancestor/final replacement hooks, path-free errors, deterministic capability
identity, plan/binding/receipt/runtime parity and an enforcement scan proving all authoritative
catalog consumers use the canonical loader.

Run-lock tests cover expired and malformed locks, wrong tokens, replacement before unlink,
ignored-release regression, a real two-process hold beyond nominal TTL, subsequent acquisition,
and link rejection. New security-critical modules require 100% statements, branches, functions
and lines.
