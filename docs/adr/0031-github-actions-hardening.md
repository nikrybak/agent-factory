# ADR-0031: GitHub Actions hardening against pull-request secret theft

- Status: Accepted
- Date: 2026-11-13
- Decider: owner ("надо обезопасить на максимум")

## Context

A mass attack on GitHub repositories used harmless-looking pull requests to run a script inside GitHub Actions that collected
tokens, deploy keys and cloud keys, then deleted the changes and run logs. Our audit the same day found no foreign pull request,
run or collaborator in any of 26 repositories, but found two weak points in the site deploy: actions on moving tags, and a deploy
key written to `~/.ssh` of the runner (the owner's PC when the local runners are up), overwriting the owner's `known_hosts`

## Decision

The rules of `docs/operations/GITHUB-SECURITY.md` are binding for every repository: code, secrets and runners only in private
repositories; no secret-bearing trigger and no self-hosted runner on a public repository; actions pinned to commit SHAs;
`persist-credentials: false`; read-only workflow token; secrets only in the step that needs them, key files in a per-job folder
removed on exit; job timeouts; secret scanning with push protection on public repositories; deploy keys rotated every 90 days
by script, add-before-delete

Done 2026-11-13: site deploy workflow hardened (nrgames-site dcdf979, actions v7 by SHA in the next commit), deploy key rotated and proved by two green deploys (`scripts/rotate-deploy-key.mjs`),
secret scanning and push protection turned on for `NR-Games/mahjong-packs`

## Consequences

- A moving action tag can no longer change the code that runs with our keys; a SHA bump is a reviewed commit
- A stolen site key can only rewrite the public site, and it is short-lived; nothing else of ours is reachable from a public repository
- The audit list in the operations doc is rerun after any GitHub incident and before a release
