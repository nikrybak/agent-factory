# City Fabric project registry and local skill canon

## Purpose and scope

This contract introduces a child-application address space without embedding product
source in Factory City. It also makes the procedural capability canon self-contained
in `skills/`. It implements ADR-0008, ADR-0018 and requirements `REQ-CF-001..004`,
`REQ-CF-008..009`.

The scope is infrastructure metadata and guidance only. It does not create a child,
copy an application, run a runtime, start a database, contact a provider, or grant
deployment authority.

## Child layout

```text
app_entry_root/
  README.md LAYOUT.md RESOLUTION.md OUTPUT.md   namespace documents (tracked by the base)
  _registry/
    registry.json        machine-readable source of keys, versions and market matrix
    REGISTRY.md          human guide
    _template/_project/  knowledge skeleton (with market/) for a new child
  <key>/                 child namespace owned by the base
    _project/            tracked knowledge: docs/, tasks/, skills/, market/<store>/<locale>/
    _output/
      <key>-<version>/   ignored output; market/<store>/<locale>/screenshots/ for captures
    <key>-<version>/     unchanged application repository of one version, e.g. worlio-v1/
```

The namespace documents, `_registry/**` and `<key>/_project/**` are tracked by this
repository. Each `<key>-<version>/` is an independent application repository with its
own history and rules; it is ignored and never made a submodule as a side effect of
registration. Factory commands for an application use the version directory as project
root, where its own `factory/` manifest lives.

Factory-wide tree hashing, stack detection, SBOM discovery and the Python quality
snapshot enforce the same boundary when and only when the registry marker exists:
they include `_registry/**` and `<key>/_project/**`, but prune every application
repository and `_output/` before traversal. This keeps a concurrent Unity/Gradle build
from changing or racing the infrastructure certificate while preserving child
knowledge and registry changes in the evidence digest.

## Resolver contract

`infra project resolve` searches upward for `AGENTS.md` containing `Factory City`
and `cli/bin/infra.js`. It returns:

| Field | Meaning |
|---|---|
| `scope` | `base`, `child`, or `unknown` |
| `baseRoot` | physical Factory City root |
| `key` | registered child key or `null` |
| `knowledgeRoot` | base root or child `_project/` root |
| `appRoot` | `app_entry_root/<key>/<key>-<version>/` for the selected version, or `null` |
| `outputRoot` | `app_entry_root/<key>/_output/<key>-<version>/`; `_output/<key>/` only without a declared version |
| `version`, `versions` | selected version id (`--version`, enclosing version directory, then `app.active`) and all declared ids |
| `marketRoot` | `_project/market/` — tracked listing texts per `<store>/<locale>/` |
| `marketOutputRoot` | `<outputRoot>/market/` — captures per `<store>/<locale>/screenshots/` |
| `market` | declared `stores`, shared BCP 47 `locales` and optional per-store `extraLocales`, or `null` |
| `runtime` | optional declarative AI/runtime profile; never credentials or an execution order |
| `inRegistry` | whether a child folder has a valid registry record |

`infra project resolve <key>`, `list`, `paths <key>`, `market <key> [--init]` and `scan` expose declared children, derived
paths and drift. A resolver must reject an absolute path, `..` traversal, duplicate
key, invalid key, missing active version, the retired `app.path`, a version path other
than `<key>-<id>`, or an invalid store/locale. The child root is closed: only
`_project/`, `_output/`, declared version directories, a declared sidecar and
dot-entries are accepted.
Every artifact producer must use the returned `outputRoot`; root-level `_output/`,
`app_entry_root/_output/` and loose artifacts in the child or its `_output/` parent
are layout drift and are never alternative output roots. `infra project scan` checks
this boundary without traversing or trusting artifact content.

## Registry ownership rules

- The registry owns identifiers, relative layout, version selection, capability packs
  and declarative runtime profile only.
- A deployment descriptor owns addresses, scopes and release metadata; a child
  knowledge document owns rationale; the application owns dependencies and code.
- `runtime.ai` may state a mode or allowed named capability packs. Every declared
  capability must resolve to a local skill directory or generated pack identifier
  in `skills/REGISTRY.json`; it cannot include token-like values, provider
  credentials, endpoints requiring a secret, or authority.
- A key is lowercase kebab case and matches its child directory exactly.

## Skill canon contract

`skills/` is the canonical local source. The file `skills/REGISTRY.json` records each
pack's source class, license/provenance pointer, immutable origin where known, digest
and intended scope. `agents.json` references `skills/` directly; `infra sync` mirrors
the canon to tool-specific ignored locations.

The retained source-specific provider packs are child-bound, not generic guidance:
their marker requires a resolved registered child to declare the matching capability
pack. The infrastructure baseline intentionally has an empty registry; no product
repository or child knowledge root is committed until its owner explicitly onboards
it with a relative layout.

Mobile packs are available on demand: Unity/UI Toolkit, Android architecture,
Kotlin/Ktor/Compose, Swift/SwiftUI and iOS, plus Prisma/data packs. Their presence
does not change manifest authority, install dependencies or relax native validation:
Android needs emulator/device evidence and iOS needs a real macOS/Xcode/simulator/device
lane when the product targets iOS.

## Security invariants

1. All resolver output is derived by `cli/lib/project.js`; callers cannot synthesize
   child paths.
2. The machine-path scanner checks registry and canon metadata but skips ignored child
   source/output trees.
3. Generated mirrors are never a canon and are ignored/rebuildable.
4. Skill source material is guidance, not executable authority. The relevant Factory
   policy, security and release gates still control every side effect.
5. Tree evidence, stack detection and SBOMs count canonical `skills/` but prune
   `.agents/skills` and `.claude/skills` only for a verified City Fabric base.
   A similarly named folder in an ordinary target repository remains visible.
