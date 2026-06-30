---
id: architecture-current-state
type: architecture
status: descriptive
updated: 2026-06-30
as_of: 2026-06-30
applies_to: [executor, scope, supervisor, graph-ops, api]
related: [open-question-per-action-scope-source, open-question-concurrency-isolation-model]
sources:
  - packages/server/src/v2/executor.ts
  - packages/server/src/scope/matcher.ts
  - packages/server/src/v2/supervisor.ts
  - packages/server/src/v2/graph-ops.ts
---

# Current state of orca v2 (as of 2026-06-30)

**Descriptive, not prescriptive.** This snapshots how the code works *today* and
rots fastest of any doc here — verify against the cited files before relying on a
line number. Derived from a read-only scout of the v2 sources.

## What exists (the "motor system")

SQLite-backed action/edge graph, GraphDelta mutation API, supervisor-on-failure
escalation, scope glob matching, pause/resume, SSE streaming, and a REST surface
designed for an LLM to drive (`v2/docs/llms.txt`).

## Status against the six missing pieces (from `explorations/circuit.md`)

| # | Piece | Status | Evidence |
|---|-------|--------|----------|
| 1 | Conversational loop / TUI | absent | `v2/server.ts` REST-only; `cli.ts` stateless dispatch; no REPL |
| 2 | Scope-aware scheduler | partial | Serial: `executor.ts:110` picks one action, `:173` races one. Scope is project-wide (`executor.ts:156`), not per-action |
| 3 | Gating (act vs. delegate) | partial | Everything routes through the graph; no act-directly decision point |
| 4 | Governance (DRC + breaker) | partial | `validateGraph` (`graph-ops.ts:136-196`) misses cycles/reachability/size; budget per-task only (`executor.ts:321-336`); supervisor applies deltas with no post-validation + a silent catch (`supervisor.ts:180-187`) |
| 5 | Ground-plane context store | absent | Only immediate predecessor outputs injected; no shared spec/decisions doc |
| 6 | Computed-goto routing | absent | `EdgeCondition` is a fixed 7-value enum (`schema.ts:5-12`) |

## Hazards live today

- **Supervisor mutates the graph unvalidated.** `supervisor.ts:180-187` applies
  deltas with no `validateGraph` and a silent empty catch — the "planner fails
  unsupervised" risk is real now.
- **Scope is project-wide, not per-action** (`executor.ts:156`). Any plan to
  "parallelize disjoint write-scope" has nothing to compare until per-action scope
  exists. See [[open-question-per-action-scope-source]].

## Baseline health

Builds clean; ~703 tests pass with ~19 pre-existing failures (4 git "master vs
main" env issues + 15 flaky v2 server/live-agent tests) that predate current work.

## Suggested build order (from scout synthesis)

Supervisor DRC (validate + rollback) → global circuit-breaker → per-action scope +
`scopesConflict` predicate → concurrent scope-aware scheduler → computed-goto
routing → conversational loop. Rationale: **govern before you parallelize; decide
scope before you schedule.**
