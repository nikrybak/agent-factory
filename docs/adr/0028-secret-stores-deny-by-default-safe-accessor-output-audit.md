# ADR-0028: Secret stores - deny by default, one safe accessor, output audit; edits through the Edit tool

Date: 2026-10-26
Status: Accepted (owner order in chat 2026-10-26: secret values never reach a transcript; integrated c3d82fd, verified live)

## Context

On 2026-10-26 an agent ran `cat` on the Gradle user-home properties file. It holds the upload-key passwords and
the GitHub package tokens; the values landed in a transcript and the owner had to rotate the tokens. The guard of
ADR-0020 protected only `.secrets/` overlays and the vault files. Owner order: a secret value never reaches an AI
transcript or a log, under any circumstances, but tools must still be able to use it (by variable, injected into a
child process, or copied to the owner's clipboard), and everything stays on the owner's machine.

Threat model (accidents, not a hostile agent):

1. An agent prints a secret file (cat, type, Get-Content, Read, Grep) while looking for a setting.
2. An agent copies, encodes, archives or uploads a secret file (cp, base64, tar, curl -d @file).
3. An agent prints environment variables that carry secrets (env, printenv, echo $TOKEN, Get-ChildItem env:).
4. An agent reads the clipboard right after the owner copied a password.
5. A tool prints a secret on its own (verbose HTTP, a crash dump): it can only be detected after the fact.

## Decision

1. **One registry, patterns only.** `.claude/hooks/secret_paths.json` lists the secret stores (`$GRADLE_USER_HOME/
   gradle.properties`, `~/.gradle/gradle.properties`, `**/.secrets/**`, keystores, private keys, env files except
   templates, signing and local properties, service-account JSON, `.git-credentials`, `.netrc`, `.npmrc`, gh
   `hosts.yml`, wrangler config, cloud credential files), the folders that hold them, the template exceptions, the
   programs that only look at a path, the consumers per store, and the rules for secret-shaped variable names.
   `$VAR` and `~` resolve at run time; no machine path is tracked (REQ-CF-002). The owner extends it (how-to:
   `skills/factory-security-gate/references/secret-stores.md`).
2. **Deny by default at PreToolUse** (`secret_rules.js`, reference `secret_rules.py`, both in `dispatch.js` and
   `secrets_guard.py`, parity-tested):
   - file tools (Read, Edit, Write, MultiEdit, NotebookRead/Edit, Grep `path`/`glob`, Glob, LS and any tool with a
     path field) on a store or a store folder; Grep below a store folder;
   - a shell segment (Bash and PowerShell; split at `| & ; ( ) newline backtick`) that names a store is blocked
     unless its program only looks at paths (`ls`, `stat`, `test`, `Test-Path`, `cd`, `git check-ignore`, ...)
     or is a registered consumer of that store (`gradle`/`gradlew`, `keytool`, `jarsigner`, `apksigner`,
     `bundletool`, `ssh`, `npm` for `.npmrc`, `wrangler`). Every other program - readers, copiers, encoders,
     archivers, uploaders, interpreters, `source` - is blocked without being listed. A segment with an output
     redirect is never safe. Folder and file named in separate words (`cd $GRADLE_USER_HOME && cat
     gradle.properties`, `Join-Path $env:GRADLE_USER_HOME 'gradle.properties'`) count as a mention;
   - environment printing: `env`/`printenv`/`set`/`export -p`/`declare -p` without arguments, PowerShell `env:`
     drive listings, `[Environment]::GetEnvironmentVariables()`, and printing a variable whose NAME looks secret
     (contains TOKEN, SECRET, PASSWORD, PASSWD, PASSPHRASE, CREDENTIAL, PRIVATE, APIKEY, ACCESSKEY, or has a `_` part
     KEY, PASS, PAT, PWD; `PWD`, `OLDPWD`, `TOKENIZERS_PARALLELISM`, `SSH_AUTH_SOCK`, ... are exempt) with echo,
     printf, Write-Host/Output, Get-Item env:X, a bare `$env:X`, or inline interpreter code (`os.environ['X']`,
     `process.env.X`, `print(os.environ)`). Using a variable as an argument (`curl -H "token $GH_TOKEN"`) stays
     allowed. False positives are accepted where a name matches the rule but holds no secret (`KEY_ALIAS` is listed
     as exempt; others can be added);
   - clipboard reads: `Get-Clipboard`/`gcb`, `pbpaste`, `wl-paste`, `xclip -o`, `xsel` without an input flag,
     `[Clipboard]::GetText`. Coreutils `paste` merges files and is not a clipboard reader;
   - tools that read their own credentials without printing them (`gradle`, `gh`, `wrangler`, `git`, `npm`) stay
     allowed because they do not name the store. `keytool -list -v` is allowed: it prints certificates and
     fingerprints (public data) and never a private key or password.
   Messages name the store and the safe command. Shell text that merely mentions a store is blocked too; such
   text goes into files with Edit/Write (document content is not inspected).
3. **One safe accessor**, `scripts/secret.js` (no dependencies): `keys <file>` (names), `public <file>` (values of
   keys the registry marks public, e.g. `org.gradle.*`), `check <key>@<file>` (present and length), `run --env
   NAME=<key>@<file> [--file NAME=...] -- <argv>` (no shell; values in the child environment or in a private
   temporary file; the child's stdout and stderr are masked: raw, URL-encoded, JSON-escaped, hex, base64 and base64url
   spellings, also mid-stream, and ambient secret-named variables; a value split across chunks is still masked),
   `clip <key>@<file>` (UTF-16 to `clip.exe`, prints only `copied`, clears after 45 s unless `--keep`), and `set
   <key>@<file>` (owner only: refuses without a terminal, hidden prompt or `--from-clipboard`, atomic write, prints
   nothing). File aliases come from the registry (`gradle`). The guard allows `secret.js` calls (their arguments
   may name any store, including `.secrets/`), checks the argv after `run --` as a segment of its own, and blocks
   `secret.js set` for agents.
4. **Output audit (defence in depth).** PostToolUse now runs for every tool (`matcher: *`). A result that contains
   secret-shaped text (GitHub `gh?_`/`github_pat_` tokens, private-key blocks, JWTs, AWS access keys, Slack, Stripe,
   `sk-` API keys, npm, GitLab, Google OAuth tokens, credentials in URLs, and `password=`-style assignments of a
   mixed value) appends a WARNING line with the kind and a 12-hex sha256 prefix, never the value, and tells the model
   on stderr (exit 2; the tool already ran) to stop, not repeat it, and alert the owner to rotate it. The audit
   log of edits redacts every secret-shaped substring before it stores the first 2000 characters; other tools are not
   logged. The PostToolUse hook cannot change what the model already saw, so prevention stays at PreToolUse.
5. **Settings deny rules** add a second, hook-independent layer for the unambiguous stores (`~/.gradle/
   gradle.properties`, keystores, `.env`, `.git-credentials`, `.netrc`, signing properties, `~/.ssh/id_*`, gh hosts).

### Edits through the Edit tool (owner order 2026-10-26)

Files are changed with the Edit tool (rg -n anchor, Read with offset/limit, Edit); Write is for new files and full
rewrites; a script is the tool for ONE mechanical change across 10+ files and carries the marker `mass-edit:
<reason>`. Enforced by `edit_rules.js` (reference `edit_guard.py`, parity-tested):

- inline interpreter code (`python -c`, `python - <<`, `node -e`, a heredoc into python/node/perl/ruby) whose text
  writes a file (`open(..., 'w')`, `.write_text(`, `.write(` except stdout/stderr, `writeFileSync`, `appendFile`,
  `createWriteStream`, Ruby `File.write`, Perl `open(..., '>')`, `fileinput` in place) and `perl -i`;
- a PowerShell command that writes (`Set-Content`, `Add-Content`, `Out-File`, `[IO.File]::WriteAll*`) and reads or
  replaces (`Get-Content`, `-replace`, `.Replace(`), or writes an existing file of a Git work tree;
- a heredoc whose command line redirects into an existing file of a Git work tree (`cat > AGENTS.md <<EOF`);
- a Write that creates a `.py/.js/.mjs/.cjs/.ts/.ps1/.pl/.rb` file outside any Git work tree whose text reads,
  replaces and writes files without the marker, and running such a script.

Ad hoc means outside version control: a script inside a Git work tree is reviewed with the diff, so repository
generators, build scripts and tests keep running unchanged. New files are still written with Write or a heredoc to
a new path.

## Consequences

- Hook cost: the PreToolUse dispatcher stays in the few-millisecond range (numbers in
  `skills/factory-fast-verification/references/tooling-performance.md` section 4); PostToolUse now starts one Node
  process for every tool, about the cost of the PreToolUse start, in exchange for the output audit.
- Agents use `node scripts/secret.js` for every secret need; the owner uses `clip` and `set`.
- Tuning 2026-10-26: the `password=`-style rule raised false positives on log lines and code (`token=hints_50_pending`,
  `purchaseToken = "fake-hints_50-token"`), so it now fires only when the key passes the guard's secret-name rule
  (or contains AUTH, ends in no descriptive word such as HINT/FILE/PATH) and the value is 8+ characters, not a literal,
  number, dotted reference or code identifier, has a letter and a digit or symbol, 6+ distinct characters and 2.5+
  bits of Shannon entropy per character; the token-shape detectors are unchanged (`secret_rules.js`/`.py`, tests in
  `tests/test_hook_dispatch.py` and `tests/test_posttool_audit.py`).
- Tuning 2026-10-29: every push through the gh credential helper (`-c "credential.helper=!gh auth git-credential"`) and
  every output that repeated the guard's own label (`assigned-secret:<hash>`) raised a warning. A key ending in HELPER
  is descriptive, and a key equal to one of the guard's finding kinds is never a secret; both cases sit in the
  ordinary-text corpus, and the test fixtures with human-style passwords are joined at run time so the test file does
  not read as a leak whenever an edit shows it.
- Two implementations exist (ADR-0027); `tests/test_hook_dispatch.py` holds the corpus of every rule with its
  expected verdict and random commands built from the new fragments.

### Known gaps (accepted, documented)

- Not a sandbox: a determined agent can write a script to a file that reads a store and run it, `cd` into a store
  folder and use a relative name the registry cannot know, or read a store through an unlisted alias. The
  output audit is the backstop for token-shaped values; plain passwords are only caught as `key=value` text.
- Grep over a folder whose non-ignored files include a store (e.g. a `local.properties` that Git does not ignore)
  reads it; rg honours `.gitignore`, which covers the conventional cases.
- `secret.js` is recognized by file name; a fake script of the same name would pass the guard.
- `run` masks complete values and their encodings, not substrings or transformations of a value.
- The clipboard keeps the value for 45 s (and in Windows clipboard history when it is on).
- The base hooks protect sessions whose project directory is this base; a session opened directly in another
  repository needs the same dispatcher in its own or the user-level settings.
