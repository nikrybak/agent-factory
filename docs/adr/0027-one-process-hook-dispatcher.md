# ADR-0027: One-process Node hook dispatcher

Date: 2026-10-25
Status: Accepted (owner in chat 2026-10-26: "Да, включай", matcher `*`; integrated 77f7541)

## Context

Every tool call of every agent ran two to three separate Python hook processes, each started through the PyManager
shim as `python -c "import os,runpy;..."`. Measured on the Windows 11 host (8 cores, under build load, medians of 20
interleaved runs): the shim costs about 300 ms more than the interpreter itself, and `import json` pulls `re`, `enum`,
`functools` and `collections`, another 100-150 ms. A Read cost about 1 s of hook time, a Bash call 1 s, an Edit 2 s
(pre plus post), on top of the real work, for every agent and every call.

A first version called the Python interpreter directly (`python.exe -I -S`). It was as fast, but `infra validate`
(REQ-CF-002) rightly rejects machine paths in tracked files, and a hard-wired interpreter path would switch the guards
off silently on any other host (a missing interpreter exits non-blocking).

## Decision

1. **One process per event, started from PATH.** `.claude/hooks/dispatch.js` serves `pre` (PreToolUse), `post`
   (PostToolUse), `prompt` (UserPromptSubmit), `stop` and `task` (TaskCompleted). `node` is already a hard dependency
   of the factory (the `infra` CLI), starts in 70-100 ms and needs no shim. For Bash, the secret guard and the
   command guard run in the same process. The command enters `CLAUDE_PROJECT_DIR` first (cwd-proof) and is valid in
   cmd and in Git Bash.
2. **The Python guards stay as the reference implementation.** `secrets_guard.py`, `pretool_guard.py`,
   `posttool_audit.py`, `user_prompt_submit.py` and their tests are unchanged in behaviour. `dispatch.js` ports their
   patterns with a Python-compatible regex builder (Unicode `\s`, `\w`, `\b`, `.`), and
   `tests/test_hook_dispatch.py` proves the same verdict and message on a hand-written corpus and on random commands
   (3 000 per run; 90 000 in the lane's sweep), with the quality gate absent and present, for the
   file-tree check of the audit, the routing hints and the process contract. A guard change is made in both files and
   fails the parity test otherwise.
3. **PreToolUse matcher stays `*`** (owner decision 2026-10-26). A narrower lookahead regex that skipped tools without
   guarded fields was measured, but if the harness does not read it as a regex the guards would silently stop firing;
   every tool call goes through the dispatcher, which returns at once for a call without a guarded field.
4. **The PostToolUse audit** keeps its two duties (append to `tool_audit.log`, drop a stale PASS flag); the log line is
   the compact payload (first 2000 characters) with a millisecond UTC stamp.
5. `junk.js sweep --auto` skips the walk of the scratch root when nothing marked could go and reuses a measurement
   younger than five minutes (it cost 4-15 s per session end and per `done`).

## Consequences

- Hook time per call drops from about 1 s to about 0.1-0.2 s on top of the shell start (numbers in
  `skills/factory-fast-verification/references/tooling-performance.md`).
- Two implementations of the guards exist; the parity test is the contract. Retiring the Python reference (and
  converting its tests to Node) is a separate decision.
- The global drive guard (`scripts/system-drive-guard.js`, owner settings) is already a Node process; no change is
  needed there.
