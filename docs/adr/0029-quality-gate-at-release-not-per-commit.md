# ADR-0029: the full quality gate guards releases, not every commit

- Status: Accepted (owner, 2026-10-26)
- Amends: AGENTS.md absolute rule 4, ADR-0021 items 9-11 (the PASS flag of the base)

## Context

The base PreToolUse guard refused every commit and push of the base repository until `scripts/quality_gate.py` had passed
on the current tree. The gate runs `infra certify` (plan, every district, verify) plus coverage and Python checks: 4-10
minutes on this host, and any Edit inside the base drops the PASS flag again. Development on `dev` therefore stalled behind
the full certification many times a day, while the gate's real purpose is to stop an uncertified tree from being released.
The owner asked on 2026-10-26 to run the gate once when work goes to main, or once after a large batch or sprint.

## Decision

1. The guard (`.claude/hooks/dispatch.js` and its Python reference `pretool_guard.py`, kept in parity) requires the PASS
   flag only for release commands that target the base: `git push`/`git merge` naming main or master, `git push --tags`,
   `git tag`, `gh pr create|merge` naming main or master, `gh release`, `npm version`, `docker push`.
2. Commits and pushes on `dev` (and merges of lane branches into `dev`) run the fast checks only: the impacted tests
   (`node scripts/run_node_tests.js` is memoized per file), `infra validate`, `infra sync --check`.
3. The coordinator runs the full gate (`infra certify` COMPLETE, then `python scripts/quality_gate.py` PASS) once per large
   batch or sprint and always before a release into main.
4. Nothing else changes: the secret-store, destructive-command, polling and edit-path rules apply to every command.

## Consequences

- A dev commit no longer waits minutes; regressions surface at the latest at the batch gate, earlier through impacted tests.
- Child repositories are unchanged: they never needed the base gate.
- Tests: `tests/test_pretool_guard.py` (dev commits pass, every release form is blocked without PASS, child repositories
  pass) and the dispatch parity corpus in `tests/test_hook_dispatch.py`.
