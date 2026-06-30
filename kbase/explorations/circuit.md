---
id: exploration-circuit
type: exploration
status: exploratory
updated: 2026-06-30
applies_to: [whole-system]
related: [vision-thesis, vision-control-hierarchy]
---

> **Exploratory brainstorm — not authoritative.** Settled ideas from this doc have
> been promoted to `kbase/principles/`, `kbase/vision/`, and
> `kbase/open-questions/`. Treat anything here that isn't promoted as idea-space,
> not a spec. This remains the canonical narrative; the promoted docs are the
> citeable, trust-bearing version.

# Orca as a Circuit — Design Brainstorm

A conversational harness that designs, runs, and supervises a durable task graph.

## The thesis

The difference between *an agent that plans* and *an agent that builds a machine
that does the work and watches it run.*

Most harnesses (Claude Code included) plan implicitly: the plan lives in the
context window, execution is linear, and subagents are ephemeral — spawned,
consumed, forgotten. This model **reifies the plan as a durable, self-modifying
dataflow graph** that lives in SQLite and executes asynchronously. The plan
becomes a first-class artifact you can pause, edit, resume, and watch — and the
agent's "thinking" and the work's "doing" are decoupled in time. The
conversational agent stays responsive because its hands (the graph) keep working
while its head moves on.

That decoupling buys four things that are awkward in a context-window-bound
harness:

- long-horizon autonomy
- resumability
- parallelism
- human steerability mid-flight

Everything below is in service of those four, or a threat to them.

## The organizing idea: a control hierarchy

"The supervising agent can be invoked by edges" is not a feature — it's the
spine. Generalize it into an escalation ladder: cheap reflexes first, expensive
cognition last.

- **L0 — Action executes.** Agent or command does work.
- **L1 — Edges route on condition.** `pass`/`fail`/`stuck`/`timeout`/`max_turns`
  → deterministic, instant, free. The spinal cord. Common cases never touch an LLM.
- **L2 — Supervisor agent re-plans on unhandled failure.** Slow, costs tokens,
  fires only when L1 has no answer. Mutates the graph (`GraphDelta`) to recover.
  Autonomic recovery.
- **L3 — Primary conversational agent + human.** Strategic. Designs the initial
  graph, fields new commands, reports, gets pulled in when L2 is stuck.

This is subsumption architecture. The design discipline: **push as much routing
as possible down to L1.** Every decision an LLM makes that a deterministic edge
could have made is wasted money and latency. The art of a good Orca graph is
maximizing the reflex layer.

Consequence: **the primary agent and the supervisor are the same kind of thing**
— an LLM whose toolset is the graph-mutation API. They differ only in trigger
(human prompt vs. failure edge) and altitude (whole graph vs. a failing region).
Unify them: *an agent that edits the circuit while standing at a particular
position in it.*

## Dogfooding observation

`v2/docs/llms.txt` is documentation **written for an LLM to operate Orca.** The
REST API + `GraphDelta` + templates were already designed for an agent consumer.
So the "primary conversational agent" is not a new subsystem — it's an LLM loop
whose tools are `createTask / addEdge / attachSupervisor / validateGraph /
queryStatus / pause / abort`, which map almost 1:1 onto endpoints that already
exist. The motor system is built. What's missing is the head (conversational loop
+ TUI), concurrency, and governance.

## Three archetypes, and the principle each exposes

### 1. CSS change — the degenerate case, and the most dangerous one

The graph is overhead here. If a one-line tweak spins up a planner, you've built
something *worse* than Claude Code. The make-or-break decision is **gating**: "is
this worth reifying?" Opinion: the primary agent is not a pure orchestrator. It's
a normal agent that *also* can externalize work into the graph when the work is
(a) long-running, (b) parallelizable, or (c) iterative/looping. Below that bar it
just does the thing. Get the gate wrong toward "always delegate" and the product
feels like bureaucracy.

### 2. SaaS-from-spec — the big DAG, where the model earns its keep

spec → epics → sprints → tasks, each task a `tdd` template instance, wired by
`depends_on` (diamond fan-in already handled). Hundreds of actions, days of
runtime. Two non-obvious requirements:

- **Lazy expansion.** Don't build all 200 nodes up front — assumptions about
  sprint 5 are stale before sprint 1 finishes. A `plan` node emits the *next*
  sprint's subgraph only when the prior sprint passes (dynamic tasking). The
  graph grows as it learns.
- **This case demands concurrency** or the DAG structure is decorative.

### 3. Optimize via edit/eval/analyze — the cyclic control loop

The thing a TODO list literally cannot represent.

```
edit(agent) ──pass──▶ eval(cmd: bench) ──▶ analyze(agent) ──pass──▶ edit   (feedback)
                                                          └──fail──▶ done
edit ──stuck──▶ supervisor          (same edit 3× → escalate)
```

