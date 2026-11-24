# ADR-0030: a defect closes with a lesson

- Status: Accepted (owner order, 2026-10-27)
- Relates to: ADR-0018 (child layout), the `nrg-game-ui` skill (frame lessons GU<n>)

## Context

After the Mahjong R1 device pass on 2026-10-27 ten defects were fixed, but only the ones found on the journey map became
`nrg-game-ui` lessons. The rest were repaired in code and forgotten as rules, so the same class of defect can come back in the
next screen or the next game. The owner ordered: "не вставать ещё раз на грабли" - a defect is not closed until the lesson
that would have prevented it is recorded where every future agent reads it (a skill), not only where it was fixed.

## Decision

1. Every defect found in a device pass, frame review or owner remark is a row in the project's tracked ledger
   `app_entry_root/<key>/_project/**/*DEFECTS*.md`. A ledger is a markdown table whose header has the columns `Id`,
   `State` and `Lesson` (found by name, any order). A ledger table without a `Lesson` column is an error.
2. Rules per row, by the start of the State cell (case-insensitive):
   - `FIXED`, `DONE`: the Lesson must cite at least one real lesson.
   - `OPEN`, `partly`, `OWNER REVIEW`: a real lesson, or the literal `pending` (the lesson is due when it closes).
   - `accepted`, `tool note`, `plan note`, `warning`, `moved`: a real lesson, or `none: <reason>` with a reason of at
     least 10 characters.
   - any other state is an error.
3. A real lesson is `GU<n>` with a row `| GU<n> |` in `skills/nrg-game-ui/references/frame-lessons.md`, or
   `skill:<name>` where `skills/<name>/SKILL.md` exists (optionally `skill:<name>/<relative path>`, the file must exist).
   `lint:<rule>` is accepted as an addition but never alone: a lint rule lives in a child repository, so it cannot be the
   only evidence in the base. For UI defects the lesson pairs with the `ui_lint` rule that catches the class.
4. `infra validate` runs the check (`cli/lib/defect-lessons.js`) and fails with one line per problem:
   `[infra] defect lesson <ledger> <id>: <problem>`. Unknown references name the ledger, the row id and the bad reference.
   Child version directories (`<key>-v1/`) are separate repositories and are not scanned.
5. AGENTS.md carries the rule under "Engineering standards".

## Consequences

- A defect cannot be marked FIXED by a fix alone: the commit that closes it also adds the lesson, so rules accumulate in
  skills instead of in agents' memory.
- Existing ledgers gain a Lesson column; open rows start as `pending`, non-defect notes use `none: <reason>`.
- A wrong or renamed lesson id breaks `validate` until the ledger is corrected, which keeps references live.
- The check is textual: it proves a lesson exists, not that it is good; review of the lesson text stays with the
  coordinator.
- Tests: `cli/test/defect-lessons.test.js` (passing ledger, FIXED without lesson, lint-only, unknown GU or skill,
  pending, short `none:`, missing column, unknown state).
