---
id: decision-0005-layer-a-direct-provider-sdks
type: decision
status: accepted
updated: 2026-06-30
decided: 2026-06-30
applies_to: [engine, agent-runtime]
related: [spec-model-provider, decision-0004-independent-model-agnostic-harness, principle-no-runtime-deps, vision-features]
supersedes: []
---

# ADR 0005 — Layer A via direct provider SDKs behind ModelProvider

**Status:** accepted. Resolves the build-vs-adopt open design surface in
[[spec-model-provider]] (decided via a 3-lens design panel).

## Context

[[spec-model-provider]] left open how to implement Layer A (model inference): build
adapters directly, adopt a model-agnostic SDK (Vercel AI SDK), or route through a
hosted gateway (OpenRouter). A design panel evaluated four candidates against
Orca's constraints under three lenses (pragmatist, self-containment minimalist,
flexibility/longevity).

## Decision

Implement Layer A as **direct official provider SDKs** (`@anthropic-ai/sdk`,
`openai`), each confined to **one adapter file behind Orca's own `ModelProvider`
interface**, dispatched by model-id prefix (`anthropic/`, `openai/`). Adapters do
only "stream one turn + report raw token usage"; Orca owns Layer B (loop,
`can_use_tool` gate, sessions, structured-output validation, cost).

- Reuse the `openai` SDK with alternate `baseURL` to absorb OpenAI-compatible
  providers (Groq, Together, DeepSeek, vLLM, Ollama, OpenRouter, Gemini-compat) at
  near-zero new code.
- **Raw-fetch-first hybrid is permitted**: because lock-in is zero (same seam), it
  is legitimate to ship a hand-written raw-fetch adapter for a provider first and
  wrap it in the official SDK later wherever wire complexity earns it.
- A **hosted gateway is opt-in only** — a non-default extra adapter, never the
  floor. It fails the principle's spirit for a tool that runs on private repos.

## Why

Direct-sdks was the only candidate no judge ranked below second (pragmatist #1 8.5,
future-proofer #1 8.5, minimalist #2 8.4 behind raw-fetch's 8.7). Deciding factors:

- **Cost-accounting fidelity (hard requirement).** Adapters read raw per-token
  fields losslessly — Anthropic `cache_creation`/`cache_read`, OpenAI
  `prompt_tokens_details.cached_tokens` — straight into Orca's price table. The
  Vercel SDK buries cache-creation tokens behind per-provider `providerMetadata`;
  the gateway normalizes them away or returns marked-up pricing. This demotes both
  unified options.
- **Self-containment** ([[principle-no-runtime-deps]]). Both SDKs are pure-TS fetch
  clients (no native addons, no postinstall binaries, no daemon/CLI), so they
  `bun build --compile` into the single binary; the gateway is disqualified as
  default (latency, privacy, external point of failure).
- **Borrowed reliability for two bundled deps** vs. hand-maintaining SSE framing,
  429/529, backoff, and beta-header churn forever — worth it for the provider set.

Runner-up: **raw-fetch** (minimalist #1) — the *same architecture with the SDK
removed*, sharing the identical seam; the dissent is about literal dependency count,
not design.

## Consequences

- (+) Single self-contained bun binary; removes the `which claude` /
  `@anthropic-ai/claude-agent-sdk` dependency; forces Orca to own Layer B (the
  [[decision-0004-independent-model-agnostic-harness]] intent).
- (+) Lossless cost accounting; low, reversible lock-in (each SDK in one adapter
  file); near-free OpenAI-compatible provider expansion.
- (−) The "thin" adapter is not thin where providers diverge — see the spec's
  acceptance criteria for the specific taxes (tool-arg accumulation, message-shape
  translation, structured-output split, usage asymmetry).
- (−) Two SDK upgrade treadmills (OpenAI `chat.completions`→`responses`; Anthropic
  beta-header churn). Pin versions; keep each SDK inside exactly one adapter file so
  churn never reaches Layer B.
