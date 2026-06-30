---
id: specs-readme
type: reference
status: authoritative
updated: 2026-06-30
---

# specs/

Decided, testable requirements, one doc per subsystem. A spec carries concrete
acceptance criteria and `status: authoritative` once committed. Promote items here
from [[vision-features]] as they are decided, and from resolved
[[architecture-current-state]] build-order slices.

Current specs:

- [[spec-tui]] — the conversational TUI with a live circuit view (circuit.md piece #1).

Another strong near-term candidate is the **Supervisor DRC** slice (post-mutation
graph validation + mutation/size budget with rollback) — the lowest-risk, unblocked
backend starting point identified in [[architecture-current-state]].
