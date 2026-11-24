# ADR-0020: Owner-wide store console knowledge and secrets vault

Date: 2026-10-05
Status: Accepted by owner decision, 2026-10-05 — extends the child layout of ADR-0018 with one
non-child entry

## Context

Every game is published through the same store accounts (Huawei AppGallery Connect, Google Play,
App Store, RuStore and later others) under one legal entity with one payout bank account. Console
structure, what has been configured, what is blocked and why, and the owner-wide secrets (bank,
legal entity, console API keys, social sign-in credentials) were scattered across chat and a
single game's `OWNER_ACTIONS.md`. With hundreds of planned games, that knowledge must live once,
be reusable per store and survive the loss of a machine.

ADR-0018 closes the shape of `app_entry_root/`: every non-underscore directory is a registered
child. Owner-wide knowledge is not a child.

## Decision

1. `app_entry_root/_global-info/` holds owner-wide store and console knowledge. The leading
   underscore keeps it out of child scanning, like `_registry/`; no resolver or registry change.
2. Tracked: `README.md`, `DEFERRED.md` (the single list of steps blocked until test and
   production, per store and module, with reason and executor), `stores/` (module × store
   matrix, shared rules, one console map per store, listing limits) and
   `vault/<name>.env.example` templates (secret names only, every value empty, no key in two
   templates): `global` for production and owner values, `test` for test apps, sandboxes,
   testers and public test ad units.
3. Ignored: `_global-info/.secrets/` with the real `global.env` and companion key files.
   Per-game signing keys stay in `app_entry_root/<game>/.secrets/`.
4. `scripts/global-info-vault.js` manages the secrets: `init` (template copy, never
   overwrites), `check` (names of unset keys, never values), `pack` (JSON of every file → gzip →
   gpg AES-256 symmetric, one archive for cloud backup) and `unpack` (never overwrites a
   differing local file without `--force`, rejects entries escaping `.secrets/`). It refuses a
   secrets directory Git could track. gpg runs with a throwaway home inside a private work
   directory and relative names only, because the MSYS gpg of Git for Windows misreads drive
   paths.
5. Non-secret identifiers (developer, project, app and OAuth client IDs) are written openly in
   the console maps; client secrets, API keys, private keys and bank data never are.

## Consequences

- Store setup for the next game starts from the console map instead of rediscovery; a blocked
  step is visible with its reason until it is closed.
- Losing the machine loses nothing: the encrypted archive and its passphrase restore
  `.secrets/` in one command.
- `infra project scan` stays unchanged; a future non-child entry must also start with `_`.

## Verification

`tests/global-info-vault.test.js` (8 tests): the tracked template has only empty values; the
base ignores `_global-info/.secrets/` and tracks the knowledge files; init/check never print
values; argument validation; an empty pack is refused; a trackable secrets directory is refused;
pack/unpack round trip with overwrite protection and `--force`; a wrong passphrase restores
nothing.

## Addendum 2026-10-06: agents cannot reach secret overlays

A messaging agent's recursive `grep` from the base root printed two Huawei values from the ignored
`_global-info/.secrets/global.env` into its transcript. Instructions alone were not enough, so access is now
enforced for the main session and every subagent:

- `.claude/settings.json` denies `Read`, `Edit` and `Write` on `**/.secrets/**`;
- the PreToolUse hook `.claude/hooks/secrets_guard.py` (matcher `*`) blocks any tool path or shell command
  that names a `.secrets` directory or the real `global.env` / `test.env` (templates stay allowed), recursive
  `grep`, `rg` with ignore rules switched off and `git grep --no-exclude-standard`. Text written by Edit/Write
  is not inspected, so documents may still name the directory; shell heredocs that do are refused. Tests:
  `tests/test_secrets_guard.py` (6 cases, including live payloads);
- only the owner touches the overlays, with `scripts/global-info-vault.js` in the owner's own terminal.

The exposed Huawei Game Service key cannot be rotated in the console (support ticket only); the owner accepted
the low risk, and both transcript copies of the agent were redacted.
