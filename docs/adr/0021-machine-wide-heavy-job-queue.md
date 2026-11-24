# ADR-0021: Machine-wide queue for heavy jobs

Date: 2026-10-06
Status: Accepted by owner decision, 2026-10-06

## Context

Parallel implementation agents each start their own Rust and Gradle builds in separate
worktrees. On an 8-core host six concurrent `cargo test` runs, two Gradle daemons and an idle
Android emulator kept the CPU at 100% for hours: every build was starved, agents waited on
notifications that arrived late, and nobody finished. Per-agent limits (`CARGO_BUILD_JOBS=2`)
do not help, because the total demand is still the number of agents times their jobs, and the
emulator is an exclusive resource that no agent should hold implicitly.

## Decision

1. `infra queue run --class <class> [--label TEXT] -- <argv...>` runs one heavy job through a
   single FIFO queue shared by every agent, worktree and repository on the host
   (`cli/lib/machine-queue.js`). The queue directory is `INFRA_QUEUE_DIR`, else `queue` inside the scratch root
   `DEV_TEMP` on the Dev Drive (ADR-0025; amended 2026-10-26, it used to be `~/.infra-queue` on the system drive);
   it holds no secrets, only labels, PIDs, argv and timestamps.
2. Classes and capacity:
   - `build` — compile, test, lint and coverage runs of any stack. Admission is by load, not by
     count: two jobs are guaranteed (`INFRA_QUEUE_BUILD_SLOTS`, default `min(2, cores / 2)`; with one,
     a lone job took every core and the next one never saw headroom, so the queue convoyed behind
     it), and further jobs up to
     the ceiling (`floor(cores / 2)`, override `INFRA_QUEUE_BUILD_BURST`) start as soon as the host
     shows headroom over a 2-second window — at least 15% idle CPU and 4 GiB free memory. Only a
     saturated host makes jobs wait, in arrival order, one opening at a time. Each job gets the
     cores divided by the jobs running at its start (`INFRA_QUEUE_JOBS`, `CARGO_BUILD_JOBS`; Gradle
     callers pass `--max-workers=$INFRA_QUEUE_JOBS`). History: the first rule was a fixed
     `floor(cores / 4)` slots plus bursts after 15 s at 50% idle; with six agents owners waited
     4597 s for 6326 s of work, because DB-bound tests and single-threaded phases rarely leave half
     the CPU idle that long. The owner's requirement (2026-10-07): the queue exists for overload,
     it must never create idle time. The ceiling still bounds memory and thermal load, the 15%
     floor stops a saturated CPU from being oversubscribed, the memory floor prevents paging.
   - `emulator` — one slot; Android emulator and device runs. Only the coordinator boots the
     emulator, after integration.
   - `quick` — added 2026-10-26, see the amendment below.
3. Tickets are files named by arrival time. The oldest waiters take free slots in order; a
   granted ticket keeps its slot until released. Holders and waiters heartbeat their ticket;
   any participant prunes tickets whose owner PID is gone or whose heartbeat is older than two
   minutes, so a killed agent never blocks the queue.
4. The queue spawns argv with `shell: false` and returns the child exit code. Pipelines and
   scripts are wrapped explicitly (`-- bash -c '...'`). Dependent steps (build then test, test
   then clippy) run as one queued job, not one job per step, so they do not re-enter the queue
   at its tail between steps.
5. Mandatory use: implementing agents run every heavy build or test through the queue, together
   with the impacted-tests contract (agents run only changed and dependent tests; the
   coordinator runs full suites once at integration). `infra queue status` shows running and
   waiting jobs.

## Consequences

- Total CPU demand is bounded by the host size instead of the number of agents; each running
  job gets more cores and finishes sooner, so wall-clock time drops even though jobs wait.
- Waiting is visible and ordered, which replaces ad-hoc process killing and polling.
- The queue is advisory: a process that bypasses it is not stopped. Agent briefs and
  `AGENTS.md` make its use mandatory.

## Verification speed package (owner decision, 2026-10-06 evening)

Checks took 20–30 minutes while the code took a fraction of that. Measured causes and the fixes:

1. **Base gate repeated work.** The certification `tests` step and `quality_gate.py` ran the same CLI suite,
   then a third coverage run followed, sequentially. `quality_gate.py` now reuses the selected run's `tests`
   evidence when it passed on exactly the current input (both identity digests equal) and runs the remaining
   suites (root Node tests, factory coverage, Python) concurrently.
