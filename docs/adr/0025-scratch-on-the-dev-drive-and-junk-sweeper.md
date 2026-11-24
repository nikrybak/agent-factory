# ADR-0025: Scratch on the Dev Drive, marked junk swept in batches

Date: 2026-10-22
Status: Accepted by owner decision, 2026-10-22

## Context

Agents and tools left gigabytes of short-lived files on the system drive: the agent harness scratchpad, OS temp
folders of build tools, screenshots, emulator videos, traces, test packages, render previews. The owner forbade any
further writes there. The host has a Dev Drive meant for exactly this kind of churn; a scratch folder on it already
existed and had grown with unmarked leftovers nobody could safely delete, because nothing said what was still in use.

## Decision

1. **The scratch root is `DEV_TEMP`**, a folder on the Dev Drive (configured per host, never committed). The tool
   refuses a root on the system drive and a root too shallow to be a scratch folder.
2. **Every short-lived folder or file lives under the root.** `node scripts/junk.js new <label>` creates a fresh job
   folder (`jobs/<label>-<time>-<random>`); tools get `TEMP`/`TMP`/`TMPDIR` = `<root>/os` from the agent's global
   settings.
3. **Whoever is done with something marks it**: `junk.js done <path>...` writes a marker into a folder and records
   folders and files with their size in the root's ledger.
4. **Batch sweep at a threshold.** When the whole root has grown to `DEV_TEMP_SWEEP_MB` (1024 by default), everything
   marked goes in one batch: ledger entries that still carry the marker, ledger files, marked job folders the ledger
   missed, and tool leftovers in `<root>/os` older than a day. On Windows the folders are removed with `rd /s /q` in
   command batches; nothing is opened or read. The sweep runs after every `done` and from the agent's session start
   and end hooks.
5. **Unmarked items are never deleted**, and nothing outside the root is ever touched: they may belong to a running
   session.

## Consequences

- The system drive stops growing from agent work; the Dev Drive absorbs it and frees itself in batches.
- A forgotten mark keeps a folder until someone marks it; the ledger and `junk.js status` make the marked total
  visible.
- Pre-existing unmarked leftovers stay until a person decides about them.

## Verification

`tests/junk.test.js`: root refusals (missing, shallow, system drive), job naming, marking folders and files once,
outside paths refused, the threshold gate, only marked items deleted (unmarked and outside ones survive), old tool
leftovers swept, Windows batches under the command line limit, the command line.
