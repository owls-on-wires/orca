---
id: principle-unify-primary-and-supervisor
type: principle
status: authoritative
updated: 2026-06-30
applies_to: [supervisor, primary-agent, api]
related: [open-question-primary-agent-node-or-controller, vision-control-hierarchy]
---

# The agent is a position in the circuit

The primary conversational agent and the failure-triggered supervisor are the same
kind of thing: an LLM whose toolset is the graph-mutation API
(createTask / addEdge / attachSupervisor / validateGraph / …). They differ only in
trigger (human prompt vs. failure edge) and altitude (whole graph vs. a failing
region).

**Why:** this collapses three apparent subsystems — conversation, supervision, task
execution — into one uniform thing: an agent editing the circuit while standing at
a position in it. The motor system (REST + GraphDelta) already exists; what's
missing is the head, not a new kind of component.

**How to apply:** don't build the conversational loop and the supervisor as
separate stacks. Build one graph-mutating agent loop, parameterized by trigger and
scope. Open fork: is that agent a node in the graph or an external controller? See
[[open-question-primary-agent-node-or-controller]].
