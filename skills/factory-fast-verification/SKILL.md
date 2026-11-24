---
name: factory-fast-verification
description: Mandatory fast-verification procedure for every build, test, lint and coverage run in Software Factory repositories and their children (Rust, JVM/Gradle/Android, Python, Node, containers). Select only impacted work, skip proven work by content key, make each unit cheap, parallelise the remainder inside the machine queue, and never wait by polling. Use before running any check; target seconds for a re-check and 2–3 minutes for a first check. Только для инфры Software Factory (в корне: AGENTS.md с Factory City + cli/bin/infra.js).
---

## Область применения (ПРОВЕРИТЬ ПЕРВЫМ ДЕЛОМ)

Скилл — часть инфраструктуры **Multi-AI Software Factory**. Перед действием проверить в корне проекта:
`AGENTS.md` содержит `Factory City` и существует `cli/bin/infra.js`. Если нет — скилл неприменим, сообщить
одной строкой и продолжить обычным порядком. Для дочерних приложений (`app_entry_root/<key>/<key>-vN`, их
worktree) базой служит этот репозиторий: команды `infra` вызываются как `node <base>/cli/bin/infra.js`.

## When to Use

Every time an agent or the coordinator is about to compile, test, lint, measure coverage or start a test
database — in any language. The decision ADR is ADR-0021; this skill is its operating procedure.

## How It Works

Verification time is `Σ (changed ∧ unproven units) × unit cost ÷ parallelism + waiting`. Each factor has one
lever, identical for every language:

| Lever | Rule | How |
|---|---|---|
| 1. Skip proven work | memoize by content key (inputs → result) | `infra testcache cargo`; Node runner memo; Gradle build cache (cacheable test tasks); pytest-testmon; sccache for compilation |
| 2. Only impacted work | dependency-graph selection | `infra impacted --repo <dir> --base <branch>` → exact `-p` list / Gradle modules / Android source sets |
| 3. Cheap units | no extra processes, disks, links or cold starts | one test binary per crate, `rust-lld`, no dependency debug info, template databases, `infra testdb` (tmpfs, fsync off), warm Gradle daemon and configuration cache, pure JVM tests instead of Robolectric where possible, shared session fixtures |
| 4. Parallel remainder | up to the cores the queue grants | `cargo nextest`, Gradle `maxParallelForks` / JUnit 5 parallel, pytest-xdist `-n auto`, `node --test` concurrency |
| 5. No waiting | notifications, never polling | the machine queue; long jobs in the background with one completion notification |

### Procedure (mandatory order)

1. `infra impacted --repo <worktree> --base <base branch>` — decide the set. Shared inputs (manifests, lockfiles,
   migrations, query metadata) legitimately select everything; then lever 1 does the work.
2. Test database: use the project's shared fast server (durability off, data in a named volume; Player Center
   55444, Billing Center 55432, Worlio 55439 — the ports the repositories document). `infra testdb shared up
   --project pc|bc|worlio` makes sure it runs; `infra testdb shared db --project <p> --name <agent>` gives a
   private database and its URL; `shared drop` removes it at the end. Never start a container per agent.
   Queued builds compile `sqlx` macros offline against the branch's `.sqlx` metadata (`SQLX_OFFLINE=true`);
   `cargo sqlx prepare` runs with `INFRA_QUEUE_SQLX_ONLINE=1` and `DATABASE_URL` pointing at the agent's own
   database migrated from its branch (the shared `*_schema` databases follow `dev`, rebuilt by the repository's
   `tools/dev-schema.sh`).
2a. Disk: build outputs are caches. `infra clean all` (auto-run after queued jobs) removes idle target
   directories and incremental caches; never keep a private target directory after the work is merged.
3. Run through the queue, one queued job per dependent sequence:
   `node <base>/cli/bin/infra.js queue run --class build --label "<who>: <what>" -- bash -c '<a> && <b>'`.
   A job that takes under about a minute and little memory (lint, format check, one test file, `node --check`, a
   memoized or already proven runner) uses `--class quick`: its own pool of 2, no burst, it never waits behind a
   7-minute build (a quick job past 120 s is reported as an overrun, never killed; Gradle and Cargo stay `build`).
   `infra queue status` shows the free memory, the burst threshold and why the next job waits.
   - Rust: `infra testcache cargo --repo <worktree> --base <branch>` (nextest; records passes; a re-run skips
     every package whose digest already passed).
   - JVM/Android: `./gradlew <module>:<task> --max-workers=$INFRA_QUEUE_JOBS` with the daemon and build cache;
     shared Android sources on ONE flavor; never `--no-daemon`, never `--rerun-tasks` without a reason.
   - Python: `pytest --testmon -n auto` where the repo has adopted testmon/xdist; otherwise only the impacted
     test modules.
   - Node (base): `node scripts/run_node_tests.js` (memoized per file; coverage memoized per tree). Keys
     ignore the journals `docs/operations/` and `tasks/`, so memory/sprint updates re-run nothing; a test that
     reads every repository file must carry the marker `node-test-memo: whole-tree`.
4. Long job (may exceed ~9 minutes): start it with `run_in_background` and simply wait for the completion
   notification. Short job: foreground with a timeout of up to 590000 ms. Never pick a small timeout that pushes
   a long job into the background only to poll it.
5. Coordinator only: full suites, full coverage, contract, end-to-end and the full Android flavor matrix, once per
   integration, also through `testcache`/memoized runners so a re-run after a fix re-executes only what changed.
