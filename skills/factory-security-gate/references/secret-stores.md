# Secret stores: use values, never print them (ADR-0028)

A secret value never reaches a transcript or a log. Tools still use it: injected into a child process, written to
a private temporary file for a tool that wants a file, or copied to the owner's clipboard. Everything stays on the
owner's machine. The PreToolUse guard blocks every other access to the stores in `.claude/hooks/secret_paths.json`.

## For agents: the safe commands

| Need | Command |
|---|---|
| Which keys does the file have? | `node scripts/secret.js keys gradle` (alias) or `keys <path>` |
| Non-secret settings of the file (`org.gradle.*`, `sdk.dir`, `*.keyAlias`, `*Url`) | `node scripts/secret.js public gradle` |
| Is the key set? | `node scripts/secret.js check nonoku.upload.storePassword@gradle` (present and length, exit 1 if not) |
| A tool needs the value in a variable | `node scripts/secret.js run --env GH_TOKEN=nrgames.token@gradle -- gh api user` |
| A tool reads the password from a variable | `node scripts/secret.js run --env KS_PASS=nonoku.upload.storePassword@gradle -- keytool -list -keystore app/upload.jks -storepass:env KS_PASS` |
| A tool wants a file path in a variable | `node scripts/secret.js run --file GOOGLE_APPLICATION_CREDENTIALS=*@play-sa.json -- python tools/upload.py` (private temporary file, removed afterwards) |
| The whole file as one value | key `*`: `--env SA_JSON=*@play-sa.json` |
| Sign or build | `./gradlew bundleRelease`, `keytool -list -v -keystore x.jks`, `apksigner verify` (consumers read the store themselves) |
| The owner must paste a value somewhere | ask the owner to run `node scripts/secret.js clip <key>@<file>` |

The output of `run` is masked: every injected value (raw, URL-encoded, JSON-escaped, hex, base64, base64url, also
inside a longer base64 such as a Basic auth header) and every secret-named variable already in the environment is
printed as `***`. Passing a value on a command line (`-storepass VALUE`) puts it in the transcript: never do it.

Blocked, with the reason and the safe command in the message: reading, searching, copying, encoding, archiving or
uploading a store (cat, type, Get-Content, rg, Select-String, base64, certutil, cp, tar, curl -d @file, interpreter
code that opens it, `source .env`); `env`, `printenv`, `set`, `export -p`, `Get-ChildItem env:`, printing a variable
whose name looks secret; reading the clipboard; `secret.js set`. A command that merely mentions a store name is
blocked too: write such text with Edit/Write.

If a tool result ever shows `SECRET-SHAPED OUTPUT (...)`: stop, do not repeat or use the value, and tell the owner
which call showed it so they rotate it. If it was a fixture, continue.

## For the owner

Copy a value to the clipboard (cleared after 45 seconds; `--keep` keeps it):

```text
node scripts/secret.js clip nonoku.upload.storePassword@gradle
```

Set or rotate a value (in your own terminal; hidden prompt, nothing is printed; `--from-clipboard` takes the value
you copied, e.g. a new token from the GitHub page):

```text
node scripts/secret.js set nrgames.token@gradle --from-clipboard
node scripts/secret.js set nonoku.upload.keyPassword@gradle
```

`set` writes `.properties` and env files in place (other lines, comments and line endings stay) through a
temporary file; JSON and YAML stores are edited by hand.

### Add a location to the registry

Edit `.claude/hooks/secret_paths.json` (patterns only, never a machine path):

- a file anywhere: add a glob to a store, e.g. `"globs": ["play-upload.json"]`, or a new store
  `{"id": "play-api", "globs": ["*-play-api.json"], "consumers": []}`;
- a file under a variable or the home folder: `"paths": ["$MY_TOOL_HOME/credentials", "~/.mytool/credentials"]`
  (resolved at run time; the folder and the file name named apart in one command also count);
- a folder that holds secrets: add it under `"dirs"` (its direct children and searches below it are blocked);
- a program that uses the file without printing it: add it to that store's `"consumers"`;
- a template that must stay readable: add a glob to `"allow"`;
- a variable name that is wrongly treated as secret: add it to `secretEnvNames.notSecret`;
- a key whose value may be shown by `secret.js public`: add a glob to `"publicKeys"`;
- a short file name for `secret.js`: add an alias, e.g. `"play": ["$PLAY_HOME/play-sa.json"]`.

A glob without `/` matches the file name; `**/` means any folders; a leading `*` needs one character and never
matches a dot file; `"standalone": true` (for names that also look like code, `x.key`, `ctx.env`) matches only a
whole shell argument or a path with `/`. Then run the hook tests:
`python -m unittest discover -s tests -p "test_hook*.py"` and `python -m unittest tests.test_secrets_guard`.
