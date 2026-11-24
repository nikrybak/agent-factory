# ADR-0008: Registry-addressed children and a repository-local skill canon

Date: 2026-08-21
Status: Accepted — decision 3 refined by ADR-0018 (application checkouts are `<key>-<version>/` repositories)

## Context

Factory City is a stack-neutral control plane, but its skill canon was deliberately
resolved from a user-level directory. That makes a clone incomplete and couples its
capabilities to one workstation. Separately, independent applications need to live
under one governed infrastructure root without turning their application source,
outputs, credentials, or release cycles into a monorepo.

The reviewed reference implementation at commit `30564d44` demonstrates the useful
part of this model: keys, not guessed folders or absolute paths, address every child
and its knowledge/output boundaries. No vendor-specific skills or integrations are
adopted from that reference. The `na` research records the mobile implication:
Android and iOS are equal verification lanes, while host- and account-specific
platform actions remain explicit external prerequisites.

## Decision

1. `app_entry_root/<key>/` is the City Fabric namespace for a child application.
   The key is the sole project identifier and is declared in
   `app_entry_root/_registry/registry.json`.
2. `infra project resolve|list|paths|scan` is the only path-resolution contract.
   It finds the Factory City root upward from the current directory and derives
   knowledge, output, and app paths from a validated registry entry.
3. A child tracks only `_project/` knowledge in this repository. Its application
   checkout and `_output/` are local, ignored boundaries. The only valid output root
   is the resolver-derived `app_entry_root/<key>/_output/<output-name>/` inside that
   child; neither the City Fabric root nor `app_entry_root/` owns a shared child-output
   directory. The registry contains references to owner files rather than copied URLs,
   secrets, release facts, or deployment configuration.
4. `skills/` becomes the repository-local canonical skill source. `agents.json`
   points to it and synchronization generates disposable tool mirrors. A skill
   provenance registry records source class, scope and integrity metadata.
5. Platform/mobile skills are capability packs, not runtime dependencies or
   permission to deploy. Android and iOS contracts require their respective real
   build/test evidence; iOS retains the macOS/Xcode boundary.
6. The checked-in City Fabric baseline contains an empty `projects` array. Adding
   a child is a separate, explicit owner-owned onboarding change; automation must
   not infer a child from a nearby folder or a historical source checkout.

## Alternatives considered

### Keep the user-home skill directory as canon

- Pros: smaller clone.
- Cons: a clean clone has an implicit external dependency and cannot audit the
  exact available gates.
- Decision: rejected.

### Register external absolute application paths

- Pros: no child folder in the infrastructure tree.
- Cons: binds tracked files to one machine and makes onboarding non-reproducible.
- Decision: rejected.

### Commit child repositories as submodules

- Pros: one visible checkout tree.
- Cons: couples unrelated histories and release cycles, and increases accidental
  secret/output inclusion risk.
- Decision: rejected.

## Consequences

- City Fabric is self-contained and can audit its own capabilities.
- The same gate can resolve the correct knowledge root from anywhere inside a
  registered child.
- The repository grows with curated skill packs; provenance and validation become
  first-class quality work.
- A child that is not in the registry deliberately does not exist to automation.

## Tests required

- Root discovery, child resolution, exact child-owned output derivation, output-version
  derivation and registry drift.
- Registry rejection of absolute/escaping app paths and duplicate/invalid keys.
- Local skill canon resolution, validation, deterministic index/mirror behavior,
  and no hard-coded user-home dependency.
- Machine-path scan that includes the registry but excludes ignored child code.

## Rollback plan

The change is additive. Remove `app_entry_root/`, the project resolver and its
commands, restore the previous canon setting, and delete generated mirrors. Child
application checkouts are never mutated by this rollback.
