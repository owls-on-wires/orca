---
id: decision-0003-tui-first-ui-substrate
type: decision
status: accepted
updated: 2026-06-30
decided: 2026-06-30
applies_to: [tui, ui, primary-agent]
related: [spec-tui, principle-no-runtime-deps, open-question-definition-of-done-daemon]
supersedes: []
---

# ADR 0003 — TUI first as the UI substrate (web / multiplexer deferred)

**Status:** accepted.

## Context

Orca needs a front-end (circuit.md missing piece #1) that is both a conversational
harness and a live view of the running circuit. A further requirement is that the
agent can modify the interface at runtime. Three substrates were weighed: a web SPA,
a terminal UI (TUI), and a multiplexer (tmux-style). The unifying frame is that
substrate is just a *renderer* of a declarative UI model the agent edits — so the
choice is about which renderer to build first, not a permanent commitment.

Trade-offs:

- **Web** — richest widgets + dynamic layout + remote/cloud-native, but requires a
  browser and bundled assets; heavier to start.
- **TUI** — best fit for [[principle-no-runtime-deps]] and lives where developers
  already are; lower widget ceiling, harder dynamic layout.
- **Multiplexer (tmux)** — a pane *is* a running program (native fit for "agent runs
  a program, shows its output"), with process isolation and detach/persistence for
  free, but it's a runtime dependency, weak on Windows, and keeps UI state outside
  Orca's SQLite.

## Decision

Build a **TUI first**. Defer web and multiplexer renderers. The TUI is a thin client
of the `orca serve` daemon (attach/detach), with a conversational pane and a live
circuit pane. See [[spec-tui]] for the design and acceptance criteria.

## Consequences

- (+) Stays within [[principle-no-runtime-deps]]; fastest path to a usable harness
  for terminal-centric development.
- (+) The attach/detach client model exercises and validates the daemon direction
  ([[open-question-definition-of-done-daemon]]) early.
- (−) Lower widget ceiling than web; large-DAG rendering must degrade to list +
  collapse rather than a full graph drawing.
- (−) Runtime self-modification of the interface is scoped down for now — revisit a
  declarative UI model + additional renderers (web / multiplexer) when richer,
  agent-authored panels are needed. This ADR is the point to reopen then.
