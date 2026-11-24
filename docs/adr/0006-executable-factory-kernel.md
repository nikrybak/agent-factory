# ADR-0006: Executable local factory kernel

Date: 2026-07-12
Status: Accepted

## Context

The repository has strong governance documents but lacks an executable source of
project profile, workflow state, and quality evidence. Conversational orchestration
cannot reliably resume, prove applicability, or reject stale claims.

## Decision

Build a zero-dependency CommonJS kernel under `cli/lib/factory/` backed by declarative
JSON schemas/catalogs under `factory/`. The target repository stores its canonical
profile at `factory/project.json` and local run data under `.factory/`.

The CLI gains `init`, `detect`, `plan`, `run`, `status`, `resume`, `verify`, and
`explain`. Commands emit human text by default and JSON with `--json`. Project commands
use `--project DIR`; existing `sync`, `validate`, and `doctor` remain compatible.

Workflow is a DAG. Policy marks conditional gates N/A with reasons. Execution uses
argv with `shell: false`. Evidence includes schema version, step, status, command,
exit code, bounded output, timestamps, duration, and git tree identity. Verification
requires fresh PASS evidence for every applicable step.

## Alternatives considered

- YAML manifest: rejected for the first slice because zero-dependency parsing would be unsafe/incomplete.
- Database/service orchestrator: rejected because local portability and offline operation come first.
- Continue with prose gates: rejected because they cannot enforce transitions or evidence freshness.
- Execute command strings through a shell: rejected because of injection and quoting ambiguity.

## Consequences

- The factory becomes executable and resumable across AI harnesses.
- JSON is more verbose than YAML but deterministic and safely parsed.
- Local evidence is not cryptographically signed yet; tree binding and atomic writes reduce stale/partial claims.
- Stack adapters initially detect evidence but do not install or deploy.

## Tests required

- Manifest validation and safe initialization.
- Multi-stack/profile detection and unknown-stack gaps.
- DAG readiness, failure blocking, N/A reasoning, checkpoint/resume.
- Safe argv execution, output bounds, atomic evidence, stale-tree rejection.
- CLI end-to-end flows for all new commands and backward compatibility.

## Rollback plan

Remove `cli/lib/factory/`, declarative `factory/` catalogs, new CLI branches, and local
`.factory/` data. Existing compiler commands remain independent.
