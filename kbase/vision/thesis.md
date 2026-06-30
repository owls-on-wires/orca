---
id: vision-thesis
type: vision
status: authoritative
updated: 2026-06-30
applies_to: [whole-system]
related: [vision-control-hierarchy, principle-gate-before-reifying, decision-0001-reify-plan-as-durable-graph]
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
