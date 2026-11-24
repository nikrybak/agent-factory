# ADR-0011: Transactional ledger and secret-free evidence boundary

**Date**: 2026-08-30
**Status**: accepted
**Deciders**: it-orchestrator, solution-architect, app-architecture guardian, security engineer, observability engineer, QA lead

## Context

The certification ledger currently performs an unlocked read, verification, full-file rewrite,
and rename. Two processes can therefore derive the same head and silently replace one another.
The candidate observation flow also certifies from one ledger snapshot, appends after a second
read, and certifies again from a third snapshot. Its decision and committed event are not one
transaction.

The runner redacts a narrow set of command flags only when it serializes the command summary.
Raw child output, explicit environment values, builtin metadata, stage summaries, diagnostics,
and exception messages can reach hashed evidence or operator output. Sanitizing after a digest
would either leak the value or invalidate the receipt.

## Decision

### Project-scoped ledger transaction

Separate pure chain semantics from durable storage. `ledger.js` owns entry creation, chain
verification, certification assessment, and summary. A new `ledger-store.js` owns the one
project-scoped ledger lock, snapshot read, transactional append, and durable atomic replacement.

The lock is acquired only through exclusive creation and carries an unpredictable owner token.
Every governed writer holds it from the initial verified snapshot through candidate calculation,
head/sequence comparison, replacement, and committed post-state calculation. Lock release occurs
in `finally` and removes only the caller-owned lock. A contended lock is retried for a bounded
period; an orphaned lock is never automatically stolen because a timestamp is not a fencing
token. Timeout fails closed with a named diagnostic and requires explicit operator recovery.

The transaction callback receives one immutable verified snapshot. Candidate City evaluation
uses that injected snapshot and returns the event to append. Immediately before commit the store
re-reads and verifies the visible ledger and compares its head and sequence with the transaction
snapshot. A mismatch fails with `LEDGER_HEAD_CONFLICT`; it never overwrites the newer chain.

The complete next chain is written with exclusive creation to a random same-directory temporary
file, flushed, atomically renamed over the ledger, and followed by a directory flush where the
host supports it. Readers inspect only the canonical filename and therefore see the previous or
next complete chain. Temporary artifacts never become observations. Invalid chains are never
replaced.

Full-file replacement remains O(n) for this local JSONL ledger. This decision optimizes
correctness and portability; segmented storage is a future scale change, not part of this slice.

### One redaction policy before sealing or output

Introduce a pure leaf `redaction.js` module. It owns the redaction policy version, sensitive-key
and flag classification, credential-free plan validation, exact runtime secret collection,
argv sanitization, bounded child-output sanitization, recursive structured-value sanitization,
and safe error formatting.

Raw secret values may exist only in the runner's short-lived execution memory. Provider catalog
argv and persisted plan bindings must be credential-free; sensitive literal arguments, URL/DSN
credentials, authorization headers, cookies, and sensitive query values fail planning. Future
secret injection requires an explicit non-persisted secret-reference contract. Runtime output is
sanitized using declared sensitive values and credential-shaped patterns before component
construction and before byte bounding. Secrets split across process chunks or a truncation
boundary cannot leave a suffix in evidence. A declared value shorter than four characters or a
boolean word (`true`, `false`, `yes`, `no`, `on`, `off`) is a flag, not a credential, and is not
replaced literally (amended 2026-10-04: `CHILD_SESSION=1` had turned every `1` of the output into
`<redacted>`); assignments and sensitive flags are still redacted by shape.

Runner receipts, builtin metadata, stage summaries, ledger events, diagnostics, JSON envelopes,
and human errors are recursively sanitized before hashing, persistence, or display. Sanitizer
failure produces a generic fail-closed value and never returns raw input. Evidence carries the
current policy version; imported evidence with a missing version or detectable sensitive content
is not current trusted evidence and must be regenerated. The policy never persists secret
hashes, lengths, or original values.

Sanitization is deterministic, idempotent, bounded, and preserves safe near-miss text and
cryptographic evidence digests.

The current `redactionPolicyVersion` is part of every plan-time evidence binding and therefore the
plan hash. Runtime selection requires exact equality between the binding version, evidence
version, and current policy version. A missing or changed version makes both the plan and its
receipts untrusted and requires re-plan and re-run; rehashing an old plan cannot upgrade it.

## Alternatives considered

### Append directly to JSONL

Rejected because independent append calls can interleave and durability differs across hosts;
candidate calculation would still not be bound to the committed head.

### Timestamp-based stale-lock deletion

Rejected because time does not fence a live or paused writer and can permit two owners.

### Redact only CLI output

Rejected because raw secrets would already be sealed in evidence and ledger content.

### Hash secret values for later detection

Rejected because the hashes become durable correlators and do not protect unknown output forms.

## Consequences

### Positive

- Concurrent governed writers cannot lose a successful event or expose partial JSON
- Candidate observation extends exactly the head it evaluated
- Evidence and operator output share one versioned sanitizer
- Sanitized receipts remain digest-verifiable after disk round-trip
- Historical unversioned evidence fails current trust instead of being silently accepted

### Negative

- A crashed process can leave a lock that requires explicit recovery
- Ledger commits rewrite the complete local chain
- Commands that previously embedded credentials in argv are rejected until a governed
  non-persisted secret-reference capability exists
- Existing evidence must be rerun under the current redaction policy

### Residual risks

- Pattern rules cannot infer arbitrary undeclared positional secrets; such inputs are rejected
  when declared sensitive and otherwise remain an operator/configuration responsibility
- Fully adversarial symlink swapping and external filesystem mutation require a separate
  no-follow/fenced storage hardening slice
- Windows may not support directory fsync; the implementation records platform support while
  retaining atomic same-directory replacement

## Verification

Focused tests use real concurrent processes to append unique events and prove exact-once strict
sequence. Fault injection proves pre-rename failures preserve the old valid chain, owner mismatch
cannot release a lock, orphan locks fail closed, invalid chains are not replaced, and candidate
observation uses one locked snapshot.

Canary tests cover separated and inline flags, headers, cookies, URL/DSN credentials, query
tokens, explicit environment secrets, every output chunk split, truncation boundaries, builtin
metadata, stage summaries, ledger events, diagnostics, JSON/human errors, idempotence, safe
near-misses, and digest round-trips. No persisted plan or evidence may contain the canary.

“CLI output” in this decision means every Factory command envelope and Factory command error path
owned by `cli/bin/infra.js`; unrelated legacy compiler commands keep their existing contracts.
