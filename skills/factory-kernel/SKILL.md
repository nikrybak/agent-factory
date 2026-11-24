---
name: factory-kernel
description: Operate the executable stack-agnostic factory kernel through init, evidence-based detection, policy planning, safe argv execution, checkpoint/resume, verification, and decision explanation.
---

# Factory Kernel

Use this skill when a target repository has or needs `factory/project.json`.

## Workflow

1. Initialize metadata only with `infra init --project <root> --profile <profiles>`.
2. Review and tighten risk, capabilities, authority, and quality in `factory/project.json`.
3. Run `infra detect --project <root> --write --json`; unknown capabilities remain gaps.
4. Run `infra plan --project <root> --goal <goal> --json`; inspect policy and N/A reasons.
5. Use `status` or `resume` to select only dependency-ready work.
6. Execute a ready verification command as argv: `infra run ... --step <id> -- <command> <args>`.
7. Use `explain` for applicability/blocking decisions and `verify` for the aggregate verdict.
8. When Factory City catalogs exist, run `certify`; require `COMPLETE`, 100% traceability/evals, and zero gaps.

## Safety

- Never turn a command into a shell string.
- Never place credentials in argv, manifest, state, or evidence.
- Keep destructive/outward authority false unless the user explicitly grants it.
- A PASS does not authorize commit, publish, deploy, migration, or release.
- Missing, stale, tampered, failed, or unsupported evidence remains blocking.

Mutable `.factory/` data is local generated state; authored policy lives in `factory/`.

<!-- city-fabric-child-context -->
## City Fabric child scope

When the work concerns a registered child application, resolve it before applying
this gate: run `infra project resolve <key>` from the Factory City root, or run
`infra project resolve` from inside that child. Treat the returned `knowledge`
directory as the tracked project context. Application checkout and `_output/`
remain local boundaries; this gate never authorizes a deploy, publish, release, or
mutation outside its declared task.
