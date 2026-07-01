---
id: vision-context-as-graph
type: vision
status: proposed
updated: 2026-07-01
applies_to: [l3-agent, executor, memory, context, ground-plane]
related: [vision-thesis, vision-control-hierarchy, principle-unify-primary-and-supervisor, principle-legible-circuits-not-programs, principle-gate-before-reifying, open-question-primary-agent-node-or-controller, architecture-current-state]
---

# Context is graph state; planners author it

**There is no separate memory subsystem.** Context is graph state — a task's `prompt`
(context-in), its output (context-out), the edges that carry outputs downstream, and a
shared ground plane — all of it mutated by tasks. "Memory," "context assembly," and
"planning" collapse into the one primitive Orca already has: a task with edges that can
mutate the circuit. Some tasks' job is simply to shape *other tasks' context*.

## The problem this dissolves

A normal agent's memory is trivial because it is single-threaded: one linear
transcript, append every message, feed the window. Orca breaks that on purpose — one
message reifies a circuit of concurrent tasks across topics (UI, API), each emitting
into the braid; the planner interprets, mutates, and its turn ends. There is no window
to append to and no single "conversation." Bolting sessions/threads back on is a trap:
what you have is **multi-threaded memory**, and the job is context assembly for a
(mostly) stateless planner over a concurrent, multi-topic work graph.

## A task's effective context = three graph-native channels

1. **Authored** — a planner writes the task's `prompt` (grounded by recon; below).
2. **Edge-carried** — a predecessor's output flows in (`PredecessorOutput`, already exists).
3. **Shared** — a curated **ground plane** (durable decisions/spec, circuit.md piece #5)
   the task *references* at run time.

The prompt cannot be the *only* channel: if planners copy shared facts into every
prompt you get bloat and O(N) rewrites when a shared fact changes. So keep per-task
prompts **specific** and put global facts in the ground plane, **referenced** not
copied. Planners control context on both axes — per-task prompt *and* ground plane —
and both are just mutations, so the single-primitive model holds.

## Planners observe read-only, act by mutation

The planner's tools split cleanly:
- **Observe** — read-only recon (`ls`, `grep`, `git`, a query, an HTTP probe). This is
  how a planner *reads* the graph and the workspace to ground its plan.
- **Act** — graph mutations only, including **authoring/updating other tasks' prompts**
  and **writing the ground plane**.

So [[principle-unify-primary-and-supervisor]] survives intact — the planner still *acts*
only by editing the circuit; recon is *seeing*, not *doing*. **Recon is the memory write
path**: discovery tasks populate the ground plane. The ground plane stops being magic and
becomes the accumulated, provenance-tagged output of discovery.

(First step already shipped: the static WORKSPACE CONTEXT block injected into the L3
turn — see [[architecture-current-state]]. That is the cheap *seed*; agentic recon is
the adaptive layer on top. They compose; the seed bottoms out the recursion.)

## Context binding is lazy → discover → plan → build, fractally

A task's context is not frozen at creation — it can be updated until the task **runs**
(the "no mutating a running action" invariant is exactly the freeze). So: **wire
topology early, bind context late.** This yields a `recon → plan → build` cascade — a
planner recons, then authors the subgraph with grounded prompts — and it composes at
every level: any subgraph task can itself recon → plan → expand. The circuit **grows as
it learns**, which is circuit.md's lazy expansion, delivered by one primitive.

This leans the [[open-question-primary-agent-node-or-controller]] fork toward
**planner-as-node**: reify recon and plan as durable nodes and the discovery + the
plan-reasoning become inspectable graph artifacts — you can later see *why* a task was
wired as it was.

## The legibility rail (non-negotiable)

Tasks rewriting tasks' prompts is **computed context** — the graph writing itself. Left
unchecked it slides toward an opaque self-modifying program, violating
[[principle-legible-circuits-not-programs]]. Two rails, both using machinery we have:
- **Provenance on every prompt** — who authored it, from which recon, in which turn — so
  a human/supervisor can see and correct a task's context.
- **Governance on context mutations** — extend the P4 `applyValidatedDelta` DRC
  chokepoint to validate/log prompt rewrites (e.g. a context-size cap; no overwriting a
  running task's frozen context).

With those, computed context stays a *legible circuit*.

## How it answers the original problem

An interleaved UI/API message becomes a **planner task whose recon reads the relevant
region** of the graph and authors grounded prompts. The planner for a UI message recons
the UI subgraph; the API message recons the API subgraph. No threads, no sessions — the
graph *is* the memory, regions (goals) are the "threads," and recon is how a planner
locates and reads the right one. Gate it: [[principle-gate-before-reifying]] applies to
context too — don't recon a one-line change.

## Open dials (the core is settled; these are knobs)

- **Prompt vs. ground plane** — how much task context lives in the per-task prompt
  (specific, cheap to change) vs. the shared ground plane (global, avoids O(N) rewrites).
- **Governance strictness** — a context-size circuit-breaker? how hard to police
  prompt rewrites before it impedes useful metaprogramming.
- **Late-binding default** — opt-in per task, or the default for planner-authored tasks.
- **Separate `recon` + `plan` nodes** (reusable, cacheable, invalidatable) vs. a single
  planner node that recons internally (simpler). Leaning separate.
- **Cache invalidation** — recon artifacts are snapshots; the build mutates the codebase
  under them. Provenance-based staleness detection vs. just re-reconning each goal fresh.
  This is the genuinely hard part.

## Implementation is mostly additive

The mutation primitives exist (`add_action`/`update_action` with a `prompt`). What is
new: (1) give the planner **read-only recon tools** alongside `apply_graph_edits` (today
`includeBuiltinTools:false` — pure mutation); (2) a **ground-plane store** the executor
injects into task contexts at run time; (3) **prompt provenance + context-mutation
governance** on the DRC chokepoint; (4) **late-binding** semantics (update a pending
task's prompt; freeze on run).
