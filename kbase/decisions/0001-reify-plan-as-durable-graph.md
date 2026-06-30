---
id: decision-0001-reify-plan-as-durable-graph
type: decision
status: accepted
updated: 2026-06-30
decided: 2026-06-30
applies_to: [whole-system]
related: [vision-thesis]
supersedes: []
---

# ADR 0001 — Reify the plan as a durable, self-modifying SQLite graph

**Status:** accepted (foundational; already implemented in v2).

## Context

Context-window-bound harnesses keep the plan implicit, execute linearly, and
discard subagents. That blocks long-horizon autonomy, resumability, parallelism,
and mid-flight steerability.

## Decision

Represent the plan as a durable dataflow graph of actions and typed edges in
SQLite, mutated through a GraphDelta API and executed asynchronously. The plan is a
first-class artifact: pausable, editable, resumable, watchable.

## Consequences

- (+) The four target properties (see [[vision-thesis]]) become achievable.
- (+) Resume is "reload the graph from the db."
- (−) Introduces a governance burden — a bad graph now fails autonomously, for
  hours, spending real money. Mitigated by DRC + circuit-breaker, both still
  partial; see [[architecture-current-state]].
- (−) Concurrency over a shared filesystem becomes the central hazard; see
  [[open-question-concurrency-isolation-model]].
