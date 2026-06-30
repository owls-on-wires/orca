---
id: principle-legible-circuits-not-programs
type: principle
status: authoritative
updated: 2026-06-30
applies_to: [edges, routing, graph-language]
related: [open-question-routing-expressiveness-limit, open-question-computed-goto-representation]
---

# Circuits, not programs

The agent designs *circuits* — legible, finite, checkable graphs — not *programs*.
Resist the slippery slope: conditions → computed goto → guards-and-variables on
edges → a Turing-complete workflow DSL nobody can analyze.

**Why:** the legibility of the circuit is what lets a human steer it mid-flight. A
graph you can't read by hand is as unsteerable as a context window you can't read.
Analyzability is a feature, kept on purpose.

**How to apply:** every increase in routing expressiveness must preserve static
checkability (cycle / reachability / DRC analysis stays possible). When in doubt,
keep the edge vocabulary small and push richness into agent *nodes*, not edge
*semantics*. See [[open-question-routing-expressiveness-limit]].
