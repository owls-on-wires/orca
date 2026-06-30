---
id: decision-0004-independent-model-agnostic-harness
type: decision
status: accepted
updated: 2026-06-30
decided: 2026-06-30
applies_to: [whole-system, engine, agent-runtime, primary-agent]
related: [vision-thesis, vision-features, architecture-current-state, principle-no-runtime-deps]
supersedes: []
---

# ADR 0004 — Orca is an independent, model-agnostic harness

**Status:** accepted (direction; not yet reflected in the code — see Consequences).

## Context

Orca was conceived and built as an orchestrator *for Claude Code agents*: the
engine resolves the Claude Code executable from PATH and drives it through
`@anthropic-ai/claude-agent-sdk` (`packages/server/src/engine/invoke.ts:62,100`;
the dependency in `package.json` and `packages/server/package.json`). Docs framed
Orca as a "Claude Code plugin" (`docs/DIRECTION.md`).

We are changing direction. Orca should be a standalone agentic coding tool in the
lineage of OpenCode or PI — its own harness, not a layer on top of another one —
and **model-agnostic**, able to drive different kinds of models and pick the right
one per task rather than being bound to a single provider.

## Decision

Orca is an **independent, model-agnostic harness**. It does not depend on Claude
Code (or any external harness) at runtime. The agent runtime is restructured around
a **model-provider abstraction**: a stable internal interface for "run an agent
turn" / "call a model with tools", with provider adapters behind it, so a circuit's
actions can each run on a different model. Automatic per-task model selection
([[vision-features]]) is built on this abstraction.

## Consequences

- (+) Reinforces [[principle-no-runtime-deps]]: no external CLI must be installed;
  Orca is genuinely self-contained.
- (+) Different tasks run on different models — the basis for cost/quality routing.
- (−) **This is a migration, not a rename.** Replacing the Claude Code executable
  resolution + `@anthropic-ai/claude-agent-sdk` with a provider abstraction is real
  work; until it lands, the implementation still depends on Claude Code (tracked in
  [[architecture-current-state]]). Vision (this ADR + [[vision-thesis]]) leads;
  current-state trails.
- (−) Tool-use, streaming, and budget/cost accounting must be normalized across
  providers (their APIs differ), and the harness owns the agent loop that the SDK
  previously owned.
- Supersedes the "Claude Code plugin" framing in `docs/DIRECTION.md`. Front-door
  docs (`README.md`, `CLAUDE.md`, `.claude-plugin/plugin.json`, `cli.ts` banner)
  still describe the Claude-Code-based reality and should be updated only as the
  code changes, not before.
