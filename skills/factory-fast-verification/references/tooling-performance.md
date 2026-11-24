# Tooling performance: hooks, editing, queue, Gradle, the machine

Lane TOOL-PERF, 2026-10-25. Companion of the skill `factory-fast-verification`; decision record ADR-0027.
Host: Windows 11, 8 cores, 31.8 GiB RAM, Dev Drive `V:` (ReFS), repository and runtimes on `W:` (NTFS).
Every number is a median of interleaved runs on a host that was never quiet (8 to 100 % CPU from other lanes),
so the ratios matter more than the absolute values.

## 1. Fast lane playbook (put this in every brief)

Tool choice per task:

| Task | Use | Not |
|---|---|---|
| Find where something is | `rg -n "<anchor>" <dir>` (honours `.gitignore`), `git grep -n` | `grep -r`, `find -exec cat`, reading whole docs to look for one fact |
| Read part of a file | `Read` with `offset` and `limit` around the `rg -n` hit | `Read` of a 3000-line file, or reading it again after your own edit |
| One exact change in one file | `Edit` (exact `old_string`, include one distinctive neighbouring line) | a Python heredoc |
| New file, or a full rewrite | `Write` | `cat > file <<EOF` |
| The same mechanical change in 10+ files | ONE script in a file with `# mass-edit: <reason>` (Section 3), dry-run first, then apply | N Edits, sed one-liners with `\` in them, `python -c`/`node -e` that writes files (blocked) |
| A secret value (token, password, key) | `node scripts/secret.js keys\|check\|run` (ADR-0028) | `cat`/`Read`/`rg` on the store, `echo $TOKEN`, `env` (blocked) |
| Text that mentions a blocked pattern (the secret folder name, destructive git commands) | `Edit`/`Write` (document text is not inspected) | a Bash heredoc: `secrets_guard`/`pretool_guard` inspect the whole command and block it |
| Tests | `infra impacted`, then only those, through `infra queue run --class build`; for the game `-Pmahjong.testForks=3` on a big package | whole suites, coverage, all flavors (coordinator, once, at merge) |
| Long job | `run_in_background`, then wait for the notification | `until …; sleep`, `tail -f … \| grep`, small timeouts that push a job to the background so you can poll it |
| Merge `strings.csv` / resource tables | one agent owns the file per wave; others send rows to the owner, or append only in a lane file merged by the coordinator | many lanes editing the same table in parallel (conflict, then re-run of the generator) |

Rules of thumb:

1. Read once, with a window. Do not re-read a file you just edited; `Edit`/`Write` fail loudly when they do not apply.
2. Check the line endings before a script rewrites a file: `rg -c "\r$" <file>` (non-zero means CRLF). Keep the file's style.
3. A check that already passed on this tree is not run again (`testcache`, Node memo, Gradle build cache: seconds).
4. Wait on notifications, never on polling. Never `sleep` in the foreground.
5. Scratch only under `V:\dev\tmp` (`junk.js new`, then `junk.js done`).
6. Hooks cost about 0.1-0.2 s per call now (Section 4); do not batch calls to avoid them, batch them to avoid round trips:
   independent calls (reads, `rg`, `git`) go into ONE message.

## 2. File editing standard

When to use what:

- `Edit` for small exact changes; `Write` for new files and full rewrites. They need no shell, keep your encoding,
  are not subject to shell quoting and are checked by the harness.
- A script (Python or Node) only for ONE mechanical change across 10+ files. Write the script to a FILE
  (`Write` into your job folder) with the marker line `# mass-edit: <reason>` (`// mass-edit: <reason>` in Node), run
  it, delete it with `junk.js done`. Do not pass it through a heredoc or `-c "…"`:
  on this host the Bash tool consumes one level of backslashes (`"\\u"` arrived as `"\u"` and broke the script; `C:\temp`
  lost its backslashes). A file has no quoting layer.
- Enforced (owner order 2026-10-26, ADR-0028 "Edits", `edit_rules.js`): the PreToolUse guard blocks inline interpreter
  code that writes files (`python -c`, `python - <<`, `node -e`, a heredoc into python/node/perl/ruby with `open(…,'w')`,
  `.write(`, `write_text`, `writeFileSync`...; `perl -i`), a PowerShell read-replace-write (`Get-Content`/`-replace` with
  `Set-Content`/`Out-File`, or either writer on an existing file of a Git work tree), a heredoc redirected into an
  existing file of a Git work tree, and a new or run `.py/.js/.ps1/...` script outside any Git work tree that reads,
  replaces and writes files without the `mass-edit:` marker. Scripts inside a Git work tree (generators, build scripts,
  tests) are reviewed with the diff and run as before; reading or printing in inline code stays allowed.
