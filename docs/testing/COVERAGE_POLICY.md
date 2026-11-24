# Coverage Policy

Default threshold: 100% for changed/new modules.

The executable factory gate reads `quality.changedCoverage` from
`factory/project.json`; the current self-hosted minimum is 80%. Environment overrides
may tighten but never lower that threshold. A global threshold is not a substitute
for behavior-focused tests on every changed module.

If full global coverage is not possible yet, the project must maintain:

1. 100% coverage for new modules.
2. No coverage regression for existing modules.
3. A documented backlog item for legacy uncovered code.
4. A risk entry in `docs/operations/RISK_REGISTER.md`.

`ledger-store.js` and `redaction.js` are security-critical new modules and require 100% changed-module
statement, branch, function, and line coverage. Changes to `ledger.js`, `city.js`, `runner.js`,
`evidence.js`, `evidence-providers.js`, `stage-providers.js`, `output.js`, and the CLI entrypoint
require focused unit/integration coverage for every new branch plus concurrent-process and
canary-leak regressions. Browser and mobile E2E are N/A for this infrastructure-only slice.

`filesystem-boundary.js` and `catalog-loader.js` are security-critical leaf modules and require
100% statements, branches, functions and lines. Changes to binding, evidence, runner, store,
engine, City, stage providers and the CLI require focused parity, static-junction and real-process
run-lock regressions. Full descriptor-relative mutation/spawn assurance remains a separate P2 and
must not be marked covered by opened-object/static-alias tests.

`toolchain-trust.js` is a security-critical new leaf module and requires 100% statements,
branches, functions and lines. Its schema and consumers require focused coverage for exact
process anchors, operator-confirmed digest/CAS enrollment, absence/no-TOFU behavior, PATH without
authority, overlay byte/object drift, native-format/wrapper denial, fixed path-free errors,
plan/freshness/pre+post runtime/receipt parity and `EVIDENCE_TOOLCHAIN_UNAUTHORIZED`. Coverage of
these cooperative checks does not cover descriptor-relative spawn or same-principal ABA; that
remains `FC-FILESYSTEM-FENCE-P2`.

Component-owned v1.1 changes require direct branch evidence in manifest, detection, adapters,
evidence providers, evidence assessment, runner, and engine. Required cases are build-root/module
ownership, same-root multi-family preservation, exact component/adapter identity,
duplicate-family ambiguity, unique-candidate compatibility, argv XOR ordered commands, shell
denial, exact operation selectors, justified adapter-declared N/A, support/N/A conflict,
all-command success, child failure, target/command aggregate tamper, and v1.0 readability without
current-binding acceptance. The Worlio integration fixture must assert exactly five components,
Docker coverage N/A, and Unity security N/A. Local CLI/file coverage does not satisfy physical
tool enrollment, mobile/browser E2E, release provenance, or external authority.
