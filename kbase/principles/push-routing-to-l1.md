---
id: principle-push-routing-to-l1
type: principle
status: authoritative
updated: 2026-06-30
applies_to: [executor, edges, supervisor, scheduler]
related: [vision-control-hierarchy, glossary]
---

# Push routing down to L1

Orca is a subsumption architecture — cheap reflexes first, expensive cognition
last (see [[vision-control-hierarchy]]). Every routing decision an LLM makes that a
deterministic edge condition could have made is wasted money and latency.

**Why:** the value of the circuit model is that common cases never touch an LLM. A
graph where the supervisor (L2) or primary agent (L3) fires on cases an L1 edge
could have handled is slower, costlier, and less legible.

**How to apply:** when adding control flow, ask "can a deterministic edge condition
express this?" before reaching for an agent-as-router. Maximize the reflex layer;
reserve L2/L3 for genuinely unhandled situations. The art of a good Orca graph is
maximizing L1.
