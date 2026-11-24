# ADR-0001: Claude Code IT Infrastructure Contract

Date: 2026-06-25
Status: Accepted

## Context

The project requires a reusable enterprise-style Claude Code infrastructure with agents, skills, gates, hooks, memory, docs, CI, and plugin/MCP integration.

## Decision

Use repository-local `.claude/agents`, `.claude/skills`, `.claude/settings.json`, deterministic hooks, app-architecture docs, ADR, tasks, and universal quality gate scripts.

## Consequences

All medium/large work must pass architecture, tests, docs, security/review gates before completion. Commit/push/release commands are blocked until quality gate PASS.
