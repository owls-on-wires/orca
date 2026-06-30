---
id: glossary
type: reference
status: authoritative
updated: 2026-06-30
applies_to: [whole-system]
---

# Glossary

Shared vocabulary. Use these terms consistently so fresh-context agents stay
coherent (incoherent vocabulary is how parallel agents make locally-sane,
globally-inconsistent decisions).

- **Circuit** — the durable, self-modifying dataflow graph of actions and edges
  that *is* the plan. Lives in SQLite.
- **Loop** — a feedback cycle in the circuit (e.g. edit→evaluate→analyze→edit) that
  repeats until a closing condition is met, with an escape for when it stalls. A
  linear step is just a loop that runs once.
- **Loopcraft** — the agent's central skill: constructing the right loops for a goal
  (what each cycle does, what closes it, what escapes it) and wiring them into a
  circuit that reaches it. See [[vision-thesis]].
- **Action** — a node; an agent or command that does work (L0).
- **Edge** — a directed link between actions that routes on a condition.
- **Condition** — the fixed edge vocabulary today: `pass | fail | max_turns |
  timeout | cost_exceeded | stuck | error` (`schema.ts:5-12`).
- **GraphDelta** — the mutation API; how an agent edits the circuit
  (createTask / addEdge / attachSupervisor / validateGraph / …).
- **L0–L3** — the control hierarchy: action executes (L0) → edges route (L1) →
  supervisor re-plans (L2) → primary agent + human (L3). See
  [[vision-control-hierarchy]].
- **Reflex layer** — L1; deterministic routing that never touches an LLM.
- **Supervisor** — an L2 agent that mutates the graph to recover from unhandled
  failure.
- **Primary agent** — the L3 conversational agent; the same kind of thing as the
  supervisor (see [[principle-unify-primary-and-supervisor]]).
- **Ground plane** — a curated, persistent shared-context store injected into
  every action (missing piece #5).
- **Scope / writable globs** — the matcher (`scope/matcher.ts`) defining which
  paths an action may write; the basis for parallelizing disjoint write-scope.
- **Scope-aware scheduler** — the missing concurrent executor that runs
  non-conflicting actions in parallel ("the big one", piece #2).
- **scopesConflict** — proposed pure predicate: do two actions' write-scopes
  overlap?
- **Computed goto / agent-as-router** — a routing primitive where an agent node
  emits *which* successor to activate (missing piece #6).
- **Lazy expansion** — growing the graph as it learns (emit the next sprint's
  subgraph only when the prior one passes) rather than building all nodes up front.
- **DRC (design-rule check)** — a graph-validation pass (no cycles, all reachable,
  bounded size, every failure handled) run before committing a mutation.
- **Circuit-breaker** — global governance: total cost ceiling, max graph size, max
  supervisor mutations per region.
