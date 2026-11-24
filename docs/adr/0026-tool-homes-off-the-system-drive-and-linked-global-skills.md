# ADR-0026: AI tool homes off the system drive, global skills as links to the canon

Date: 2026-10-22
Status: Accepted by owner decision, 2026-10-22

## Context

After ADR-0025 the system drive still held the homes of the AI tools themselves: `~/.claude` (5.3 GB of sessions,
plugins and memory), two desktop accounts of Claude (`Claude-Data`, the second profile `ClaudeSecond` started by the
`meClaude` launcher), `~/.codex` (5.3 GB), Codex runtimes, Playwright MCP browser profiles and the pnpm store. The
owner wants the system drive to hold Windows and programs only, and everything of the work flow in one tidy place.

The user-level skill folders of the three tool families (`~/.claude\skills`, `~/.codex\skills`, `~/.agents\skills`,
already junctions to `<dev>\ai\...`) held full copies of the canon in `skills/`: 348 copies per tool, 136 of them
stale. Copies drift; the canon is meant to be the single source.

## Decision

`<dev>` below is the owner's dev root on the work drive (a host setting, never committed).

1. **One tree per tool on the work drive**: `<dev>\claude` (`home`, `accounts\main`, `accounts\meClaude`, `shared`,
   `cli`), `<dev>\codex` (`home`, `appdata`, `cache`), `<dev>\cache` for shared caches. The old paths stay as
   junctions, so every application keeps its configured paths. `scripts/owner/move-claude-home.ps1 -Tool
   Claude|Codex|Caches` does the move.
2. **Zero loss is proven, not assumed.** Every file is compared by SHA-256 and every folder and inner link is checked
   before the original is renamed to a backup; a source that keeps changing (a cleaner, an updater) is re-synced in
   passes; after the switch the backup is compared with the copy again. Inner links (for example `~/.claude\skills`)
   are carried as links and never walked or purged. Backups are removed only on the owner's word (`-Cleanup`), from a
   process outside the MSIX package (inside it Windows shows package-virtualised views of some `AppData` folders).
3. **The move runs only with the tool closed**, from a waiter started outside the tool's process tree; progress is
   written to a file on the owner's Desktop.
4. **Global skills are links, not copies.** `scripts/owner/link-global-skills.ps1` turns every user-level copy of a
   canon skill into a junction to `skills/<name>`; a non-canon skill that is the same for all tools lives once in
   `<dev>\ai\shared-skills`; real per-tool variants stay. Replaced copies go to a scratch backup first.
5. **Left on the system drive by design**: `~/.claude.json` (the CLI replaces it by write-and-rename, a link would be
   lost), MSIX package folders managed by Windows, `%LOCALAPPDATA%\OpenAI` (the Codex package excludes it from write
   virtualisation; Windows refuses to start Codex with error 0x800701C0, untrusted mount point, when it is a junction),
   and the applications themselves (moved, if wanted, by Windows Settings > Apps).

## Consequences

- The system drive no longer grows with sessions, caches or skills; the work drive holds them in one place.
- An edit of a canon skill reaches Claude, Codex and the generic agents at once; there are no stale global copies.
- Codex reads the canon `SKILL.md` directly as it did with the copies; the 8 KB split lives in the canon itself.
- Skills that are in the canon but were never installed globally stay project-only, as before.
- A tool update that recreates one of its folders at the old path would put data back on the system drive; rerunning
  the move script catches it (already linked folders are skipped).
