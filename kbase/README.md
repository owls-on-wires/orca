---
id: readme
type: reference
status: authoritative
updated: 2026-06-30
---

# kbase — how to use this knowledge base

Reference material for building Orca: goals, principles, requirements, decisions,
and open design questions. Markdown only; queryable with `grep` and the manifest
in [`INDEX.md`](./INDEX.md). No database, by design — see
[[principle-no-runtime-deps]].

## Read this first, while building

Start at `INDEX.md`. Before designing or changing a subsystem, check the relevant
`principles/`, `specs/`, `architecture/`, and `open-questions/` docs for it.

## Authority / epistemic status

The primary axis of this KB is *how much you should trust a doc.* It is encoded in
each doc's frontmatter `status`:

| status | meaning | build on it? |
|--------|---------|--------------|
| `authoritative` | settled invariant / direction | yes |
| `accepted` | a decided ADR | yes — don't re-litigate |
| `proposed` | suggested, not yet decided | only after promoting to a spec/ADR |
| `descriptive` | how the code works *now* | yes, but verify against code first |
| `open` | unresolved question | no — resolve it (write an ADR) before relying |
| `exploratory` | brainstorm | no — ideas only |
| `superseded` | replaced | no — follow the pointer to the successor |

Folders carry the *type*; frontmatter carries the *status* (a `spec` can be
`proposed` or `authoritative`, so status can't live in the folder name).

## Frontmatter schema

```yaml
---
id: <kebab-id>            # stable; cite it elsewhere as [[id]]
type: principle | vision | spec | decision | architecture | open-question | reference
status: authoritative | accepted | proposed | descriptive | open | exploratory | superseded
updated: YYYY-MM-DD
applies_to: [subsystem, ...]   # answers "what does the KB say about X I'm building?"
related: [id, ...]             # cross-links
---
```

The query engine is just grep over frontmatter plus `INDEX.md`:

```bash
grep -rl "status: authoritative" kbase/        # everything you must respect
grep -rl "applies_to:.*scheduler" kbase/       # everything about the scheduler
grep -rl "type: open-question" kbase/          # unresolved forks
```

## Lifecycle (what keeps the KB alive)

- **open-question → decision.** When a fork is resolved, add an ADR in
  `decisions/` and flip the question's `status` to `superseded` with a pointer to
  the ADR. This is the KB's heartbeat — it stops settled choices from being
  re-argued.
- **proposed → spec.** Promote a vision/feature into `specs/` once it has concrete
  acceptance criteria.
- **freshness.** `architecture/` docs are dated and link the code they describe.
  If you change that code, update the doc — a stale descriptive doc is worse than
  none.

## Adding a doc

1. Pick the folder by type; write frontmatter with a stable `id` and an honest
   `status`.
2. Add a one-line entry to `INDEX.md`.
3. Link related docs with `[[id]]`.