- Large files: `rg -n "<anchor>" file`, then `Read` with `offset`/`limit` (30-80 lines), then `Edit` on text you saw.
  Never `Read` an entire large file to change one line.

Line endings and encoding:

- Git normalizes text to LF (`.gitattributes`: `* text=auto eol=lf`, plus binary rules; `.editorconfig` states the same
  for editors). The tracked content is LF whatever the working tree holds. `core.autocrlf=true` on this host is overridden
  by the attribute.
- Python on Windows writes `\n` as CRLF unless told otherwise; git then warns "CRLF will be replaced by LF". Always:
  `open(path, "w", encoding="utf-8", newline="\n")`, and read with `newline=""` when you must keep what is there:
  `open(path, encoding="utf-8", newline="")`. Node: `fs.writeFileSync(path, text)` writes exactly the string; build
  the string with `\n`.
- `Edit` keeps a CRLF file CRLF (tested: a multi-line `old_string` written with LF matched a CRLF file and the endings
  survived); `Write` writes exactly what you give it, so a full rewrite of a CRLF file stores LF. 765 tracked files of
  the main checkout (688 CRLF, 77 mixed; 686 of them under `skills/`) have CRLF in the working tree today although
  `.gitattributes` says `eol=lf` (written by tools after checkout, not by Git; a fresh worktree has LF everywhere); Git stores them as LF either way.
- Do not mix: an existing CRLF file stays CRLF (write with `newline="\r\n"`) unless the task is to normalize it.
  Do not renormalize a whole tree (`git add --renormalize .`, mass `dos2unix`): the diff is huge and hides the change.

Escaping pitfalls:

- In a JS regex literal `\n` is a newline matcher, in a JS string `'\\n'` is the two characters backslash-n. Writing a
  pattern through Python/bash turns `\\n` into `\n` into a real newline. When a pattern contains a backslash, put it in
  a file, not in a command line.
- Bash heredoc `<<'EOF'` stops `$` expansion only; it does not protect against the tool layer or against the guards
  (a heredoc that merely mentions a blocked command is blocked).
- Windows paths in commands: forward slashes (`W:/code/...`); inside JSON strings every backslash is doubled.
- Regex in `Edit.old_string` is not a regex; it is literal text. Whitespace and tabs must match exactly.

Verify every edit with the cheapest check that parses it (seconds, before any build):

| File | Check |
|---|---|
| `.js`, `.mjs` | `node --check <file>` |
| `.json` | `node -e "JSON.parse(require('fs').readFileSync('<file>','utf8'))"` |
| `.py` | `python -I -m py_compile <file>` |
| `.kt`, `.kts` | the module's compile task, or `kotlinc -script` for a single script; at minimum `git diff --check` |
| `.xml` (resources) | `python -I -c "import xml.dom.minidom,sys;xml.dom.minidom.parse(sys.argv[1])" <file>` |
| `.csv` tables | the repo's own check (`UNTRANSLATED`/column count), never by eye |
| any | `git diff --stat` (is the change as small as intended?) and `git diff --check` (whitespace, conflict markers) |

## 3. Script template for a multi-file mechanical edit

```python
# mass-edit: rename OldName to NewName in every Kotlin file of app/src (one change, many files)
import pathlib, sys
dry = "--apply" not in sys.argv
changed = 0
for path in pathlib.Path("app/src").rglob("*.kt"):
    old = path.read_text(encoding="utf-8")            # universal newlines: CRLF arrives as \n
    new = old.replace("OldName", "NewName")
    if new != old:
        changed += 1
        print(path)
        if not dry:
            path.write_text(new, encoding="utf-8", newline="\n")   # explicit LF
print(changed, "file(s)", "(dry run)" if dry else "written")
```

(`Path.write_text(newline=...)` exists since Python 3.10.) Run it once without `--apply`, read the list, then with it.
Check `rg -c "\r$"` first when files may be CRLF; if they are, read and write with `newline=""` instead.

## 4. Hooks: measurement, causes, change