2. **Gate invalidated by unrelated edits.** The PostToolUse audit removed the PASS flag after any edit, even in
   child repositories or agent worktrees that the base gate never certifies; it now removes it only for edits
   inside the certified base tree.
3. **Certification broken by the learning log.** The Stop hook appends `docs/operations/LEARNING_LOG.md` on
   every turn end; the file is a session journal, so both tree hashes (`cli/lib/factory/hash.js`,
   `scripts/quality_gate.py`) exclude it.
4. **Rust rebuilt per worktree.** Queued build jobs run with `CARGO_INCREMENTAL=0` (opt back in with
   `INFRA_QUEUE_INCREMENTAL=1`) so sccache also caches unchanged workspace crates across worktrees; the
   fast dev profile and `rust-lld` are active.
5. **Guessing the test set.** `infra impacted` derives the changed Cargo packages / Gradle modules from git and
   adds every workspace member that depends on them (shared manifests, lockfiles, migrations and query
   metadata select everything); it also reports which Android source sets changed.
6. **Slow test databases.** `infra testdb up|down|list` starts PostgreSQL 17 in tmpfs with `fsync`,
   `synchronous_commit` and `full_page_writes` off, labelled for clean removal.
7. **Polling agents.** Agents kept polling in foreground `until …; sleep` loops despite the rule, so
   `.claude/hooks/pretool_guard.py` now blocks foreground polling loops (the same loop in the background, which
   yields one completion notification, stays allowed).
8. **Re-running proven tests.** Parallelism on one host is bounded by its cores (Amdahl); large speed-ups
   come only from not repeating work whose result is known. `infra testcache cargo` memoizes test results
   per Cargo package: the digest covers the package files, the digests of its workspace dependencies, every
   non-documentation file outside package directories, the toolchain and the exact command; proven packages
   are skipped, the rest run in one invocation and are recorded only when it passes. Keys contain no paths,
   so worktrees share results. Gradle gets the same property from its build cache.
9. **Node suite memoization.** `scripts/run_node_tests.js` keys every test file by content: a file whose
   local `require` closure neither spawns processes nor locates repository files is keyed by that closure,
   any other file by the base tree hash; proven files are skipped (`INFRA_NODE_TEST_CACHE=0` forces a full
   run). Measured: 115 s → 2 s for an unchanged tree. A coverage run is always complete, but its report is
   memoized per exact tree state, so the second identical coverage command of a certification (CLI and root
   adapters) is instant, and a passing coverage run also marks every test file proven.
   The project-memory journals (`docs/operations/`, `tasks/`, exported as `JOURNAL_PATHS` from
   `cli/lib/factory/hash.js`) are only checked for existence — by `quality_gate.py` and the docs-parity
   provider — so repository-bound test files, the coverage report and `quality_gate.py`'s own factory
   coverage and Python suites are keyed by the tree hash without them (a recorded PASS is reused, a failure
   never is). A test that reads the text of every repository file declares `node-test-memo: whole-tree`
   and keeps the complete tree hash (today: `tests/repository-neutrality.test.js`). Certification identity
   is unchanged and still hashes the journals. Measured: a journal-only base gate dropped from ~5 min to the
   numbers recorded in `docs/operations/CHECKPOINTS.md` (33 of 65 Node test files and both quality-gate suites
   no longer re-run). A CPU profile of one certification step then showed 1.35 s of its ~3 s in the Unity
   project scan that precedes every tree hash: it walked local child repositories that the hash itself never
   reads. `hashTree` now passes its own exclusions to `findUnityProjectRoots` (`skip`), which leaves every hash
   value unchanged and cut one hash from 844 ms to 432 ms on the base (2.0 s → 0.7 s on the Worlio repository).
   `quality_gate.py` re-checks Node tests through the memoized runner instead of re-running root test files.
10. **Base gate scope.** The guard required the base PASS flag for every `git commit`, including commits into
   child repositories and agent worktrees, which the base gate never certifies; with `git -C <other repo>`
   the base flag is no longer required, and those repositories gate through their own coordinator full runs.
   The guard also inspects only the command text (it used to match words in the tool description).
