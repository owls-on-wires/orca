---
id: open-question-concurrency-isolation-model
type: open-question
status: open
updated: 2026-06-30
applies_to: [scheduler, filesystem]
related: [open-question-per-action-scope-source, vision-thesis]
---

# In-process concurrency vs. git worktrees

Two agents editing `src/` at once corrupts the build — the central hazard of the
whole vision. Two isolation models:

- **In-process** `Promise.all` over a shared filesystem, guarded by a
  `scopesConflict` predicate. Cheap, but relies entirely on scope correctness.
- **Git worktree per branch.** Heavier setup + disk, but physically isolates
  writes.

Determines how much the scope predicate alone can protect, and how much setup the
scheduler pays per parallel action. Coupled to
[[open-question-per-action-scope-source]].