Hook command wall time as the harness runs it (`bash -c <hook command>` with a realistic payload; 25-30 interleaved
runs; milliseconds; "floor" is `bash -c true`, the shell start every hook pays):

| Event / tool | Before: median / p90 | After: median / p90 | Change | Processes before -> after |
|---|---|---|---|---|
| PreToolUse Read, Grep, Glob | 599 / 708 | 381 / 504 | -36 % | 1 -> 1 |
| PreToolUse Bash | 641 / 909 (two hooks in parallel; the slower one) | 358 / 570 | -44 % | 2 -> 1 |
| PreToolUse Edit, Write (+ owner drive guard, node, 418 / 518) | 603 / 812 | 381 / 607 | -37 % | 1 (+1) -> 1 (+1) |
| PostToolUse Edit, Write | 645 / 801 | 361 / 505 | -44 % | 1 -> 1 |
| UserPromptSubmit | 612 / 738 | 371 / 483 | -39 % | 1 -> 1 |
| Stop | 616 / 748 | 355 / 548 | -42 % | 1 -> 1 |
| Floor (`bash -c true`) | 141 / 214 | 141 / 214 | | |

A quieter second run (floor 100 ms) gave 488 -> 299 (Read), 531 -> 349 (Bash), 532 -> 297 (post), i.e. the hook's own
share (above the floor) fell from about 400 ms to about 200 ms. A full Edit (pre + post) went from about 1.25 s to
about 0.74 s in the busier run. Under the heavy build load of the original measurement (a bare shell start 400 ms) the
absolute saving per call is larger: the shim and `import json` cost CPU time, which a loaded host does not have.

Bare interpreters (15 runs, same host): `python` shim 866 median / 1500 p90 (min 391); real `python.exe` direct
222 / 499; with `-I` 131 / 258; with `-I -S` 136 / 206; `node -e 0` 164 / 294 under load and 80 / 116 quiet. Python
imports on top of an empty start (interleaved, 20 runs): `import json` +149 ms, `import re` +145 ms, `json, re,
pathlib, shlex` +229 ms, the C module `_json` +3 ms. A direct `python.exe -I -S` dispatcher with a no-import fast path
measured about 100 ms faster than Node under load, but it needs the interpreter's machine path in a tracked file, which
`infra validate` forbids and which would switch the guards off silently on another host; Node comes from PATH.
Moving a copy of the Python tree from `W:` to `V:` showed no significant difference (noise was larger than the effect).

Root causes (each measured):

1. The PyManager shim `python` costs 390-530 ms per start (866 ms median under load); the real interpreter started
   directly costs 70-130 ms. Three hooks per Bash call paid the shim three times.
2. `import json` costs 100-150 ms on this host because it imports `re`, `enum`, `functools`, `collections`, `types` and
   about fifteen more files (each file open goes through Defender). `pathlib` and `shlex` add about 80 ms. The guards
   needed all of them on every call, although a blocking pattern needs a literal fragment (the secret folder name,
   `grep`, `-rf`, `commit`...) that almost no call contains.
3. `PreToolUse *` ran the secrets guard for tools that carry no path (Agent, Task, Todo, Cron...).
4. Each hook is a separate process: a Bash call started two Pythons plus the shell wrapper (the shell itself is
   about 100 ms, unavoidable).
5. The SessionEnd/`done` `junk.js sweep --auto` walked the whole scratch root (9.3 GB on 2026-10-25) to compare its
   size with 1 GB although no marked item could be deleted: 4.5-15 s each time.