11. **The endless journal diff.** The Stop hook `learning_capture.py` appended raw per-turn diff-stats to the
   tracked `docs/operations/LEARNING_LOG.md` (11 000+ lines, the "learned pattern" field almost never filled),
   which left a permanent pending change after every commit and broke certifications. The owner judged it
   noise: the hook (Claude and Codex copies), its registrations and the journal are removed; durable lessons
   are curated in role memory, `docs/operations/MEMORY.md`, ADRs and `AGENTS.md`.
13. **Idle cores.** A cargo timings report of a lone Billing Center build showed 1683 unit-seconds in 437 s
   (parallelism about 3.9 of 8 threads): the queue gave every job `cores / slots` jobs even when it ran alone.
   A granted build job now gets `cores / running jobs`. The same report showed where the time goes: our test
   binaries 40 %, dependencies 36 % (cacheable), our libraries 15 %; and that sccache missed every crate across
   worktrees because the repositories export `CARGO_TARGET_DIR`, which sccache hashes — the host's
   `rustc-wrapper` shim strips it before calling sccache. The tree hashes still
   ignore that path, so an old checkout's journal cannot break a certification.
12. **Evidence.** `infra queue stats` reports per-owner run/wait totals and the slowest jobs from the queue
   history, so further tuning follows data.

Repository-level follow-ups (per child, measured): one integration-test binary per crate and nextest
configuration; template databases for per-test migrations; Gradle `maxParallelForks` and configuration cache.

## Shared test servers and disk hygiene (owner decision, 2026-10-06 night)

Measured on the owner's host: about 1.1 TB of the build drive was Rust build output — one 25–70 GB target
directory per agent and per old Billing Center slice, never removed, built with full dependency debug info and
incremental caches — while all source code took under 10 GB. Docker held 118 GB, partly orphaned caches.

1. **One test database server per project.** `infra testdb shared up|db|drop|down --project pc|bc|worlio` keeps
   one in-memory PostgreSQL 17 (tmpfs, durability off, `--restart unless-stopped`) per project on the port and
   credentials that project already documents (Player Center 55444, Billing Center 55432, Worlio 55439), so the
   repositories' scripts work unchanged. Harnesses create per-test databases on it; an agent gets a private
   database with `shared db --name <agent>`. No container per agent, no orphaned volumes. The servers keep
   their data in named volumes (durability still off) so the schema-only databases used by `sqlx`
   compile-time checks survive restarts; queued builds compile those macros offline against each branch's
   `.sqlx` metadata (`SQLX_OFFLINE=true`), since one shared schema cannot match every branch.
2. **Automatic disk hygiene.** `infra clean targets|docker|all` removes build directories untouched for
   `idleHours` (default 48) and drops `incremental` caches elsewhere (queued builds are non-incremental), never a
   directory written in the last 15 minutes; Docker loses build cache older than a day, dangling images and
   stopped one-off test databases — volumes of other projects are never touched. The roots live in the local
   machine config `~/.infra-cache/clean.json`; the queue launches a detached clean after jobs at most once per
   `intervalHours` (default 6).
3. **Smaller outputs at the source.** The fast dev profile (no dependency debug info, line tables for workspace
   crates), non-incremental queued builds, one integration-test binary per crate and one target directory per
   active worktree keep a workspace's output to a few gigabytes without losing test fidelity or panic locations.

## Build host layout (owner decision, 2026-10-06 night)

- A 500 GB Dev Drive (ReFS, trusted) holds every hot write path; the old paths on the build drive stay valid
  through junctions: `dev/runtimes/tmp`, `dev/runtimes/rust/target`, `dev/runtimes/sccache-cache`,
  `dev/runtimes/gradle` and `dev/worktrees`. Measured before the
  move: 1.1 TB of the build drive was stale per-agent build output (all source code: under 10 GB).
- WSL2 (Docker Desktop) is capped at 10 GB with gradual memory reclaim and sparse virtual disks; the Docker data
  disk is compacted after large prunes.
- WSL2 as a build environment was rejected by the owner (an extra layer); builds stay native on Windows.
- The methodology behind every rule (Amdahl, Little/Kingman, Theory of Constraints, Lean, content-addressed
  build systems, ISO/IEC 25010 and 29119, DORA) is recorded in `skills/factory-fast-verification/SKILL.md`.

