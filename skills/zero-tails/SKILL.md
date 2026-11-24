---
name: zero-tails
description: How to finish ANY task with nothing left behind - build, device check, commit, push (NR-Games through the gh helper), package publish and every game moved to it, pull request into main when main is protected, store and console drafts, docs, lessons, memory, cleanup - and the known blockers with their fixes so autonomous work never stops on them. Use at the end of every task, before saying "done", when a push, merge, publish or pin is refused, when something "needs the owner", and when the owner says хвосты, 0 хвостов, без хвостов, доведи до конца, запушь, обнови пакеты, всё как надо.
---

# Zero tails: finish everything, every time

Owner order 2026-11-09: "0 хвостов всегда ... пуш всё, обновляй пакеты ... чтобы ничего никогда не оставалось". A task is
done only when nothing of it is left for anyone. The catalog of what we have and how to use it is
`docs/operations/CAPABILITIES.md`; this skill is the procedure and the traps.

## When to Use

- At the end of every task and every loop tick, before the report.
- When a step is refused (push to main, merge, publish, pin mismatch, emulator offline) - the table below has the fix.
- When tempted to write "the owner can push it", "later", "needs a manual step": that is a tail; do it now.

## How It Works

### 1. The finish line, in order

1. **Verify**: the impacted tests through the queue (AGENTS.md); a UI change also on the device class it targets (phone,
   tablet, PC) through the real path, not only a capture scene (GU151).
2. **Defects**: every defect found goes to the project's `*DEFECTS*.md` with a Lesson column; the lesson lives in a skill
   (UI: a `GU<n>` row + its guard test); `infra validate` refuses a FIXED row without one.
3. **Commit** on the working branch (conventional, no AI attribution). Flavour branches follow: `git merge dev` into
   `dev-pc` (worktree when another branch is checked out).
4. **Packages**: a changed package gets a semver bump + CHANGELOG, its own verify (nrg-ui `tools/verify.sh` all PASS,
   nrg-shield `tools/verify.sh` READY), is **published** (`GITHUB_ACTOR` + `GITHUB_TOKEN` from gh), its release branch
   pushed, a PR into its main opened and merged; every game moves to it (`python -I tools/nrg_ui_pin.py update`, rebuild,
   impacted tests, frames of what the version changed).
5. **Push** every repo touched: base `dev` after `infra validate` + `infra sync --check`; NR-Games repos through the gh
   credential helper (catalog row). Nothing ahead of its remote.
6. **Main**: when main is protected (AGENTS.md rule 4, the auto-mode classifier), open a PR from the verified branch, put the
   checks in its body, merge it (`gh pr merge <n> --merge`), close a PR it supersedes with a comment.
7. **Stores and consoles**: every change saved; release buttons that publish to players stay the owner's (drafts).
8. **Docs**: plan/parity table row + log, ledger, the skill that owns the lesson, `docs/operations/*`, memory.
9. **Clean**: own emulators off (`adb emu kill` only for your own serial), Developer Emulator left as the owner had it, tabs
   closed, background jobs finished, worktrees removed, temp branches deleted after their merge, scratch `junk.js done`.
10. **Report**: done + checked + what waits on someone else with its trigger. Nothing else may be open.

### 2. Known blockers and their fixes

| Blocker | Fix |
|---|---|
| `git push` to an NR-Games repo: "Repository not found" | push through the gh credential helper (catalog row) |
| Push or merge into `main` refused by a hook, the classifier or the base's deny list (`gh pr merge*`, push `main`/tags in `.claude/settings.json`) | PR from the release branch, checks in the body, then `gh pr merge`; the owner runs `node scripts/owner/allow-zero-tails-automode.js` once: it adds the auto-mode rules AND lifts those four deny entries (force, delete, mirror, --all stay denied; the base's own main still needs the gate PASS); `--check` says what is missing |
| A commit or other command refused although it pushes nothing | the deny globs match the whole command line, message text included (`git*push*main*` caught "pushing main" in a commit message, the merge guard caught the words of a merge command): reword the message |
| `gh pr merge`: "Merge commits are not allowed on this repository" | the repo takes squash only (nrg-ui, nrg-shield): `gh pr merge <n> --squash --subject "<release line>"`; then `git reset --keep origin/main` in the local checkout (same tree, new commit) and `nrg_ui_pin.py update` in each game |
| Closing a PR someone else opened is refused (External System Writes) | leave it: comment-free, name it in the report for its owner (it is superseded once its commits are in main) |
| Claude may not change its own permissions (Self-Modification) | never work around it: give the owner the one command above |
| Gradle publish: `credentials.username doesn't have a configured value` | set `GITHUB_ACTOR=$(gh api user --jq .login)` next to `GITHUB_TOKEN=$(gh auth token)` |
| `gh api /orgs/...` rewritten to a Windows path by Git Bash | drop the leading slash: `gh api orgs/...` |
| A game release build fails on the nrg-ui pin | the kit checkout must be at the pinned commit; after a kit release `tools/nrg_ui_pin.py update` in the game and commit `nrg-ui.pin` |
| Another session's uncommitted files in a shared checkout | never touch them: a temporary worktree from the target branch (`git worktree add -b fix/<x> <dir> dev`), commit, fast-forward `dev`, merge into `dev-pc`, push, remove the worktree, delete the branch |
| `git branch -d` says "not fully merged" for a branch merged into `dev` | check `git merge-base --is-ancestor <branch> origin/dev`, then `-D` |
| Foreground wait loops blocked (ADR-0021) | run the job in the background and wait for its notification |
| Heredoc into a tracked file / inline file writes blocked | Edit/Write tools; a script file with `mass-edit:` only for 10+ files |
| `infra validate`: machine path in a doc | write `<rt>` (runtimes folder) or a description, never a drive path |
| Play Games PC Developer Emulator: BB001 | start it from its Program Files folder or the Start menu, not from the runtimes folder |
| Developer Emulator goes offline | use only its own adb (`localhost:6520`); a second adb server kicks it |
| A button "does nothing" on a slow emulator | wait for the app's own ready line (Mahjong: `look: ready`), then read logcat; a silent `onExit` means no deal (PC-01) |

### 3. Before you write the report

Run the checklist at the end of `docs/operations/CAPABILITIES.md`. If any line is open, it is the next step, not part of
the report.

## Examples

- Kit fix found on a device (Mahjong PC-02, 2026-11-09): worktree of nrg-ui from the released commit, fix + guard test,
  0.6.1 in `gradle.properties` and CHANGELOG, `tools/verify.sh` all PASS, publish with gh token and actor, push
  `release-0.6.1`, PR into main with the checks, merge, close the superseded 0.6.0 PR; in Mahjong `nrg_ui_pin.py update`,
  impacted tests, device frame of the dock, commit, push.
- Fix needed in a game another session is editing (Nonoku `startActivityForResult`, 2026-11-09): temporary worktree from
  `dev`, compile through the queue, commit, fast-forward `dev`, merge into `dev-pc`, push both, remove the worktree and the
  branch, hand the other agent a short note of what landed.
