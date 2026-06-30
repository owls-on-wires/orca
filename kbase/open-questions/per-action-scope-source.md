---
id: open-question-per-action-scope-source
type: open-question
status: open
updated: 2026-06-30
applies_to: [scope, scheduler]
related: [open-question-concurrency-isolation-model, architecture-current-state]
blocks: [scope-aware-scheduler]
---

# Where do per-action write scopes come from?

Scope is project-wide today (`executor.ts:156` resolves one ScopeConfig per
project), so the scheduler's "parallelize disjoint write-scope" plan has nothing to
compare. Before the concurrent scheduler is buildable, decide the source of
per-action write scopes:

- `action.params.scope` (the author declares it), or
- template-derived scopes, or
- git-worktree-per-branch isolation (physical, not logical — see
  [[open-question-concurrency-isolation-model]]).

**Blocks:** the concurrent scope-aware scheduler. Resolve into an ADR before
building piece #2.