Change (ADR-0027, approved by the owner 2026-10-26): `.claude/hooks/dispatch.js` serves each event in ONE Node process started from PATH (no shim, no
machine path, valid in cmd and Git Bash, entering `CLAUDE_PROJECT_DIR` first). It ports the patterns of the Python
guards with a Python-compatible regex builder, compiles regexes only when a call contains a fragment a blocking pattern
needs; the PreToolUse matcher stays `*` (no tool can bypass the guards). The Python guards and their tests stay as the
reference implementation. Proof: `tests/test_hook_dispatch.py` compares verdicts and messages on a corpus and on
random commands (3 000 per run, 170 000 in this lane's sweeps, quality gate absent and present), plus the file-tree
check of the audit, the routing hints and the process contract; `tests/test_hook_settings.py` runs every hook command
from a drifted working directory under cmd and Git Bash. The dispatcher's own code now costs about 4 ms of a call.

Secret-store and edit rules (ADR-0028, lane SECRET-GUARD, 2026-10-26; 21 interleaved runs, hook command as the
harness runs it, median / p90 ms, before -> after): PreToolUse Read 165/296 -> 166/451, Bash `ls` 155/286 ->
167/344, a long Bash with pipes and `secret.js` 152/173 -> 171/207; PostToolUse Edit 275/966 -> 363/702 (noisy host),
PostToolUse of a 60 KB Read 185/212 -> 170/226 (it is now scanned, no longer logged). In process, cold (require plus
first verdict, median of 7, host under load): Read 15 -> 22 ms, long Bash 8 -> 28 ms, a tool without path fields
3 -> 9 ms; warm verdicts stay under 2 ms. The added cold cost is the parse of `secret_rules.js`, the first open of
`secret_paths.json` (antivirus) and first-run regex compilation; regexes of the registry compile only when a word holds
their literal, `edit_rules.js` loads only for Bash, PowerShell and Write, and the output scan pre-checks literals (an
unbounded URL pattern took 19 s on 60 KB before it was bounded). PostToolUse now starts for every tool (`*`), one
more Node start per Read/Bash/Grep call. If that matters more than the audit, the option is a regex matcher for the
content tools only. A Node compile cache (`module.enableCompileCache`) was measured and gave nothing.

Not changed (owner's global settings): `scripts/system-drive-guard.js` is already one Node process in parallel with the
project hook, so there is nothing to gain by moving it; the junk sweeper it shares a file with got the fix above and
the two session hooks profit from it without an edit.

Further options, not done:

- `async: true` for the PostToolUse audit (it never blocks and never fails): removes its ~0.2 s from the edit path;
  the stale-PASS race is the same as today.
- A direct `python.exe -I -S` hook is ~100 ms faster than Node on a loaded host but needs a machine path (above).
- Sub-100 ms hooks would need a native or resident process; not worth the attack surface.

## 5. Machine queue

Measured (`infra queue`, 2026-10-25, 8 cores, 31.8 GiB, 5 GiB free at the time):

| What | Value |
|---|---|
| Per-job overhead of `queue run` with a free slot | `node -e 0` 80 ms median bare, 334 ms through the queue (p90 469): about 250 ms (the CLI start plus ticket files) |
| Slot policy | 2 guaranteed, up to 4 while the host shows 15 % idle CPU over a 2 s window and 4 GiB free; polling every 1 s (before 2026-10-26; now watch + 250 ms) |
| Last 583 build jobs (one day) | run median 114 s, p90 395 s; **wait median 29 s, p90 399 s; 287 of 583 waited more than 30 s** |
| Recorded history (5 000 jobs) | 255 h of running, 65 h of waiting (a quarter of the machine time is queueing) |
| Cold `run_node_tests.js` through the queue | 98 s of work, 397 s wall: 299 s were waiting; warm (all 71 files proven) 3.3 s |

Findings:

1. The queue is not the cost of a job (250 ms), the waiting is. Waiting is memory-bound: a burst slot needs 4 GiB free,
   and the host runs 8 Java processes (8.3 GiB), 33 Chrome and 30 Claude processes (11 GiB) beside the emulator, so
   there is rarely headroom for the 3rd and 4th slot even when CPU is idle.
2. Short jobs (memoized Node tests, lint, `--tests` runs, 3 s to 60 s) wait behind 7-minute builds in the same FIFO.
3. Lanes do not block each other on a Gradle project directory as long as each lane builds in its own worktree
   (separate project dir, separate `build/`); they share `GRADLE_USER_HOME` (caches, build cache, daemons), which is
   what we want. The exception is the composite build: every game worktree includes the same `nrg-ui` checkout, whose
   `build/` directories Gradle locks while one build uses them. Lanes that do not pass their own
   `-PnrgUi.path=<kit worktree>` therefore serialise on the kit. Two builds on one project directory would also
   serialise (the second waits for the lock), but the queue does not know project directories, so it spends a slot on
   the waiter.
4. `INFRA_QUEUE_JOBS` (workers per job) is `cores / running`, so four concurrent Gradle builds each get 2 workers: more
   concurrent jobs do not add throughput once the CPU is full; they add memory pressure.

Recommended slots for 4 agents + the coordinator on this host (no code change needed; `INFRA_QUEUE_BUILD_SLOTS`,
`INFRA_QUEUE_BUILD_BURST` are read per invocation, set them in the environment of the queue callers):

- Keep `slots=2`, `burst=4`. Raising burst to 5 or 6 only helps if RAM allows: each Gradle daemon is `-Xmx4g`
  (up to 5 GiB resident with metaspace), so 4 builds already hold ~16-20 GiB. Fix memory first (Section 7), then burst 5.
- Cut the per-job cost instead of adding slots: lane test runs with impacted tests only, one Gradle invocation per lane step (`:app:testPlayDebugUnitTest --tests …`), no `clean`.
- Queue changes made by lane QUEUE-FAST (2026-10-26, ADR-0021 amendment): the items below were the proposals of this
  section; all are in `cli/lib/machine-queue.js` with tests.
  - **`quick` class** (`--class quick`, 2 slots, no burst, no memory gate, hard-capped at half the cores): for lint,
    format check, a single test file, `node --check`, a memoized or proven runner, anything that takes under about a
    minute and little memory. It never waits behind a build; a quick job still running after 120 s is logged as an
    overrun and recorded (`stats` counts them per owner), never killed. Gradle and Cargo stay `build`. When unsure,
    use `build`: a long job in `quick` takes one of only two slots from every other short job.
  - **Hand-over**: a directory watch wakes a waiter 15 ms after any ticket change, the poll is 250 ms (safety net).
    Release to grant, median of 10 with default settings: 503 ms (47-724) before, 67 ms (3-129) after.
  - **Burst gate**: free memory is read at every wake and idle CPU is a rolling 2 s mean, so a burst that memory had
    refused starts at the next wake after memory is free (before: after a fresh 2 s window plus up to 1 s of polling).
  - **`queue status`** first line gives free memory, the 4 GiB threshold and the measured idle CPU; under a class with a
    waiter: `next "<label>" waits - memory: 2.1 GiB free, a burst slot needs 4.0 GiB`. The waiting job prints the same
    reason. `INFRA_QUEUE_BURST_MIN_FREE_GB` changes the floor per invocation (only lower it when the Gradle daemons
    really fit; see Section 7).
  - **CLI start**: `infra queue ...` skips loading the other CLI modules (about 100 ms). Interleaved A/B on the
    loaded host (bare `node -e 0` median 298 ms): queue overhead over bare 575 ms before, 355 ms after; most of what
    is left is the second node start that a queue process cannot avoid.
- The queue state moved off the system drive: `INFRA_QUEUE_DIR`, else `queue` in `DEV_TEMP` (ADR-0025, never swept by
  the junk tool). Processes started before the switch keep using the old home folder; new ones read it too (read-only)
  until it holds no live ticket, so no flag day is needed (see the ADR amendment). Nothing to set: `DEV_TEMP` is
  already in the environment of every session.

## 6. Gradle (Mahjong game repository)

Setup read from `mahjong-v1`: `org.gradle.jvmargs=-Xmx4g -XX:MaxMetaspaceSize=1g -XX:+UseParallelGC`, `parallel=true`,
`caching=true`, `configuration-cache=true`, daemon idle timeout 15 min; the machine-wide `GRADLE_USER_HOME` is
`W:\dev\runtimes\gradle`, a junction to `V:\dev\gradle` (build cache and caches on the Dev Drive); AGP plus Kotlin
(KGP), Kover 0.9 on `:app`, 201 test classes with 2 053 test methods in `:app`, no Robolectric, one test JVM (default
`maxParallelForks`); the game includes the `nrg-ui` kit as a composite build.

Measured in a game worktree on `V:` (command `:app:testPlayDebugUnitTest --tests *StatsLayoutTest` unless noted, `--profile`,
wall time of the whole `./gradlew` call; the host ran 2-4 other builds and an emulator, so read ratios, not seconds):

| Step | Wall | Remarks |
|---|---|---|
| First build in a new worktree (daemon cold, build cache warm) | 199 s | startup 31 s, loading projects 36 s, configuring 28 s, tasks 75 s |
| "No change" run, configuration cache MISSED | 169 s, 134 s | cause 1 below |
| Test task re-executed, configuration cache reused, Kover agent ON / OFF | 65 s / 75-79 s | no Kover overhead for a lane test; not changed |
| `:app:assemblePlayDebug` first, then no change | 155 s, 80-85 s | |
| After the pin fix, no change, cache reused (loaded host) | 109 s, 79 s | cause 2 below dominates now |
| Kotlin statistics flag ON, no change, cache reused (quiet host) | 111 s, 86 s | |
| Kotlin statistics flag OFF, no change, cache reused (quiet host) | **57 s, 36 s** | -35 to -58 % |
| Package `screens.*` re-executed, 1 fork / 3 forks | 96, 88 s / 57, 65 s | -30 to -40 % for a big package |

Causes found, in order of size:

1. **The configuration cache was thrown away by every kit change.** `gradle/nrgUiPin.gradle.kts` ran `git rev-parse` and
   `git status` on the shared `nrg-ui` checkout while configuring; the configuration cache stores the output of such a
   process as an input ("cannot be reused because output of the external process 'git' has changed"). Lanes change the
   kit all day, so almost every build paid a full configuration (60 s and more). The check now reads the kit when the
   task runs (same messages, same strict/warn behaviour); the cache was reused in five consecutive runs afterwards.
2. **The Kotlin Gradle plugin's end-of-build statistics.** A `--debug` log of a no-change run shows the configuration
   cache loaded at 1.0 s, the tasks done by 8 s, then 35 s of silence inside the plugin's `BuildFinishBuildService`
   ("Single fus file was created"), and the same again for the included `nrg-ui` build (27 s): the run took 80 s for 8 s
   of tasks. `GRADLE_USER_HOME/kotlin-profile` holds 6 404 files (two per build ever made) that are read again at each
   build end, every open scanned by Defender (this reading is my inference from the file count and the timing; a thread
   dump could not be taken). `kotlin.internal.collectFUSMetrics=false` in the game's `gradle.properties` removes the
   second stretch and part of the first (80 s -> 54 s in the debug run; 86-111 s -> 36-57 s A/B). The first stretch
   (~35 s) remained in the debug run until the folder is emptied: **owner/coordinator action**,
   `Remove-Item W:\dev\runtimes\gradle\kotlin-profile\* -Force` (statistics only, regenerated two files per build; not
   touched here because the Gradle home is shared by every lane).
3. A cold daemon costs 13-31 s of startup per new daemon; a second concurrent build of another worktree starts its own
   daemon (empty file state). Idle daemons already leave after 15 minutes. Fewer, longer-lived lane sessions help.
4. Gradle reports that file contents on `V:` (ReFS) are not watched and discards the retained file state after each build.
   Enabling watching explicitly (`org.gradle.vfs.watch=true`) did not help in measurement (52-70 s against 36-57 s); not
   applied.

Applied in the game worktree (diff in the lane report, staged only): the pin script reads the kit at execution time,
`kotlin.internal.collectFUSMetrics=false`, and an opt-in `-Pmahjong.testForks=N` (default 1 fork, as before) for big
package runs; coverage gates are unaffected. Not changed: JVM args (4 GB heap with ParallelGC is right for the state a
composite build retains; the daemons of 4 concurrent lanes hold 16-20 GiB, which is what gates the queue), Kover (no
measurable overhead), the build cache (already local, on the Dev Drive, with `FROM-CACHE` hits on the cold build).

Recommended next for Gradle: empty `kotlin-profile` (above); reuse one daemon per lane (`./gradlew` from the same
worktree reuses it); impacted tests with `--tests` and no `clean`; the full suite with `-Pmahjong.testForks=3` only at
the coordinator's integration, after a trial on a host the other lanes are not using (tests that share files or ports
would need to be proven fork-safe first).

## 7. The machine (report only: nothing here was changed)

Facts read from the host (no admin rights, nothing modified): Intel Core i5-10300H laptop CPU (4 cores, 8 threads, power
limited), 31.8 GiB RAM with 4.8 GiB free during the work, Defender real-time protection on (`MsMpEng` 526 MiB, tamper
protection on, exclusions are readable only with admin rights, so the current list could not be checked), power plan
"Balanced" is the only plan, Windows Search (`WSearch`) and `SysMain` running, `W:` is NTFS (1.2 TB, repository and
runtimes), `V:` is ReFS (the Dev Drive, 452 GB free, build outputs, caches, scratch), the pagefile is system managed on
`C:` (21 GB allocated, 4 GB in use), last-access updates and 8.3 names are already off, `.wslconfig` caps WSL at 16 GB.
CPU was at 100 % whenever the measurements ran (Gradle test JVMs, an emulator with 4 of the 8 threads, the other lanes).

| # | Item (owner action) | Exact steps | Gain |
|---|---|---|---|
| 1 | **Defender exclusions** for the folders and processes of the build tools | Admin PowerShell: `Add-MpPreference -ExclusionPath 'W:\dev','W:\code','V:\dev','C:\Users\Admin\.android'` and `Add-MpPreference -ExclusionProcess 'java.exe','javaw.exe','python.exe','node.exe','git.exe','bash.exe','sh.exe','rg.exe','cargo.exe','rustc.exe','sccache.exe','adb.exe','emulator.exe','qemu-system-x86_64.exe'`. Check first: Windows Security > Virus & threat protection > Manage settings > Exclusions (the Gradle home, the Android SDK and the AVDs are inside `W:\dev` or `V:\dev` through junctions; add the junction targets if the list shows them elsewhere). The Node and Git runtimes are in `W:\dev\runtimes`, the repository in `W:\code`. Revert: `Remove-MpPreference` with the same arguments. | Measured cost it removes: every opened file is a scan, e.g. `import re` in Python is ~20 file opens and cost 100-150 ms; `git status` on `W:` 149 ms against 98 ms in a worktree on `V:`. Expected 10-30 % on Gradle configuration, tests, git and `rg`; Microsoft quotes up to 30 % for the Dev Drive mode |
| 2 | **Trust the Dev Drive** so Defender runs in performance mode on `V:` | Admin: `fsutil devdrv query V:` must say the volume is trusted and Defender in performance mode; if not, `fsutil devdrv trust V:` (and Windows Security > Device performance). `V:` already holds the Gradle home, caches and scratch | Same effect as item 1 for `V:` without excluding anything; asynchronous scanning |
| 3 | **Move the hot trees to `V:`** (ReFS Dev Drive): the base repository and agent worktrees (worktrees already live there), the Node, JDK, Python and Android SDK runtimes | Owner decision (ADR-0026 moved tool homes behind junctions; the same pattern: copy, junction `W:\...` to `V:\...`, keep the path). 452 GB free on `V:` | Measured: git status 35 % faster on `V:`; every tool start opens many files |
| 4 | **Power plan "High performance"** | `powercfg -duplicatescheme 8c5e7fda-e8bf-4a96-9a85-a6e23a8c635c` prints a new GUID, then `powercfg /setactive <GUID>`; or Settings > System > Power > Best performance while plugged in. Keep the laptop on mains and ventilated (an H-series CPU throttles under the 100 % load) | Expected 5-15 % on short process starts and Gradle configuration (no core parking, faster frequency ramp); not measured, the host is shared |
| 5 | **Stop indexing code folders** | Indexing Options > Modify: untick `W:\code`, `W:\dev`, `V:\dev`; or Admin: `Stop-Service WSearch; Set-Service WSearch -StartupType Disabled` | Less background I/O and CPU while builds write thousands of files; expected small, no search of code folders is needed (we use `rg`) |
| 6 | **Free RAM so the queue can burst** | Close idle Chrome (33 processes, 5.8 GiB) and idle Claude sessions (30 processes, 5.6 GiB), quit Docker Desktop when no stand is needed; Gradle daemons already leave after 15 minutes. A burst slot needs 4 GiB free: with 4.8 free, the 3rd and 4th build waited | The queue wait (Section 5: median 29 s, p90 399 s) is memory-gated; every freed 4 GiB is one more concurrent build |
| 7 | **Emulator share** | The Mahjong AVDs use 4 cores and 3 GB RAM with the host GPU. Boot only the one AVD needed, shut it down when the job needs no device (clean-up rule); two AVDs at once starve the builds of half the CPU | Frees 4 threads and 3-4 GiB for builds while no device check runs |
| 8 | **SysMain** (Superfetch) | Optional: `Stop-Service SysMain; Set-Service SysMain -StartupType Disabled` on an SSD host | Marginal; listed for completeness |

Already right (do not touch): last-access timestamps off, 8.3 names off, WSL capped at 16 GB with gradual memory
reclaim, scratch and Gradle home on the Dev Drive, `TEMP` on `V:\dev\tmp\os`.