6. Measure: `infra queue stats` (slowest jobs), nextest slow-test report, `pytest --durations=20`,
   `gradlew --profile`; fix the top offenders first (Pareto).

### Forbidden (each happened on 2026-10-06 and cost hours)

- Foreground polling (`until grep …; do sleep …; done`, `while true; … sleep`) — blocked by `pretool_guard.py`.
- Waiting on a log with `tail -f/-F … | grep -m1` — it never exits after the match; blocked by `pretool_guard.py`.
- Whole-suite runs by implementing agents; cold full rebuilds in a fresh target directory per run.
- Builds or tests outside the queue; booting an emulator (coordinator only).
- `gradlew --stop`, killing cargo/rustc/java/node/adb you did not start, clearing shared caches.
- `grep -r` / reading `.secrets/` (blocked by `secrets_guard.py`); printing secret values.
- `du`/`find` over build target directories (orphaned walkers starved the disk and antivirus).
- Re-running a gate or suite whose inputs did not change (the caches answer instantly — trust them).
- Small command timeouts on long jobs (they move the job to the background and invite polling): choose
  background + notification up front.
- A private target directory or test-database container per agent (use the project's shared server; build
  outputs are cleaned by `infra clean`).
- Wall-clock budgets in unit tests (2026-11-09, Nonoku ShapesTest failed four times while other sessions built):
  measure the thread's own CPU time (`ThreadMXBean.currentThreadCpuTime`), take each case's best of several spread
  rounds, and allow the coverage agent's overhead when it is attached; never relax a budget to make it pass.
- Combining `--tests` filters with a coverage gate (`koverVerify`, `jacocoTestCoverageVerification`) in one run: the
  gate then counts only the filtered tests and fails; run the gate on its full suite in its own run. When a 100%
  line gate reports a line that runs, look for a line without instructions (a bare `while (true) {`, an unused
  companion getter) before writing a test.

### Tool speed and file editing (fast lane playbook)

Verification is only half of a lane: reading, searching and editing files, hooks and the queue cost as much. The
playbook for briefs (tool choice per task, `Read` with `offset`/`limit` around `rg -n` anchors, `Edit` for small exact
changes, one script file for multi-file edits written with `newline="\n"`, the checks that verify an edit, hook timings,
queue and Gradle findings, and the machine checklist for the owner) is in
[references/tooling-performance.md](references/tooling-performance.md). Put its Section 1 into every brief.

### Methodology basis (why these rules, and how to keep improving)

| Source | Principle | Our rule |
|---|---|---|
| Amdahl's / Gustafson's laws | parallel speed-up is bounded by the serial share and the cores | big gains come from skipping work (levers 1–2), not from more agents |
| Little's law `L = λ·W`; Kingman's formula | waiting grows explosively as utilisation nears 100 % | the queue admits by load: jobs start at once while the host has headroom (≥ 15 % idle CPU, ≥ 4 GiB free) up to half the cores, and wait only on a saturated host; keep work in progress small |
| Theory of Constraints (Goldratt, five focusing steps) | improve only the current bottleneck, then find the next | `infra queue stats` → fix the slowest job first, re-measure |
| Lean software development (Poppendieck: waiting, rework, partially done work, task switching) | remove waste, not effort | no polling, no re-running proven work, small finished slices, one owner per worktree |
| Bazel / Nx / Turborepo; Gradle build cache; sccache | hermetic, content-addressed actions are executed once | `testcache`, Node memo, Gradle cache, sccache, testmon — keys from content, never from paths or time |
| Google "Software Engineering at Google" (test sizes, TAP presubmit) | small hermetic tests; run the affected set on change, everything after merge | impacted tests for agents, full suites once by the coordinator |
| Pareto principle | a few tests cost most of the time | read slow-test reports (nextest, `--durations`, `--profile`) and fix the top ones |
| ISO/IEC 25010 (ГОСТ Р ИСО/МЭК 25010-2015) "performance efficiency": time behaviour, resource utilisation, capacity | speed is a quality characteristic with measures | every speed change reports before/after wall time and resources |
| ISO/IEC/IEEE 29119 (software testing) | risk-based test selection with documented coverage | impacted selection + coordinator full runs + coverage evidence |
| DORA metrics (lead time, deployment frequency, change failure rate, time to restore) | fast feedback without losing stability | seconds for re-checks, minutes for first checks, green before merge |

Host practices (Windows build host): Dev Drive (ReFS, trusted) holds build outputs, caches and worktrees through
junctions; Defender excludes build directories and the Git/Node runtimes; power mode "Best performance"; WSL2
memory capped with automatic reclaim; Docker disk compacted after large prunes; one in-memory test server per
project.

## Examples

- Agent changed `modules/messaging/service/src/repo.rs` in Player Center:
  `infra impacted` → `-p pc-mod-messaging -p player -p playerctl`; `infra testcache cargo --base dev` runs those
  three with nextest against `infra testdb`; the second run after a one-line fix re-runs only the packages whose
  digest changed.
- Worlio Android shared-source change: `./gradlew :app:testHuaweiDebugUnitTest --max-workers=$INFRA_QUEUE_JOBS`
  (one flavor); the coordinator runs all three flavors once at integration.
- Base CLI change: `node scripts/run_node_tests.js` re-runs only test files whose require closure changed plus
  repository-bound files; an unchanged tree finishes in about 2 seconds.
