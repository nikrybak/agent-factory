# ADR-0018: Versioned application repositories and store-listing layout

Date: 2026-10-03
Status: Accepted — refines ADR-0008 decision 3 (the application checkout is a declared version directory)

## Context

ADR-0008 made `app_entry_root/<key>/` the namespace for a child, tracked the child's
`_project/` knowledge in the base and kept the application checkout beside it under a
free-form registry path (`app.path`). For Worlio the application repository had been
cloned directly into the child root, so its own files, `.git` and the base's knowledge
root occupied the same directory: the base could not track `_project/` (Git does not add
files inside a nested repository) and showed the whole child as untracked.

Two further needs had no place:

1. A major product line needs isolated code, history and output (v1, v2…).
2. Store publication needs per-store, per-language listing texts and screenshots
   (Worlio: 2 stores × 17 locales).

## Decision

1. The child root belongs to the base and has a closed shape: `_project/` (knowledge,
   tracked by the base), `_output/` (ignored output), one `<key>-<version>/` directory
   per registered application version, an optional declared sidecar and local
   dot-entries. Anything else is layout drift.
2. Each `<key>-<version>/` is a complete, unchanged application repository with its own
   Git history and rules. The base ignores it and never rewrites its layout. Factory City
   commands for the application use the version directory as their project root.
3. `app.versions[]` and `app.active` are mandatory when `app` is declared. A version id is
   `v<number>` with an optional safe suffix; the directory is always `<key>-<id>`. The
   legacy `app.path` is rejected with a migration message.
4. Output is version-scoped: `_output/<key>-<version>/`; only a child without a declared
   version uses `_output/<key>/`.
5. An optional `market` declaration (`stores`, BCP 47 `locales`) derives
   `_project/market/<store>/<locale>/` for tracked listing texts and
   `_output/<key>-<version>/market/<store>/<locale>/screenshots/` for captures.
   `infra project market <key> [--version] [--init]` exposes the matrix and creates only
   missing directories; `scan` reports missing listing directories.
6. A working directory inside `<key>-<version>/` selects that version during
   path-derived resolution; explicit `--version` and `app.active` keep their precedence.

## Alternatives considered

### Make the child root itself the application repository

- Pros: one repository holds knowledge and code.
- Cons: forces a layout change on the application repository (code into a subfolder,
  every CI/test path rewritten), mixes infra knowledge into product history, and leaves
  no room for a second major line with independent history.
- Decision: rejected after a local trial that was discarded.

### Free-form version directory names

- Pros: no rename of existing checkouts.
- Cons: names drift from keys; tools guess; output cannot be matched to a version.
- Decision: rejected; the name is derived.

### Put screenshots in `_project/market/`

- Pros: text and images together.
- Cons: binary, version-specific, regenerated output in tracked knowledge.
- Decision: rejected; captures are version output.

## Consequences

- Every child path, including store material, derives from key + version.
- Application repositories stay byte-identical to their remotes; moving a clone into
  `<key>-vN/` is the whole onboarding step for its code.
- The base tracks and hashes `_project/` knowledge (ADR-0008 boundary unchanged) and
  ignores application repositories and output.
- Product engineering docs live in the application repository; `_project/` links to them.

## Tests required

- Version directory derivation, `app.path` rejection, version id and active validation,
  reserved sidecar names.
- Market validation (stores, BCP 47 locales, duplicates), matrix expansion, idempotent
  non-overwriting init, link-escape refusal.
- Closed child-root scan and version-scoped output names; version selection from a
  working directory.
- Base hashing/SBOM/detection include `_project/` and exclude version repositories.
