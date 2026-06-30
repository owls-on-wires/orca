---
id: vision-thesis
type: vision
status: authoritative
updated: 2026-06-30
applies_to: [whole-system]
related: [vision-control-hierarchy, vision-features, vision-cloud-native-execution, spec-tui, principle-unify-primary-and-supervisor, principle-legible-circuits-not-programs, principle-no-runtime-deps, decision-0001-reify-plan-as-durable-graph]
---

# Thesis: build the machine, don't just plan

The difference Orca chases is between *an agent that plans* and *an agent that
builds a machine that does the work and watches it run.*

Most harnesses plan implicitly: the plan lives in the context window, execution is
linear, and subagents are ephemeral — spawned, consumed, forgotten. Orca
**reifies the plan as a durable, self-modifying dataflow graph** in SQLite that
executes asynchronously. The plan becomes a first-class artifact you can pause,
edit, resume, and watch; the agent's "thinking" and the work's "doing" decouple in
time, so the conversational agent stays responsive while its hands (the graph) keep
working.

That decoupling buys four things, and everything in Orca is in service of one of
them — or is a threat to one:

- **long-horizon autonomy**
- **resumability**
- **parallelism**
- **human steerability mid-flight**

When weighing any design choice, ask which of these four it advances and which it
threatens.

## What Orca is

Orca is an agentic coding harness that doesn't just *plan* work — it **builds a
machine that does the work and watches it run.** Instead of holding a plan in a chat
window and executing it step by step, Orca turns the plan into a **circuit**: a
durable graph of actions and typed edges, stored on disk, that executes
asynchronously. The plan becomes a real artifact you can pause, edit, resume, and
watch — and because thinking and doing are decoupled, you stay in conversation while
the work runs underneath you.

**Model-agnostic.** Orca drives different models from different providers and picks
the right one per task — a cheap model for a quick edit, a frontier model for hard
reasoning — with cost tracked precisely across all of them (see [[vision-features]]).
It ships as a single self-contained binary ([[principle-no-runtime-deps]]).

**A conversational TUI over a live circuit.** You drive Orca by talking. The
interface is a chat and a live view of the circuit side by side. The conversation is
a **non-blocking braid** ([[spec-tui]]): you keep typing while work proceeds, and
messages stream in from every agent at once — the one you're talking to, the
supervisors recovering from failures, and the individual task agents reporting
progress. Each task decides how loud to be: narrate every step, or run silently and
just update the graph. Nothing blocks your input.

**A daemon, not a script.** Orca runs detached — close the terminal and reattach
later; the build keeps going. And because it's **cloud-native**
([[vision-cloud-native-execution]]), *where* a task runs is itself a decision: a
quick edit runs locally, a multi-hour build or a long-running scraper gets pushed to
a cloud VPS. When the right place is obvious, Orca decides; when it isn't, it asks.

## Loopcraft

A circuit is not a to-do list, and it is not a one-shot DAG of tasks. At its core it
is a **set of loops** — edit→evaluate→analyze→edit until a benchmark is hit, retry
until a test passes, generate→critique→refine until quality converges. The straight
"do A then B" path is just a loop that runs once. The interesting work — the work a
linear plan literally cannot express — lives in feedback cycles that converge on a
goal and know when to stop.

So the agent's central skill is **loopcraft**: given a goal, *construct the right
loops* — what each cycle does, which condition closes it, and what escapes it when it
stalls — then wire them into a circuit that reaches the goal. Designing those loops,
and the deterministic edges that govern them, is what it means to build a machine
rather than to follow a plan. The agent is judged not on a single answer but on the
quality of the machine it assembles.

## How the work flows

Cheap reflexes first, expensive thinking last ([[vision-control-hierarchy]]):

- **Actions** do the work — a model-driven agent or a command at each node.
- **Edges** route the outcome deterministically — `pass` / `fail` / `stuck` /
  `timeout` — instantly and for free, so common paths never burn a model call. These
  edges are also what close and escape the loops.
- **Supervisors** step in only when something fails in a way the edges can't handle,
  rewriting the graph to recover on their own.
- **You** sit at the top — describing goals, steering mid-flight, pulled in only when
  a supervisor is genuinely stuck.

The agent you talk to and the supervisors that recover from failure are the same kind
of thing — an agent whose tools edit the circuit
([[principle-unify-primary-and-supervisor]]) — working at different altitudes.
Governance keeps the autonomy safe (every graph mutation validated; total cost and
size capped), and the system stays **legible**: you are always looking at a circuit
you can read and steer, never an opaque program
([[principle-legible-circuits-not-programs]]).
