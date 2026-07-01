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
| 1 | Conversational loop / TUI | partial | L3 agent + `POST /chat` non-blocking braid exist (`l3-agent.ts`, `server.ts`); TUI front-end is P6 (not yet built) |
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

## Remaining hazards / gaps

- **Scope is project-wide, not per-action.** Any plan to "parallelize disjoint
  write-scope" has nothing to compare until per-action scope exists. See
  [[open-question-per-action-scope-source]].
- **No TUI yet** (P6): the conversational braid + live circuit view is the last mile.
- **`add_action` deltas don't persist `project_id`** (the column is omitted from the
  `applyDelta` INSERT); L3/supervisor-created actions carry the `project:<id>` **tag**
  instead, which is what escalation scoping keys on.

## Next (roadmap)

P6 — the conversational TUI (Ink two-pane braid + live list-mode circuit) attaching
to `orca serve` over REST+SSE, detaching on quit while the build keeps running.
