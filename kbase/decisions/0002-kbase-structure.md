---
id: decision-0002-kbase-structure
type: decision
status: accepted
updated: 2026-06-30
decided: 2026-06-30
applies_to: [kbase, dev-process]
related: [principle-no-runtime-deps]
supersedes: []
---

# ADR 0002 — Knowledge base as markdown organized by epistemic status

**Status:** accepted.

## Context

Project knowledge lived in a few root markdown files (`circuit.md`,
`goal-features.md`, `todo.md`) that blurred decided invariants, aspirational goals,
exploratory brainstorms, and current-state description into single files. An agent
building Orca couldn't tell what was authoritative versus idea-space.

## Decision

Keep markdown (legible, git-native, agent-readable). Organize `kbase/` by
**epistemic status / authority** as the primary axis: `principles/`, `specs/`,
`decisions/` are authoritative; `vision/`, `explorations/`, `open-questions/` are
not to be built on blindly. Encode `status` in per-doc frontmatter — the one
distinction folders can't capture. Make it queryable with frontmatter + grep +
`INDEX.md`, with no database, honoring [[principle-no-runtime-deps]]. Wire it into
`CLAUDE.md` so every session consults it.

## Consequences

- (+) Agents read trust level at a glance; settled decisions aren't re-litigated;
  open questions aren't silently guessed.
- (+) Zero new dependencies or tooling.
- (−) Requires discipline: descriptive docs must be dated and code-linked, and
  resolved open questions must be promoted to ADRs, or the KB rots.