## Host build caches (owner decision, 2026-10-06)

Bounding concurrency is half of the fix; the other half is not compiling the same thing twice.
These are host settings outside any repository, so they apply to every project and agent:

- Rust: `sccache` (official Mozilla release, SHA-256 verified) is the `rustc-wrapper` in the
  shared `CARGO_HOME/config.toml`, with a 30 GB disk cache on the build drive. Identical
  dependency compilations in different worktrees and target directories hit the cache.
- Gradle: `GRADLE_USER_HOME/gradle.properties` enables the local build cache for every project
  and stops idle daemons after 15 minutes; projects keep their own JVM and parallelism settings.
- Planned after the current integration (each invalidates fingerprints once, so they are applied
  between agent batches, not during one): no debug info for dependencies in the dev profile, and
  the `rust-lld` linker for the MSVC target, both measured before being kept.
- Antivirus exclusions for build directories are a host security setting; only the owner applies
  them, from evidence (`New-MpPerformanceRecording` + `Get-MpPerformanceReport`), never by guess.
  Applied 2026-10-06 on the build drive: the Rust and Gradle homes, the compile cache, the build
  temp directory, agent worktrees, and the Git and Node runtimes whose executables every agent
  launches hundreds of times. Defender scan time fell from about 50 s to about 12 s per minute
  of build load.

## Queue speed, the quick class and state off the system drive (owner decision, 2026-10-26)

Measured by lane TOOL-PERF on 2026-10-25 (8 cores, 31.8 GiB): the queue added about 250 ms to a job, but the
583 build jobs of one day waited a median of 29 s and p90 399 s (287 of them more than 30 s), a quarter of all
machine time was waiting, and the state lived in a folder on the system drive. Causes: a burst slot needs 4 GiB
free and the host rarely had it; short jobs (memoized tests, lint, one test file) stood in the same FIFO as
7-minute Gradle builds; a freed slot was noticed up to 1 s late, and a burst that memory had refused restarted a
whole 2 s observation window.

1. **State on the Dev Drive.** `queueRoot` is `INFRA_QUEUE_DIR`, else `queue` in `DEV_TEMP`, else (neither set)
   the old home folder. The junk sweeper (ADR-0025) only ever touches `jobs/` and `os/` of the scratch root, so
   the queue folder and its `history.jsonl` are never swept.
2. **Migration without stopping the queue.** Processes started before the switch keep their tickets in the old
   folder and never look at the new one. Every new participant therefore also reads the old folder (read-only: it
   never writes, prunes or deletes there; dead tickets are skipped) and merges its live tickets by arrival time, so
   old holders count as held slots, old waiters keep their place in the order, and `status`/`stats` show both. The
   reading stops mattering by itself when the old tickets are gone; no flag day, no data copy. The one thing a new
   process cannot fix is that old processes ignore new tickets, so while both generations are alive the old side
   may take a slot the new side also holds: a temporary overshoot of at most the ceiling, ending when the last old
   job exits. An explicit `INFRA_QUEUE_DIR` means a private queue (tests, sandboxes) and reads no old folder unless
   `INFRA_QUEUE_LEGACY_DIR` names one (empty disables the reading).
3. **Event-driven hand-over.** A waiter watches its class directory (and the old one) and wakes on any change
   after 15 ms; the poll interval is 250 ms instead of 1 s and only the safety net (a directory that cannot be
   watched falls back to it). Measured with default settings, release to grant: median 503 ms (47-724) before,
   67 ms (3-129) after.
4. **A rolling burst gate.** Free memory is read at every wake and the idle CPU is a time-weighted mean over the
   last 2 s window that is reset only when the number of running jobs changes; a burst that memory had refused is
   granted at the next wake after memory is free, not after a fresh window. The 4 GiB floor, the 15 % idle floor
   and the 2 s window are unchanged; `INFRA_QUEUE_BURST_MIN_FREE_GB` tunes the floor per invocation.
5. **The `quick` class.** `infra queue run --class quick -- <argv>` for jobs under about a minute and little
   memory: lint, format check, a single test file, `node --check`, a memoized runner whose files are proven. Own
   directory and pool: 2 slots (`INFRA_QUEUE_QUICK_SLOTS`, hard-capped at half the cores), no burst, no memory gate,
   `INFRA_QUEUE_JOBS` = cores / (2 x slots). It cannot starve builds: at most 2 jobs of 2 workers each run beside
   them, and a quick job still running after 120 s logs an overrun, is recorded (`overran` in the history, counted per
   owner by `stats`) and keeps running - the owner of the label sees it and moves that job to `build`. Gradle,
   Cargo and anything that needs gigabytes stay `build`.
