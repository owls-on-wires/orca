---
id: index
type: reference
status: authoritative
updated: 2026-06-30
---

# kbase index

**[`roadmap.md`](./roadmap.md)** — phased plan from current state to a first working
version, with a runnable verification gate per phase (proposed).


Manifest of the knowledge base — one line per doc. Trust level by `status`:
`authoritative` / `accepted` > `proposed` > `descriptive` / `open` / `exploratory`.
This file can be regenerated from doc frontmatter. See [`README.md`](./README.md)
for conventions.

## Principles (authoritative — non-negotiable)
- `principles/no-runtime-deps.md` — single compiled binary; no Python / runtime deps.
- `principles/push-routing-to-l1.md` — maximize the deterministic reflex layer.
- `principles/legible-circuits-not-programs.md` — keep the graph statically checkable.
- `principles/unify-primary-and-supervisor.md` — one graph-mutating agent, two triggers.
- `principles/gate-before-reifying.md` — only externalize long / parallel / looping work.

## Vision (direction)
- `vision/thesis.md` — build the machine, don't just plan (authoritative).
- `vision/control-hierarchy.md` — the L0–L3 escalation ladder (authoritative).
- `vision/cloud-native-execution.md` — local-vs-cloud placement as a decision (proposed).
- `vision/features.md` — target feature set (proposed).

## Decisions — ADRs (settled; don't re-litigate)
- `decisions/0001-reify-plan-as-durable-graph.md` — the circuit architecture.
- `decisions/0002-kbase-structure.md` — this knowledge base's own design.
- `decisions/0003-tui-first-ui-substrate.md` — TUI first; web/multiplexer deferred.
- `decisions/0004-independent-model-agnostic-harness.md` — independent, model-agnostic; drop Claude Code dependency.
- `decisions/0005-layer-a-direct-provider-sdks.md` — Layer A via direct provider SDKs (build, not adopt).

## Architecture (descriptive — verify against code)
- `architecture/current-state.md` — orca v2 vs. the six missing pieces (as of 2026-06-30).

## Specs (decided requirements)
- `specs/eval-harness.md` — prompt-in/software-out fixture eval: `orca build` + headless `claude -p` judge → scored rubric.
- `specs/model-provider.md` — model-agnostic agent runtime; drop Claude Code (ADR-0004 keystone).
- `specs/tui.md` — conversational TUI with live circuit view (piece #1).
- `specs/README.md` — what goes here and how specs are promoted.

## Open questions (unresolved — don't guess)
- `open-questions/per-action-scope-source.md` — blocks the scheduler.
- `open-questions/concurrency-isolation-model.md` — in-process vs. git worktrees.
- `open-questions/computed-goto-representation.md` — string id vs. new condition.
- `open-questions/primary-agent-node-or-controller.md` — graph node vs. controller.
- `open-questions/definition-of-done-daemon.md` — daemon, not script.
- `open-questions/routing-expressiveness-limit.md` — where the graph DSL stops.

## Explorations (non-authoritative)
- `explorations/circuit.md` — the original circuit design brainstorm.

## Reference
- `glossary.md` — shared vocabulary.
- `README.md` — how to use and extend this KB.
