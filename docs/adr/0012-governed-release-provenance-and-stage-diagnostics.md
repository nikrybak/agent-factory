# ADR-0012: Governed release provenance and bounded stage diagnostics

**Date**: 2026-08-30
**Status**: accepted
**Deciders**: it-orchestrator, solution architect, application-architecture guardian, security engineer, release engineer, QA lead

## Context

Current v2 provenance proves content integrity and contextual currency, and an Ed25519 signature
can be checked against a caller-supplied public key. It does not prove that the signing identity is
approved by the project's governed trust policy. An unsigned attestation can therefore look too
similar to release-grade proof, while an arbitrary `--public-key` can be mistaken for a trust
anchor.

Stage-provider boundaries also collapse every unexpected exception into
`STAGE_PROVIDER_EXECUTION_FAILED`. That is secret-safe, but it hides stable recoverable conditions
such as ledger contention or a conflicting ledger head.

## Decision

### Structural provenance and release trust remain separate

`verifyAttestation` continues to verify deterministic payload integrity, contextual currency, and
an optional caller-supplied Ed25519 signature. A separate release-trust assessment consumes the
attestation plus the current governed trust policy. Unsigned, historical, legacy-signed, or
caller-key-only attestations remain integrity-auditable but explicitly advisory.

Release-grade provenance requires Ed25519; a non-empty governed `keyId`; an exact allowlisted
public SPKI key and SHA-256 fingerprint; a domain-separated signature binding the attestation
digest, algorithm, key identity, and canonical provenance-policy digest; and exact current-policy
currency. Policy drift or key rotation fails closed.

Current release-capable v2 payloads add `workflowRunId` and `planHash`; both are part of
`attestationDigest`. Structural verification allows a legacy v2 payload without them, but release
assessment requires a safe explicit run identifier and exact selected plan hash. The governed
signature record is exactly:

```json
{
  "schemaVersion": "1.0.0",
  "algorithm": "Ed25519",
  "keyId": "release-2026",
  "keyFingerprintSha256": "64 lowercase hexadecimal characters",
  "provenancePolicyDigest": "64 lowercase hexadecimal characters",
  "value": "canonical base64 signature"
}
```

The signed bytes are UTF-8 canonical JSON of exactly
`{domain:"factory.release-provenance/v1", attestationDigest, algorithm:"Ed25519", keyId,
keyFingerprintSha256, provenancePolicyDigest}`. Unknown or missing signature-record fields deny
release grade. Structural legacy signature verification remains backward-compatible.

The public key is not secret and may be embedded for offline verification. Private key bytes and
paths never enter policy, attestation, evidence, diagnostics, or logs. The existing
`--private-key` option may sign only when its derived public fingerprint selects one unique
governed key; identity is not inferred from a filename. `--public-key` remains an inspection input
and cannot grant release grade.

The trust-policy extension is additive and optional for existing 1.0 policies. A missing or empty
allowlist denies release grade without invalidating structural policy evaluation. Existing v1/v2
and legacy signature records remain auditable and advisory. The repository policy keeps an empty
allowlist until an operator separately governs a public release key; no private material is added.

The optional policy section is exactly:

```json
{
  "provenance": {
    "schemaVersion": "1.0.0",
    "algorithm": "Ed25519",
    "trustedKeys": [
      {
        "keyId": "release-2026",
        "publicKeySpkiBase64": "canonical DER SPKI base64",
        "fingerprintSha256": "64 lowercase hexadecimal characters"
      }
    ]
  }
}
```

`keyId` matches `^[a-z][a-z0-9-]{0,62}$`. DER is an Ed25519 SPKI public key encoded as canonical
RFC 4648 base64 without whitespace and re-exports byte-identically; the fingerprint is lowercase
SHA-256 of those decoded DER bytes. Validator and assessor reject unknown fields, malformed keys,
mismatched fingerprints, duplicate key IDs, duplicate fingerprints, and duplicate SPKI values.
The provenance-policy digest is `stableDigest(canonicalize(policy.provenance))` over exactly that
validated authored object; the whole execution trust policy and synthetic defaults are excluded.

### Preserve the workflow DAG

City certification and prepare-only delivery require structurally current provenance but not a
release signature. Requiring a final signature during pre-quality City would create a cycle
because final provenance must bind the completed run.

After an explicitly selected run is COMPLETE, `infra attest` can create governed signed
provenance for that exact final evidence set. Outward `release`, `deploy`, and `publish` plans
require a current release-grade assessment in addition to complete workflow, complete City,
manifest authority, and adapter readiness. `prepare` remains advisory-capable. Signature trust
never grants permission to mutate, publish, deploy, or release.