6. **`queue status` shows the gate.** First line: free memory, the threshold, the measured idle CPU (sampled for
   250 ms, and only when somebody waits). Under each class with a waiter: `next "<label>" waits - memory: 2.1 GiB free,
   a burst slot needs 4.0 GiB` (or the CPU share, or the ceiling). The waiting job prints the same reason, once per
   change and at most every 5 s, instead of only its position. `status --json` carries `host` and `gates`.
7. **CLI start.** `infra queue ...` no longer loads the other 40 modules of the CLI first (about 100 ms per job);
   `cli/bin/infra.js` hands `queue` to the queue module before its other requires.

Consequences: the overhead over a bare process run falls by about a third and the hand-over from seconds to tens
of milliseconds; the memory-bound waits of long builds remain (they need free RAM, see the tooling-performance
playbook), but short jobs no longer join them and a waiter sees why it waits. A new class means a new directory
under the queue folder; old clients that do not know `quick` simply never use it.

## Trace-keyed test memo and the fast base gate (owner decisions, 2026-10-29 and 2026-10-30)

The owner asked for a base quality gate of about 5 s. Before: node tests 218 s, coverage 192 s, Python 171 s and
certify 54 s, run one after another on every call.

1. **Per-file memo keyed by what a test read.** `scripts/run_node_tests.js` and `scripts/run_python_tests.js` run
   every test file on its own under a read tracer (`cli/lib/test-trace-preload.js` for Node and its Node children,
   `cli/lib/pytrace/sitecustomize.py` for Python). A pass is stored with a fingerprint of each path the run read
   (file content, directory listing, subtree, absent path) and reused only while all of them are unchanged; paths
   the run created itself are outputs. A run the tracer cannot follow (a program other than Node or Python started
   in the repository, `fs.glob`) or a file marked `node-test-memo: whole-tree` is keyed by the code tree (the tree
   without `docs/operations` and `tasks`) or the whole tree. A watch is a read of the watched path; a program that
   never started (ENOENT) read nothing. A run whose inputs changed while it ran, or that rewrote an input, is not
   stored. Up to 6 variants per file; failing files never stop the passes of the others from being stored.
2. **Fast keys, byte-exact identity.** File digests come from a size+mtime cache (`cli/lib/file-hash-cache.js`, under
   `INFRA_CACHE_DIR` or `~/.infra-cache`); an entry written within 2 s of the save is never trusted. The
   certification identity keeps its byte digest: `hashTree` remembers it under the fast key of the same walk and
   walks the bytes only when that key is new (`INFRA_TREE_HASH_CACHE=0` always walks the bytes). Unity roots are
   found inside the same walk under the finder's own rules, and tool state (`.factory`, `.claude/state`,
   `.claude/worktrees`) is no project source for the digest, stack detection or the SBOM.
3. **Coverage per file.** Each coverage test file runs under coverage in its own process; its LCOV is memoized like a
   pass and the table is merged by `cli/lib/lcov.js` in Node's layout, so the gate reads the same `all files` row.
   Lines and functions equal one combined run; V8 reports branch blocks per execution and LCOV keeps no offsets, so
   the merged branch share differs (88.41 against 89.62 % on the same 66 files on 2026-10-30, lower).
4. **Parallel gate.** `scripts/quality_gate.py` computes the identity and selects the run (`engine.selectedRunId`)
   at once, then runs the node, coverage and Python suites and Factory City certification side by side; the final
   identity comparison still catches any job that wrote into the certification input.

Measured on a clean tree on 2026-10-30 (8 cores): a gate with nothing changed 3.5 s (node 1.2, coverage 0.5,
Python 1.1, certify 2.4, identity 0.8); after a README edit about 26 s (the tests keyed by the tree run again);
after an edit of a widely read `cli/lib` module about 100 s (the tests that read it run again, twice: plain and
under coverage). A run that must not trust the memo sets `INFRA_NODE_TEST_CACHE=0`: everything runs and nothing is
stored.
