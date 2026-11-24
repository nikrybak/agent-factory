# ADR-0024: Shared packages directory under app_entry_root

Date: 2026-10-09
Status: Accepted by owner decision, 2026-10-09

## Context

`app_entry_root/` holds only registered child applications (ADR-0008, ADR-0018): a key-named
root with tracked `_project/` knowledge, ignored `_output/` and one independent repository per
version. Reusable code that several children link against has no place in that shape: it is not an
application, has no store listing or version line of its own, and must not be copied into each
child. The first case is `nrg-shield`, an offline on-device anti-tamper and anti-cheat library
(a Rust core with a thin Kotlin/AAR adapter) in its own private repository,
`https://github.com/NR-Games/nrg-shield`, used by every offline game.

## Decision

1. **A reserved directory `app_entry_root/packages/<name>/`** holds shared packages. `packages`
   is a reserved non-child entry next to `_registry/` and `_global-info/`; it cannot be a
   registry key (the registry rejects it) and is never reported by `infra project scan` as an
   unregistered child.
2. **Each package is its own independent Git repository**, ignored by the base exactly like
   `<key>-<version>/`. The base tracks only `app_entry_root/packages/README.md` (the index, the
   clone instructions and the rules). Packages have their own `LICENSE`, history and semver tags.
3. **Resolution**: `resolveProject` from a working directory inside `packages/<name>/` returns
   scope `package` with `packageName` and `packageRoot`; `key`, `outputRoot` and `appRoot` are
   null and `knowledgeRoot` is the package root (a package keeps its own documentation). A
   working directory in `packages/` itself returns scope `package` with no name. The name is the
   constant `PACKAGES_DIR` in `cli/lib/project.js`.
4. **Consumption**: a child depends on a tagged, prebuilt artifact (AAR or crate) or on a Gradle
   composite (included) build that points at the checkout. Sources are never copied into a child.
5. **A package holds no secrets and no child-specific configuration.** Keys, endpoints,
   thresholds and store identifiers belong to the child and are supplied at build or run time.
6. Packages carry no registry record, `_project/` or `_output/` in this ADR. If a package later
   needs base-tracked knowledge or a catalogue, that is a new decision.

## Consequences

- `cli/lib/project.js` gains `PACKAGES_DIR`, `assertChildKey` and a `package` scope; callers that
  only distinguish `child` from everything else (engine, identity) treat it as non-child.
- `.gitignore`, `app_entry_root/LAYOUT.md` and `app_entry_root/README.md` document the new
  entry; only `packages/README.md` is tracked there.
- Children upgrade a package by changing the pinned tag, which keeps a change to the library
  reviewable in one place.
- A child key named `packages` is no longer possible.