City carries the release assessment under `reports.provenance.releaseAssessment` while retaining
structural provenance as its ordinary district decision. `planDelivery` for outward actions
requires that nested assessment to have `releaseGrade: true` and a `workflowRunId` equal to the
selected complete workflow. `infra attest --private-key` requires an explicit existing `--run`
whose workflow state is COMPLETE. No additional key-identity option is introduced.

Unsigned successful `infra attest` output is explicitly `ADVISORY`; malformed or stale persisted
provenance fails closed and is never silently replaced.

`infra attest --write` atomically writes exactly one selected document at
`.factory/provenance.json`:

```json
{ "schemaVersion": "1.0.0", "workflowRunId": "selected-run", "attestation": { "...": "the complete attestation" } }
```

No verification or assessment is persisted. Readers accept only that exact top-level shape, re-evaluate it
against the current policy and current selected-run evidence, and never fall back to another run
or silently generate a replacement. Release assessment requires exact equality for
`workflowRunId`, `planHash`, source tree, certification identity, layout input, manifest, SBOM,
and the sorted accepted evidence digests supplied by the selected completed run. An absent file
yields a generated unsigned structural attestation plus advisory assessment; a present malformed,
stale, or wrong-run file fails City provenance and is never silently replaced.

The recomputed assessment is exactly
`{schemaVersion:"1.0.0", status, releaseGrade, advisory, workflowRunId, keyId,
keyFingerprintSha256, provenancePolicyDigest, gaps:[{code}]}`. Status is `PASS` only for release
grade, `ADVISORY` for structurally current but unsigned/caller-key/legacy provenance, and `FAIL`
for malformed, tampered, stale, or wrong-run persisted provenance.

### Versioned safe stage diagnostics

A pure classifier maps only exact allowlisted upstream `error.code` values and the governed stage
operation to fixed records. It never serializes or parses an error message, path, stack, cause,
syscall, command, or unknown code. Known ledger and bounded platform conditions receive stable
codes, a fixed category, and retryability. Unknown, uncoded, malformed, hostile, or
accessor-throwing values remain exactly `STAGE_PROVIDER_EXECUTION_FAILED`.

The fixed record is bounded and still passes through recursive redaction before hashing. Existing
successful receipts are unchanged. Failed receipts with newly specific codes must be rerun; no
historical evidence is rewritten.

The serialized diagnostic is exactly
`{schemaVersion:"1.0.0", operation, code, category, retryable}`. `operation` is one of the five
governed stage operations. The exact upstream-code mapping is:

| Upstream code | Stage code | Category | Retryable |
|---|---|---|---|
| `LEDGER_PATH_UNSAFE` | `STAGE_PROVIDER_LEDGER_PATH_UNSAFE` | policy | false |
| `LEDGER_JSON_INVALID`, `LEDGER_CHAIN_INVALID` | `STAGE_PROVIDER_LEDGER_INVALID` | integrity | false |
| `LEDGER_LOCK_TIMEOUT` | `STAGE_PROVIDER_LEDGER_LOCK_TIMEOUT` | contention | true |
| `LEDGER_HEAD_CONFLICT` | `STAGE_PROVIDER_LEDGER_HEAD_CONFLICT` | conflict | true |
| `LEDGER_EVENT_REDACTION_FAILED` | `STAGE_PROVIDER_REDACTION_FAILED` | security | false |
| `LEDGER_COMMIT_UNCONFIRMED` | `STAGE_PROVIDER_LEDGER_COMMIT_UNCONFIRMED` | durability | false |
| `LEDGER_LOCK_OWNER_MISMATCH` | `STAGE_PROVIDER_LEDGER_OWNER_MISMATCH` | integrity | false |

All other inputs use `STAGE_PROVIDER_EXECUTION_FAILED`, category `internal`, retryable `false`.
The classifier reads `error.code` once inside a guarded boundary; access failure is generic.

## Alternatives considered

- Caller-supplied keys as trust anchors were rejected: validity is not authorization.
- Signed provenance inside City was rejected because it deadlocks the DAG.
- Tracked private keys or key paths were rejected because custody is external.
- Sanitized raw exception messages were rejected because they are neither stable nor safe.

## Consequences

- Local unsigned attestations remain useful without becoming release proof.
- Key or policy drift immediately removes release-grade status.
- Projects without a governed public key cannot create outward delivery plans.
- Known stage failures become actionable without expanding the secret surface.
- The policy extension is backward-compatible; no database, external API, data migration, key
  generation, or external action is performed.

## Verification

Focused tests cover policy/key fingerprints, domain separation, unsigned/legacy advisory behavior,
wrong/unlisted/rotated keys, policy drift, tampering, caller-key non-authority, final-run binding,
prepare/outward separation, and persistence. Stage tests cover every allowlisted code, hostile and
throwing values, raw-field canaries, bounded output, real contention, receipt round-trip, existing
wrong-stage/run behavior, and the complete 20-step DAG.
