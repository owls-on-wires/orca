---
id: open-question-primary-agent-node-or-controller
type: open-question
status: open
updated: 2026-06-30
applies_to: [primary-agent, executor]
related: [principle-unify-primary-and-supervisor, open-question-definition-of-done-daemon]
---

# Is the primary agent a node in the graph, or outside it?

- **A node** (an always-present, human-attached action): conversation,
  supervision, and task execution become positions in one uniform graph — elegant,
  makes resume trivial — but complicates idle/termination logic.
- **Outside**: a privileged controller.

`explorations/circuit.md` leans toward "it's a node." Decides resume semantics and
the shape of the conversational-loop work.
