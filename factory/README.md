# Executable Software Factory

The `factory/` directory contains authored project intent, public schemas, and
declarative catalogs. Mutable checkpoints and evidence live in ignored `.factory/`.

## Commands

```bash
node cli/bin/infra.js init --project C:\path\to\project --profile cli --json
node cli/bin/infra.js detect --project C:\path\to\project --write --json
node cli/bin/infra.js plan --project C:\path\to\project --goal "Ship feature" --json
node cli/bin/infra.js status --project C:\path\to\project --json
node cli/bin/infra.js resume --project C:\path\to\project --json
node cli/bin/infra.js explain --project C:\path\to\project --step security --json
node cli/bin/infra.js verify --project C:\path\to\project --json
```

Execute a ready step by placing the exact argv after `--`:

```bash
node cli/bin/infra.js run --project C:\path\to\project --step tests -- \
  node --test
```

No shell parses the command. State-changing or outward-facing authority is false by
default in `project.json` and cannot be inferred from a successful check.

## Files

- `project.json` — authored project intent, risk, profiles, authority, and quality policy.
- `schema/project.schema.json` — public strict manifest schema.
- `catalog/profiles.json` — composable project profiles.
- `catalog/stack-signals.json` — evidence-only stack detection signals.
- `catalog/workflow.json` — canonical workflow dependency graph.
- `.factory/detection.json` — generated detection report.
- `.factory/runs/<id>/` — generated plan, checkpoint, and evidence attempts.

Generated observations never rewrite authored intent. Unknown capabilities, missing
evidence, failed steps, and stale tree hashes remain blocking gaps.

## Complete Factory City

The kernel is closed by ten certified districts:

- `trace` — intent-to-release artifact graph;
- `workforce` — typed role routing and separation of duties;
- `adapters` — stack operation SDK and argv plans;
- `trust` — roots, tiers, authority, risk, and egress;
- `sbom` / `attest` — deterministic inventory and Ed25519 provenance;
- `eval` — golden invariant suite with a 100% completion threshold;
- `observe` — append-only hash-chain ledger and SLO summary;
- `control` — aggregate local control-tower health;
- `release-plan` — verification, action, and mandatory rollback phases;
- `certify` — current-tree `COMPLETE` verdict with zero hidden gaps.

```bash
node cli/bin/infra.js certify --project . --json
```
