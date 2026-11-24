# Session Starter

The starter is a read-only context bootstrap used before intake.

1. Load `AGENTS.md` and generated-file boundaries.
2. Inventory canonical roles, skills, plugins, and available tools.
3. Read memory, checkpoints, current sprint, backlog, and done log.
4. Compare integrations declared in `agents.json` with capabilities reachable in the session.
5. Detect the target stack, runtimes, package managers, CI, deployment, and risk signals from evidence.
6. Return READY or READY WITH GAPS and proceed to `feature-intake`.

The starter never installs tools, connects new services, edits files, or assumes a stack.
