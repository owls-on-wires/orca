---
id: vision-control-hierarchy
type: vision
status: authoritative
updated: 2026-06-30
applies_to: [executor, edges, supervisor, primary-agent]
related: [principle-push-routing-to-l1, principle-unify-primary-and-supervisor]
---

# The control hierarchy (L0–L3)

The spine of Orca is an escalation ladder — subsumption architecture, cheap
reflexes first, expensive cognition last.

- **L0 — Action executes.** An agent or command does work.
- **L1 — Edges route on condition.** `pass` / `fail` / `stuck` / `timeout` /
  `max_turns` → deterministic, instant, free. The spinal cord; common cases never
  touch an LLM.
- **L2 — Supervisor agent re-plans on unhandled failure.** Slow, costs tokens,
  fires only when L1 has no answer. Mutates the graph (GraphDelta) to recover —
  autonomic recovery.
- **L3 — Primary conversational agent + human.** Strategic. Designs the initial
  graph, fields new commands, reports, gets pulled in when L2 is stuck.

The discipline that falls out of this ladder is [[principle-push-routing-to-l1]]:
maximize the reflex layer. The consequence at the top is
[[principle-unify-primary-and-supervisor]]: L2 and L3 are the same kind of agent at
different altitudes.
