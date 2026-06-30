---
id: spec-model-provider
type: spec
status: authoritative
updated: 2026-06-30
applies_to: [engine, agent-runtime, executor, supervisor]
related: [decision-0004-independent-model-agnostic-harness, vision-features, vision-thesis, principle-no-runtime-deps, architecture-current-state]
---

# Spec: Model-provider abstraction

The keystone of [[decision-0004-independent-model-agnostic-harness]]. Make Orca's
agent runtime model-agnostic and independent of Claude Code, so a circuit's actions
can each run on a different model/provider, selected per task.

## The seam already exists

Every agent action in Orca goes through `invoke()` / `invokeSimple()`
(`packages/server/src/engine/invoke.ts`). Its public surface — `InvokeOptions` in,
`AsyncGenerator<InvokeEvent>` out, `InvokeResult` at the end — is already
provider-neutral and is the right boundary. **Keep this signature stable; replace
its guts.** Callers (action-runner, supervisor) must not change.

## The hard truth: this is two layers, not one

Today `@anthropic-ai/claude-agent-sdk`'s `query()` (`invoke.ts:100,193`) does far
more than call a model — it owns the entire **agent loop**: tool execution, file
edits, bash, turn management, sessions, structured output. Becoming independent
means Orca takes over that loop and abstracts only inference beneath it.

- **Layer A — Model inference (provider-specific, swappable).** Given a message
  history + tool schemas, return the model's next turn (text + tool calls) plus
  token usage. This is what a `ModelProvider` adapter implements (Anthropic Messages
  API, OpenAI-family, etc.).
- **Layer B — Agent loop (Orca-owned, provider-independent).** The turn loop that
  calls Layer A, executes tool calls against Orca's own tool registry, enforces
  scope, manages context/sessions, honors `maxTurns`, produces structured output,
  and emits `InvokeEvent`s. The SDK gives this for free today; Orca must build it.

The model-provider abstraction is Layer A; the bulk of the *work* is Layer B.

## Layer A — the `ModelProvider` interface

A provider adapter must implement roughly:

- `id` / supported model ids (provider-prefixed, e.g. `anthropic/claude-opus-4-8`,
  `openai/...`).
- `stream(messages, tools, opts) -> AsyncIterable<ModelDelta>` — a single model turn:
  streamed text, tool-call requests, and a final `Usage { inputTokens, outputTokens,
  … }`. No tool *execution* here — the provider only reports what the model wants to
  call.
- Capability flags: native structured-output support, parallel tool calls, max
  context, vision, etc. (so Layer B can adapt or degrade).

Shared type vocabulary (provider-neutral): `ModelMessage`, `ToolSchema`,
`ToolCall`, `ModelDelta`, `Usage`.

## What Orca must now own (Layer B)

- **The turn loop** — call provider → if tool calls, execute them → append results →
  repeat until the model stops or `maxTurns`. Replaces `query()`'s internal loop.
- **A built-in tool registry** — read/edit/write/bash/etc. as Orca's own tools
  (not Claude Code's), keyed by `toolset` like `TOOLSETS` today (`invoke.ts:150`).
- **Scope enforcement** — reuse `checkToolUse` (`invoke.ts:138`) as a gate in the
  tool-execution step; the `can_use_tool` mechanism becomes an internal hook.
- **Sessions / context** — Orca persists conversation state (the SDK's `resume`/
  `sessionId`, `invoke.ts:168`). Store it durably (SQLite) — consistent with
  everything-in-SQLite and the runtime-data goal.
- **Structured output** — normalize across providers (Anthropic tool/`structured_output`
  vs OpenAI `response_format: json_schema`); preserve the current contract that
  `InvokeResult.output` is the validated object or `null` (`invoke.ts:250`).
- **Cost accounting** — compute `costUsd` from `Usage` × a per-model price table
  (the SDK supplied `total_cost_usd`, `invoke.ts:221`; Orca now owns the math).
- **System prompt** — replace the `preset: "claude_code"` append
  (`invoke.ts:116-120`) with Orca's own base prompt; drop
  `settingSources: ["user","project","local"]` (`invoke.ts:171`, Claude Code
  settings) in favor of `.orca` declarative settings.

## Model selection

`InvokeOptions.model` becomes a provider-prefixed id resolved to an adapter. Per-task
selection — and eventually automatic selection ([[vision-features]]) — sets it per
action; a circuit can mix models. A small registry maps id → provider + price +
capabilities.

## Migration strategy (strangler, behind the stable seam)

1. **Define the interface; wrap the SDK.** Introduce `ModelProvider` + the shared
   types; refactor `invoke()` to drive a provider through it, with the existing
   Claude-SDK path as the first adapter (`ClaudeCodeProvider`). No behavior change.
2. **Orca-owned loop + direct Anthropic inference.** Build Layer B (turn loop, tool
   registry, sessions, cost) and an `AnthropicProvider` that calls the Messages API
   directly — no `claude` executable, no `findClaudeExecutable()` (`invoke.ts:58`).
3. **Second provider.** Add a non-Anthropic adapter (OpenAI-family) to force the
   abstraction honest — two real implementations, not one dressed up.
4. **Cut the dependency.** Wire per-task/automatic selection; remove
   `@anthropic-ai/claude-agent-sdk` (both `package.json`s) and the executable
   resolution; update front-door docs (per [[decision-0004-independent-model-agnostic-harness]]).

## Acceptance criteria (by slice)

1. `ModelProvider` interface + shared types exist; `invoke()` drives a provider
   through them with the Claude-SDK path as adapter #1. Signature of `invoke()` /
   `invokeSimple()` unchanged; full server suite passes (no regression past the
   ~703 baseline in [[architecture-current-state]]).
2. An agent action completes a multi-turn, tool-using run via the Orca-owned loop +
   `AnthropicProvider`, **with no `claude` binary on PATH**; scope violations still
   deny; `InvokeResult` (output, cost, turns) is populated; structured output
   validates.
3. The same action runs unchanged on a second provider via a provider-prefixed
   model id; cost is computed from token usage for both.
4. `@anthropic-ai/claude-agent-sdk` and `findClaudeExecutable()` are gone; a circuit
   runs two actions on two different models in one build.

## Non-goals

Changing the executor's serial/scheduler behavior (separate track), the circuit
model, or the REST/SSE surface. This spec is strictly the agent-runtime substrate.

## Open design surface

- **Build vs adopt the inference layer.** Implement provider adapters directly, or
  adopt a model-agnostic inference SDK (e.g. Vercel AI SDK) as Layer A while Orca
  keeps Layer B? Either is compatible with [[principle-no-runtime-deps]] (bundled
  lib, not an external harness) — decide and record as an ADR.
- **Session/context representation** that survives restart and resume.
- **Tool-call & structured-output parity** across providers with different native
  capabilities (normalize vs degrade).
