---
id: spec-tui
type: spec
status: authoritative
updated: 2026-06-30
applies_to: [tui, primary-agent, api, executor]
related: [vision-thesis, vision-control-hierarchy, principle-no-runtime-deps, principle-unify-primary-and-supervisor, principle-gate-before-reifying, open-question-definition-of-done-daemon, architecture-current-state]
---

# Spec: Conversational TUI with live circuit view

The default front-end for Orca (circuit.md missing piece #1). A terminal UI that
is **both** a conversational harness and a live view of the running circuit.
Decision: TUI first (web/multiplexer deferred) — keeps us inside
[[principle-no-runtime-deps]].

## Core concept

Two views of one system, tightly coupled:

- **Conversation = narration & control.** The user talks to the L3 primary agent;
  the system narrates progress and escalations here.
- **Circuit = state & telemetry.** The durable action/edge graph, live.

Because the agent's tools *are* graph mutations
([[principle-unify-primary-and-supervisor]]), a conversational request that reifies
work shows a **circuit-edit card** in the transcript *and* updates the circuit pane
in the same instant. Converse to mutate; watch the mutation land.

## Architectural requirements

- **Thin client of the `orca serve` daemon.** The TUI attaches over the existing
  REST + SSE surface and **detaches on quit — the build keeps running**. This is
  [[open-question-definition-of-done-daemon]] resolved for the UI. `orca` with no
  daemon running auto-starts one, so UX stays "just run orca."
- **Grows a circuit from a plain chat.** Before work is reified it's a full-width
  harness; when the agent gates work into the graph ([[principle-gate-before-reifying]])
  the circuit pane appears and claims space.
- **Input never blocks on the executor.** Actions stream while the user types — the
  decoupling of [[vision-thesis]] made literal.

## Layout (adaptive)

Wide terminals: three regions — conversation + input (left); circuit (top-right)
over node-detail (bottom-right). Top bar: build identity, live action counts, cost
**and burn rate**, elapsed. Bottom bar: contextual keybindings. Narrow terminals
(<~100 cols): tabbed (Chat ⇄ Circuit). `Ctrl+L` = focus-mode (expand active pane).

```
┌ orca · saas-app ───────────────── ●running  12/47  $4.21  $0.38/min  08:14 ┐
│ CONVERSATION                       │ CIRCUIT  [list]  layer▾    ⊟ collapse✓ │
│ › build a SaaS app from spec.md    │ ✓ plan/spec        pass  0:42  $0.11   │
│ ⠋ Decomposed into 4 epics…         │ ├─◐ task/login-ui  run   0:31  $0.08 ⠹ │
│   ▸ circuit edit: +4 epics +18     │ ├─⚠ task/schema    stuck 3×  →superv.  │
│                                    │ ───────────────────────────────────── │
│ ┌────────────────────────────────┐ │ DETAIL · task/schema                  │
│ │ › also add dark mode_          │ │ command · bun test · stuck (3 fails)  │
│ └────────────────────────────────┘ │ [p]ause [x]abort [r]erun [s]upervisor │
└ /focus /graph /cost · F2 pause · F9 abort · q detach (build keeps running) ─┘
```

## Region requirements

**Conversation pane.** Streaming transcript (markdown→ANSI); input box with history
+ slash commands; tool calls render as collapsible graph-mutation cards (not raw
JSON); L2/L3 escalations narrate here while the circuit flags the node.

**Circuit pane.** A terminal can't draw a large DAG legibly, and
[[principle-legible-circuits-not-programs]] says degrade rather than try:
- **List-as-default** (scales to hundreds). Row: `glyph · id · name · state ·
  duration · cost · current-tool`. Glyphs: `○`pending `◐`running `✓`pass `✕`fail
  `⊘`blocked `⏸`paused `⚠`stuck. Group/sort by topological layer | status | recency.
- Topology via tree connectors (`├─ │ └─`) from `depends_on`.
- `g` toggles an ASCII graph view, but only for circuits under ~30 nodes; above
  that, stay a list and prompt `/focus` on a subgraph.
- Scale: virtualized rows, collapse completed subgraphs to one line, redraw
  throttled (~15fps) by coalescing SSE events.

**Detail pane (selected node).** Header (id, type, template, model, status, cost,
duration, turns); tabbed body (log tail | edges+conditions | params/prompt |
predecessor outputs); per-node steer (`p`/`x`/`r`/`s`).

## Interaction model

`Tab` moves focus between panes (own keymap each). Global: `F1` help · `F2` pause
build · `F9` abort · `Ctrl+L` focus-mode · `q` detach. Command palette in the input
serves both chat and control (`/focus`, `/graph`, `/cost`, `/pause`, `/resume`).
Structural edits happen by **talking** (the agent mutates the graph); the human does
tactical steering by key. No direct graph editing in the TUI — that's the model.

## Implementation notes

- Framework: **Ink** (React-for-CLI) for the chat + panes; a **custom raw-ANSI
  component** for the circuit canvas. Compiles into the bun binary. Respect
  `NO_COLOR` and degrade on non-truecolor terminals.
- The TUI is an SSE consumer; it must coalesce events, cap redraws, and virtualize
  for the big-DAG case (see [[architecture-current-state]] for the serial executor
  it observes today).

## Acceptance criteria (by MVP slice)

1. **Read-only shell.** Two-pane shell attaches to a running `orca serve` over SSE;
   chat transcript streams on the left, list-mode circuit (live status/cost) on the
   right; top/bottom bars render. Quitting detaches without stopping the build.
2. **Conversational control.** Input box sends messages to the L3 agent; agent
   graph-mutations render as circuit-edit cards in the transcript and update the
   circuit pane within one redraw cycle.
3. **Inspect.** `↑↓`+`Enter` select a node; detail pane shows its streaming log
   tail and in/out edges with conditions.
4. **Graph + steer.** `g` graph-mode (≤30 nodes), completed-subgraph collapse,
   row virtualization, and per-node `p`/`x`/`r` against the daemon.

## Open design surface

- List-vs-graph default and the collapse/roll-up model for the big-DAG archetype.
- Whether the detail pane's log tail reuses the action's L0 transcript verbatim or a
  summarized view.
