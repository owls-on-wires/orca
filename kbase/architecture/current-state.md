---
id: architecture-current-state
type: architecture
status: descriptive
updated: 2026-07-01
as_of: 2026-07-01
applies_to: [executor, scope, supervisor, graph-ops, api, l3-agent, model-provider]
related: [open-question-per-action-scope-source, open-question-concurrency-isolation-model, spec-model-provider, spec-tui]
sources:
  - packages/server/src/v2/executor.ts
  - packages/server/src/scope/matcher.ts
  - packages/server/src/v2/supervisor.ts
  - packages/server/src/v2/graph-ops.ts
  - packages/server/src/v2/l3-agent.ts
  - packages/server/src/engine/agent-loop.ts
  - packages/server/src/models/registry.ts
---

# Current state of orca v2 (as of 2026-07-01, through roadmap P5)

**Descriptive, not prescriptive.** This snapshots how the code works *today* and
rots fastest of any doc here — verify against the cited files before relying on a
line number. Updated as the roadmap phases land (P1–P5 committed on `orca-v1`).

## What exists (the "motor system")

SQLite-backed action/edge graph, GraphDelta mutation API, supervisor-on-failure
escalation, scope glob matching, pause/resume, SSE streaming, and a REST surface
designed for an LLM to drive (`v2/docs/llms.txt`). On top of the motor sits Orca's
**own model-agnostic agent stack** (P1–P3) and a **conversational L3 primary agent**
(P5).

## Model-agnostic harness (P1–P3, done)

The Claude Code dependency is **gone**. The agent runtime is Orca's own:
- **Layer A** — `models/` `ModelProvider` adapters (`anthropic.ts`, `openai.ts`)
  behind a `registry.ts` that maps a model id → provider + price + capabilities.
- **Layer B** — `engine/agent-loop.ts` owns the turn loop (stream → execute tools →
  repeat), structured-output finalization, durable sessions, and cost-from-raw-usage.
  `engine/invoke.ts` is the stable neutral seam the rest of Orca calls through.
- No `claude` binary, no `@anthropic-ai/claude-agent-sdk` in either manifest; the
  model id selects the provider (≥1 Anthropic + ≥1 OpenAI proven in one build).

## L3 primary agent (P5, done)

`v2/l3-agent.ts` is the conversational front door. Its **tools ARE graph mutations**:
a single injected `apply_graph_edits` batch tool (via `agent-loop.ts` `customTools`,
built-in file/bash tools excluded) that routes every mutation through the P4
`applyValidatedDelta` chokepoint — it **cannot** commit an invalid or unbounded
circuit. A loopcraft system prompt steers it to reify a build→test→route-back loop
with a back-edge, an escape condition, and a `max_iterations` cap. `POST /chat`
(`v2/server.ts`) runs a turn **non-blocking**: the POST returns `202` immediately and
narration arrives as SSE (`l3_message` / `graph_edit` / `l3_result`), reusing
`broadcast()`.

## Status against the six missing pieces (from `explorations/circuit.md`)

| # | Piece | Status | Evidence |
|---|-------|--------|----------|
| 1 | Conversational loop / TUI | done | L3 agent + `POST /chat` non-blocking braid (`l3-agent.ts`, `server.ts`); Ink two-pane TUI (`packages/tui`) attaches over REST+SSE, detaches on quit while the build keeps running |
| 2 | Scope-aware scheduler | partial | Serial: `executor.ts` picks one action, races one. Scope is project-wide, not per-action |
| 3 | Gating (act vs. delegate) | partial | Everything routes through the graph; no act-directly decision point |
| 4 | Governance (DRC + breaker) | done | `validateGraph` does cycle-legality (Tarjan SCC + escape), reachability, size caps; `applyValidatedDelta` validates-then-commits/rolls-back with an `invalid_mutation` event; global circuit-breaker in `executor.ts` caps cost + graph size and emits `unhandled_failure` |
| 5 | Ground-plane context store | absent | Only immediate predecessor outputs injected; no shared spec/decisions doc |
| 6 | Computed-goto routing | absent | `EdgeCondition` is a fixed 7-value enum (`schema.ts:5-12`) |

## Governance (P4, done)

- `graph-ops.ts` `applyValidatedDelta()` is the single governed chokepoint used by
  **both** the L2 supervisor and the L3 agent: it computes pre-existing issues,
  applies the batch in a transaction, re-validates, and ROLLBACKs (recording an
  `invalid_mutation` history event) if the batch introduces new issues or throws.
- `validateGraph()` distinguishes a **legal loop** (a cyclic SCC with an escape:
  either an edge leaving the component, or a member with no outgoing `pass` edge so a
  pass terminates it) from an **illegal unbounded cycle**, plus reachability, dead-end,
  dangling-edge, and size-cap checks.
- The executor's global **circuit-breaker** caps total cost and graph size.

## Conversational TUI (P6, done)

`packages/tui` is the default front-end — an Ink two-pane shell (conversation/braid
left, live list-mode circuit + node detail right; top bar with counts/cost/burn/
elapsed, bottom bar keybindings) that **compiles into a bun binary**. It is a thin
client: it attaches to the daemon over REST + SSE and **detaches on quit while the
build keeps running** (the daemon owns all build state; the TUI drops the SSE
connection and exits). The store (`tui/src/store.ts`) is a pure reducer over SSE
events — a `graph_edit` event renders a circuit-edit card in the braid AND updates
the circuit pane in the same tick, so a chat request that reifies work is visible in
both views at once. Redraws are coalesced (~15fps). `orca` auto-starts a daemon if
none is reachable.

## Remaining hazards / gaps

- **Scope is project-wide, not per-action.** Any plan to "parallelize disjoint
  write-scope" has nothing to compare until per-action scope exists. See
  [[open-question-per-action-scope-source]].
- **`add_action` deltas persist `project_id`** (fixed) — the `applyDelta` INSERT and
  the `graph-ops.test` schema were both missing the column, so L3/supervisor-created
  actions ran unscoped (server cwd, default model) instead of resolving their
  project's cwd/model/scope. Surfaced by the first prompt-in fixture eval.
- **Inline-executor SSE wiring is caller-supplied.** The worker path broadcasts
  action events automatically; an in-process `Executor` (test/embedded) must wire its
  callbacks to `broadcast()` itself (see `tui-detach.test.ts`).

## Status: first working version reached (P1–P6)

Launch `orca` (TUI) → converse with the L3 agent in a non-blocking braid → it reifies
a durable, governed **looping** circuit → the executor runs it on a model chosen per
task, over Orca's own agent loop, with **no `claude` binary and no Claude Code SDK** →
the build runs under `orca serve` and survives TUI detach. Post-1.0 (still out):
concurrent scheduling, per-action scope, computed-goto routing, web multiplexer.
