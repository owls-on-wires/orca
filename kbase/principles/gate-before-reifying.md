---
id: principle-gate-before-reifying
type: principle
status: authoritative
updated: 2026-06-30
applies_to: [primary-agent, gating]
related: [vision-thesis]
---

# Gate before reifying

The primary agent is not a pure orchestrator. It is a normal agent that *also* can
externalize work into the graph — but only when the work is (a) long-running,
(b) parallelizable, or (c) iterative/looping. Below that bar, it just does the
thing directly.

**Why:** if a one-line CSS tweak spins up a planner and a task graph, you've built
something *worse* than a plain agent. Get the gate wrong toward "always delegate"
and the product feels like bureaucracy.

**How to apply:** treat "is this worth reifying into a circuit?" as an explicit
decision point, not an assumption. Note the dual failure: complex-but-not-separable
work (one tangled module) often beats a graph with a single focused agent. The
three archetypes that motivate this gate are worked through in
`explorations/circuit.md`.
