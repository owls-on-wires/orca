---
id: open-question-computed-goto-representation
type: open-question
status: open
updated: 2026-06-30
applies_to: [edges, routing]
related: [principle-legible-circuits-not-programs, open-question-routing-expressiveness-limit]
---

# How should computed-goto / agent-as-router be represented?

Control loops often need >2-way branching (improved / regressed / converged /
diverged) that `pass | fail` can't express. Two representations:

- an agent node emits a **string successor id** ("computed goto"), or
- invent a new dynamic `EdgeCondition` value.

Constrained by [[principle-legible-circuits-not-programs]]: whatever is chosen must
keep the graph statically checkable. This is the tactical half of
[[open-question-routing-expressiveness-limit]].
