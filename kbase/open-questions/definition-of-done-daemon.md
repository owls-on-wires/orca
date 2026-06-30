---
id: open-question-definition-of-done-daemon
type: open-question
status: open
updated: 2026-06-30
applies_to: [cli, lifecycle, primary-agent]
related: [open-question-primary-agent-node-or-controller]
---

# What is "done" with a conversational front-end?

With a conversational head there is no single terminal state — the executor goes
*idle* and the agent says "standing by." Orca becomes a **daemon, not a script**:
`orca run` probably doesn't exit, it attaches/detaches. Affects the CLI / `serve`
lifecycle and what `status` and exit codes mean.
