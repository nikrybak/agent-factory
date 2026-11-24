# Agent Operating Model

Agents are role-scoped workers. Skills are repeatable procedures. Hooks are deterministic controls.

## Normal task path

`feature-intake -> plan-orchestrate -> app-arch-required -> implementation-flow -> module-test-contract -> mandatory-test-gate -> docs-sync -> security/code review -> mandatory-quality-gate -> release-checkpoint`

## Do not

- Do not let implementation start before architecture for medium/large work.
- Do not let docs be postponed after code.
- Do not let tests become optional.
- Do not place every global skill content into CLAUDE.md.
