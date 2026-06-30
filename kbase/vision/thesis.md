---
id: vision-thesis
type: vision
status: authoritative
updated: 2026-06-30
applies_to: [whole-system]
related: [vision-control-hierarchy, vision-features, spec-tui, principle-gate-before-reifying, principle-unify-primary-and-supervisor, decision-0001-reify-plan-as-durable-graph]
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

## What Orca is, and how it works

Orca is an **independent agentic coding tool** — a harness in the lineage of
OpenCode or PI, not a layer on top of Claude Code, and **model-agnostic**: it can
drive different kinds of models, choosing per task rather than being bound to one
provider. Instead of planning work inside a context window and executing it
linearly, it **reifies the plan as a durable, self-modifying circuit** — a graph of
actions and typed edges in SQLite that runs asynchronously. The plan stops being
ephemeral thinking and becomes a first-class artifact you can pause, edit, resume,
and watch.

You drive it by talking. A conversational TUI ([[spec-tui]]) is both a normal chat
harness and a live view of the circuit; as you describe work, the agent decides
what is worth externalizing into the graph — a one-line tweak it just does; long,
parallel, or looping work it reifies ([[principle-gate-before-reifying]]) — and you
watch the nodes appear and execute. Orca runs as a daemon, not a script: the TUI
attaches and detaches, and the build keeps running.

It works as a control hierarchy ([[vision-control-hierarchy]]), cheap reflexes
first:

- **L0 — Actions execute.** A model-driven agent or a command does the work at a node.
- **L1 — Edges route deterministically.** `pass` / `fail` / `stuck` / `timeout` →
  instant, free, no model call. Common cases never cost a token.
- **L2 — A supervisor re-plans on unhandled failure**, mutating the graph to recover.
- **L3 — The primary agent + human.** Designs the circuit, fields new requests, and
  is pulled in when L2 is stuck.

The unification is that the primary agent and the supervisor are the *same kind of
thing* — a model whose tools are the graph-mutation API
([[principle-unify-primary-and-supervisor]]) — differing only in trigger and
altitude. Conversation, supervision, and execution are all an agent editing the
circuit from a position in it. Different tasks can run on different models (selected
automatically — see [[vision-features]]); governance keeps autonomy safe (validate
mutations, cap cost and graph size); and the whole thing ships as a single compiled
binary with no runtime dependency on any external harness
([[principle-no-runtime-deps]]). Throughout, the agent designs **circuits —
legible, finite, checkable graphs a human can steer — not opaque programs**
([[principle-legible-circuits-not-programs]]).
