# ADR-0022: Local GitHub Actions runners for the owner's private repositories

Date: 2026-10-07
Status: Accepted by owner decision, 2026-10-07

## Context

The owner's repositories are private and the account is on GitHub Free (no paid features, ever):
2,000 hosted Actions minutes a month with a $0 budget that stops Actions when they run out. In
October 2026 the limit was 90% used by the 7th, so CI would stop for three weeks. Self-hosted
runners use no minutes on any plan (a per-minute platform fee for them was announced for March
2026 and withdrawn). The owner chose this workstation as the runner host — CI runs at checkpoints
when local work is done, so the two do not compete — and asked for one central setup with as little
per-repository change as possible.

## Decision

1. **Central, not per repository.** `infra runners` (`cli/lib/runners.js`) supervises runners for
   every private, non-archived repository of the owner that has workflows, discovered through the
   GitHub API every 10 minutes. Public repositories never get one (pull requests from forks would
   run on this host). Machine settings are in `~/.infra-cache/runners.json` (owner, gh CLI path,
   runtime directory, slots, limits); tracked code holds no machine path or token.
2. **Routing through one repository variable.** A self-hosted runner never receives a job addressed to
   GitHub's own labels (`ubuntu-latest`, `ubuntu-24.04`): verified on 2026-10-07, a rerun went to a hosted VM
   while local runners with those labels were idle. Each routed job therefore reads
   `runs-on: ${{ fromJSON(vars.CI_RUNNER || '"ubuntu-24.04"') }}` (the fallback is the job's former label), a
   one-time edit per workflow. The supervisor sets the repository variable `CI_RUNNER` to
   `["self-hosted","infra-local"]` once that repository's runners are online, and `infra runners down`
   deletes it, which sends every job back to GitHub's VMs without touching a file. Runners also carry the
   hosted labels so a job naming them explicitly still matches. Release, deployment and promotion workflows
   that hold registry or production authority stay on GitHub-hosted runners in every repository (a clean
   GitHub VM per run is their isolation boundary; they are rare and fit the free minutes).
3. **Ephemeral just-in-time runners.** Each runner is registered for exactly one job
   (`generate-jitconfig`) and its container exits with the job; the supervisor replaces it at once.
   The registration goes to the container through its environment, never through argv or disk;
   the GitHub token never leaves the gh CLI. Runners left offline by a killed container are
   deregistered on discovery and by `infra runners down`.
4. **A slot is a pod.** Like ARC's dind mode, a slot is a runner container plus its own privileged
   Docker daemon (`docker:dind`). They share the network namespace — service containers answer on
   `localhost` exactly as on GitHub's VMs — and the work volume, so container jobs, `services:`,
   `docker compose` and `buildx` work. Daemons are never shared between slots; the runner itself is
   unprivileged. After every job the whole slot is recreated, as ARC recreates a pod: runner and daemon are
   removed with every container the job left behind, the work volume is emptied, and a fresh pair starts
   (verified necessary: in-place cleanup by the unprivileged runner left root-owned and still-mounted files
   that broke the next job's checkout).
5. **Slots follow demand.** Each repository keeps `minSlotsPerRepo` slots online (default 1, the minimum
   that keeps its jobs routable). Every `demandSeconds` (30) the supervisor counts jobs queued for
   `infra-local` and the runners busy with a job, and gives each repository one slot per waiting job up to
   `maxSlotsPerRepo` (3); extras are trimmed, largest repository first, to `maxSlots` (8, the host's cores)
   in total. A slot that ran a job or started within `idleMinutes` (5) is never removed, and busy runners are
   measured before any sizing, so a restarted supervisor does not cut a running job. Idle, the whole
   installation is one runner and one daemon per repository (about 60 MB each).
6. **Hosted-image parity where the workflows need it.** The image (`cli/runners/runner.Dockerfile`) is the
   official `ghcr.io/actions/actions-runner` plus build tools, compose, PostgreSQL client, JDK 17,
   rustup (stable with clippy and rustfmt at `~/.cargo`), and the Android SDK at the hosted path
   `/usr/local/lib/android/sdk`; `setup-*` actions install their versions into the tool cache as on
   GitHub. Versions are build arguments; `infra runners build` rebuilds it.
7. **Speed.** Per slot, the daemon's image and build cache, the tool cache and the Gradle home
   persist across jobs; the Cargo registry is shared by all slots. Workspaces and daemons start empty for every
   job. Each container is capped at `cpus` and `memory`. Daemon caches older than 72 hours are
   pruned daily. These caches hold only public packages and images of the owner's own private
   repositories, so keeping them across jobs is an accepted trade-off of speed against the strict
   one-job isolation of the workspace.
8. **Operation.** `infra runners build | up | down | status`; `install` registers a Windows logon task
   that starts the supervisor two minutes after logon (after Docker Desktop). The supervisor logs to
   `<runtimeDir>/runners.log` (rotated at 5 MB). `down` keeps the caches.

## Consequences

- CI is free and unlimited for the private repositories while this host is on. When it is off and the
  variable is set, jobs wait for a local runner (GitHub cancels a job queued for 24 hours); `infra runners
  down` hands them back to GitHub's VMs.
- Linux jobs run in Docker Desktop's VM, whose memory is capped in `.wslconfig` (ADR-0021 host tuning);
  heavy CI and heavy local work should not run at the same time, as the owner intends.
- The Unity job of Worlio still needs its Windows runner (`worlio-ephemeral` labels); it is outside
  this decision.
- A new job or repository joins by using the `runs-on` form above; repositories are discovered
  automatically. Jobs for other images (`windows-*`, `macos-*`) keep using hosted minutes.
- Per-repository records: Worlio ADR-0096, Billing Center ADR-0008, Player Center ADR-0019.