`analyze` is a *learned controller* with a termination criterion. This surfaces a
real limitation: **the edge-condition vocabulary is small and fixed**
(`pass|fail|stuck|timeout|cost_exceeded|max_turns|error`). "Benchmark improved
but didn't hit target" is not in that set. Two ways to route richer outcomes:

- a **command parser** (`parsers/`) that classifies output into existing conditions, or
- an **agent-as-router**: the `analyze` node makes the judgment and its output
  selects the edge.

Deep fork: **deterministic routers (conditions) vs. learned routers (agent nodes
that decide where to go).** The flexible version is a "computed goto" — an agent
node that emits *which successor to activate*. Worth deciding whether to add that
primitive, because control loops with >2-way branching are common
(improved/regressed/converged/diverged) and pass/fail can't express them without
contortion.

## Where this breaks — the honest list

- **Concurrency vs. the filesystem is the central hazard.** The executor today is
  *serial*. The vision requires at least the conversational agent concurrent with
  the executor, and the SaaS case requires parallel DAG branches. Two agents
  editing `src/` at once corrupts the build. Fix: a **scope-aware scheduler** —
  edges define *logical* order, `writable` globs (`scope/matcher.ts`) define
  *physical* conflict; parallelize disjoint write-scope, serialize overlapping.
  Git worktrees per branch are the heavier alternative. This is the single
  biggest gap between current v2 and the vision.

- **The planner is the weakest link, and now it fails unsupervised.** Graph
  quality = output quality. A bad decomposition builds the wrong thing
  *efficiently, autonomously, for hours, spending real money.* Mitigations: a
  **validation / design-rule-check pass** before committing a graph (no cycle
  lacks a `stuck`/budget escape; every failure condition has a handler or routes
  to a supervisor; no orphans; deps satisfiable). Show the user the plan before
  the expensive part.

- **Cost runaway is structural.** Loops + supervisors-that-add-nodes + parallelism
  multiply. Per-action budgets aren't enough — need a **global circuit-breaker**:
  total cost ceiling, max graph size, max supervisor-induced mutations per region.
  Surface *burn rate*, not just total.

- **Context coherence degrades at scale.** 200 agents with fresh contexts make
  locally-sane, globally-inconsistent decisions. Edges carry local handoffs
  (`PredecessorOutput`); you also need a **ground plane**: a curated, persistent
  "decisions/spec" doc injected into every action's context, maintained by the
  primary agent. Too much shared context = expensive and confused; too little =
  incoherent. Not solved by the graph; where ambitious autonomous builds rot.

- **Live graph surgery is fiddly.** "Also add dark mode" mid-build forces the
  primary agent to distinguish *new independent goal* (append subgraph) vs.
  *modify in-flight* (mutate) vs. *interrupt* (pause/abort), without corrupting a
  `running` action. Invariants: can't delete a running action (abort first), can
  append downstream freely, mutations to running actions queue until they yield.
  The `history` table makes it auditable — log every delta with its cause.

- **The DAG is a bet that the problem decomposes.** Graphs help when work is
  *separable*. A lot of engineering pain lives in one irreducibly tangled module,
  where the graph adds coordination overhead without parallelism payoff. The gate
  at archetype-1 should also catch "complex but not separable — one focused agent
  beats a graph."

## What exists vs. what's missing

**Already there:** actions/edges/conditions, `GraphDelta`, db-backed durable
state (→ resume), supervisor-on-unhandled-failure, SSE streaming, `pause`/`resume`,
scope globs, an API designed for an LLM to drive.

**Missing for the vision:**

1. the conversational loop + TUI front-end
2. a **concurrent, scope-aware scheduler** (the big one)
3. **gating logic** — act-directly vs. delegate-to-graph
4. **governance** — graph DRC validation + global circuit-breaker
5. a **ground-plane context store**
6. probably a richer routing primitive (computed-goto / agent-as-router) for
   control loops

## Open questions

1. **Is the primary agent a node in the graph, or outside it?** If a node (an
   always-present, human-attached action), then conversation, supervision, and
   task execution are all positions in one uniform graph — elegant, makes resume
   trivial, but complicates idle/termination logic. If outside, it's a privileged
   controller. Leaning toward "it's a node."

2. **What's "done"?** With a conversational front-end there's no single terminal
   state — the executor goes *idle* (`onIdle`) and the agent says "standing by."
   Orca becomes a **daemon, not a script.** `orca run` probably doesn't exit — it
   attaches/detaches.

3. **How expressive does routing get before the graph becomes a programming
   language?** Slippery slope: "conditions" → "computed goto" → "guards and
   variables on edges" → a Turing-complete workflow DSL nobody can analyze. Draw
   the line so the agent designs *circuits* (legible, finite, checkable) rather
   than *programs*. The legibility of the circuit is what lets a human steer it —
   keep it analyzable on purpose.
