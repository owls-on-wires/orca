# Orca Graph Rendering — Design Document

> Living document. Started 2026-05-08.

## Overview

The graph is the central visualization of Orca's UI. It renders the action DAG
as a layered (Sugiyama-style) drawing: columns represent dependency depth,
rows represent parallel lanes. The graph is interactive — nodes are selectable,
edges highlight on hover, and the layout updates live as actions complete or
the graph is modified.

## Visual Design

### Node design

Nodes are solid filled circles (radius 11px). Color is driven entirely by
status — there are no internal glyphs or symbols. The dot alone communicates
state. Action type (agent vs command) is shown in the detail panel when
selected, not on the node itself.

| Status | Fill | Stroke | Notes |
|--------|------|--------|-------|
| completed | success (solid) | success | Solid dot — work is done |
| running | accent (solid) | accent | Pulsing ring animation (2.4s ease-out infinite) |
| failed | danger (solid) | danger | |
| waiting | gold (solid) | gold | Human gate |
| pending | transparent | ink-mute | Empty ring — not yet started |
| inactive | transparent | ink-mute @ 40% | Dimmer than pending |

Below each circle: the action label (monospace, ~4.5px in SVG units).
Below the label: cost if > 0 (`$0.41`, dimmer text).

Iteration badge: if `iter > 0`, a small circle (r=4) at the top-right of the
node with the iteration number inside.

Nodes that are unreachable by the currently filtered edge type are dimmed
(lower opacity) to signal they're not part of the visible flow.

### Edge design

All edges have directional arrowheads (small triangular markers, 4x4 marker
units) at the target end to indicate flow direction.

Forward edges: cubic bezier curves. Exit the RIGHT side of the source circle,
enter the LEFT side of the target circle. Horizontal tangents at both endpoints
so curves enter/exit perpendicular to the node perimeter.

Back-edges (retry/fail loops where target is LEFT of source): parabolic arcs
that bow UPWARD above the row. Height scales with the number of columns
spanned (base 8px + 8px per column). These render in a layer BEHIND forward
edges.

Edge color is driven by the condition type of the currently active filter:

| Condition | Stroke color | Arrow color |
|-----------|-------------|-------------|
| pass | success @ 70% mixed with ink-mute | same |
| fail | danger @ 75% mixed with ink-mute | same |
| max_turns | gold | same |
| timeout | gold | same |
| stuck | gold | same |
| cost_exceeded | danger | same |
| error | danger | same |

Back-edges (where target column <= source column) are always dashed.
Forward edges are always solid.

### Edge filtering

**Only one edge condition type is visible at a time.** This is the primary
mechanism for managing visual complexity in the graph.

**Default: pass edges.** The graph shows only `pass` condition edges. This
renders the clean DAG — the intended flow of work. Forward chains are visible,
convergence/fan-in/fan-out structure is clear, and there is no clutter from
retry loops or escalation paths.

**Filter toggles**: the filter bar (or a dedicated edge-type selector) allows
switching to a different condition:

| Filter | What you see | Purpose |
|--------|-------------|---------|
| pass | Forward DAG — the happy path | Default view; understand structure |
| fail | Retry loops — where failures route back | Debug failure recovery |
| max_turns | Escalation paths — where agents exhaust turns | Understand escalation |
| timeout | Timeout routes | |
| stuck | Stuck detection routes | |
| error | Crash recovery paths | |
| **all** | Every edge, non-pass edges dimmer/dashed | Full picture (busy) |

Switching the filter:
1. All edges of the previously active type fade out
2. All edges of the newly active type fade in
3. Node positions do not change — layout is independent of the filter
4. Nodes only reachable by the hidden edge types dim to lower opacity,
   signaling they're not part of the currently visible flow

**"All" mode**: shows every edge simultaneously. Pass edges render at full
opacity with solid lines. All other edge types render at reduced opacity
(~50%) with dashed lines. This preserves the visual hierarchy — the DAG
structure is still primary, error/retry paths are secondary.

**Interaction with node selection**: when a node is selected or hovered, ALL
of its connected edges become visible regardless of the active filter. This
lets you inspect a node's full routing without switching filters. The
temporarily-revealed edges render in their condition color but at reduced
opacity, and fade when the node is deselected.

Edge labels: condition text (e.g., "fail", "retry") displayed at the midpoint
of the edge path. Pass edges are unlabeled (they're the default, labeling
them adds noise). Non-pass edges show their condition when visible.

### Selection and hover

- Hovering a node highlights all edges connected to it (both incoming and
  outgoing). Non-connected edges fade to 55% opacity.
- Clicking a node selects it: the stroke thickens (0.9 → 1.6), the label
  bolds, and the detail panel on the right shows the action's full info.
- Hovering an edge is not interactive (edges are thin hairlines, hard to
  target). Instead, hovering a node highlights its edges.

### Color system

All colors come from CSS custom properties defined in `colors_and_type.css`.
The graph inherits the page theme (light/dark) automatically:

- `--accent` (teal by default, per-project configurable)
- `--success` (leaf green)
- `--danger` (clay/rust)
- `--gold` (deep gold)
- `--ink`, `--ink-soft`, `--ink-mute` (text hierarchy)
- `--paper`, `--paper-tint` (backgrounds)
- `--hairline` (subtle borders)

The graph canvas has a subtle dot-grid texture via CSS radial gradients on
`.oc-graph`, giving it a blueprint/notebook feel.

## Layout Algorithm

### Layering: ASAP / longest-path

Each node is assigned to a column (layer) determined by:

```
L(v) = 1 + max(L(u)) for all predecessors u
L(root) = 0  (nodes with no incoming forward edges)
```

This is ASAP (as-soon-as-possible) layering — each node appears in the
earliest column that respects all its dependencies. This is equivalent to the
longest path from any root to this node.

Back-edges (fail/retry loops where the target is earlier in the chain) are
excluded from the layering calculation. They don't affect column placement —
they're visual feedback about retry paths, not dependency constraints.

Cross-task dependency edges (e.g., `auth.qa → api.develop`) DO affect
layering — the dependent task's first action must be in a column after the
dependency's terminal action.

### Row assignment

Rows are the free dimension. Within each column, nodes are stacked vertically.
The row assignment algorithm optimizes for:

1. **Chain continuity**: nodes in the same task chain share the same row where
   possible, so within-chain edges are horizontal straight lines.

2. **Crossing minimization**: rows are ordered to reduce the number of edge
   crossings. This is an NP-hard problem in general; we use a heuristic
   (barycenter method or similar).

3. **Grouping**: parallel chains are visually separated. Each task's chain
   gets its own row band when possible.

The algorithm:

```
1. Compute column for each node (ASAP layering)
2. Group nodes by task (using task: tag)
3. For each task, determine its row:
   a. Process nodes in column order
   b. For the first node: if it has a same-task predecessor already placed,
      use that predecessor's row. Otherwise, find the lowest free row.
   c. For subsequent nodes in the same task: prefer the same row as the
      previous node in the chain. Fall back to lowest free row if occupied.
4. Result: each chain tends to occupy one row, with the median row reserved
   for source/convergence/sink nodes.
```

A node can have an explicit `row` hint (set by the fixture or by the user)
which overrides the algorithm.

### Coordinate mapping

After column and row assignment:

```
x = column * COL_W      (COL_W = 112px between column centers)
y = row * ROW_H          (ROW_H = 48px between row centers)
```

Padding: `PAD_X = 28px`, `PAD_Y = 20px` added to all coordinates. The SVG
viewBox is computed from the bounding box of all positioned nodes plus padding.

### Spanning edges

Edges that skip columns (e.g., B2 → End skips cols 3 and 4) are drawn as
longer bezier curves. No dummy nodes are inserted — the curve handles the
visual span naturally. The cubic bezier's control points use horizontal
tangents at both endpoints, with the tension parameter scaled to the distance:

```
tension = max(20, min(80, dx * 0.5))
```

Where `dx` is the horizontal distance between source and target.

### Diagnostic empty cells

Some grid positions (column, row) will be visually empty. This is expected:

- A chain that finishes in column 3 while the longest chain runs to column 5
  leaves columns 4-5 empty in that chain's row.
- The renderer never shifts nodes rightward to fill gaps — column placement
  is strictly determined by predecessors.
- These empty cells are the visual signature of chains that finished before
  the critical path.

### Critical path

The longest path through the graph is the critical path. It determines the
minimum wall-clock time for the entire graph to complete (even with infinite
parallelism). The renderer can optionally highlight the critical path by
thickening or coloring its edges differently.

## Data Model → Visual Mapping

The graph renders directly from the v2 API data:

| API field | Visual element |
|-----------|---------------|
| `action.id` | Node label (below dot) |
| `action.type` | Shown in detail panel on selection (not on node) |
| `action.status` | Node fill color (solid dot) |
| `action.iteration` | Badge on node (small circle, top-right) |
| `action.cost_usd` | Cost label below node label |
| `action.tags` (task:X) | Row grouping, chain identification |
| `edge.from_action` | Edge source node |
| `edge.to_action` | Edge target node |
| `edge.condition` | Edge visibility (controlled by filter), color, label |

Back-edge detection: an edge is a back-edge if the target's column is ≤ the
source's column. This happens for fail/retry loops (e.g., `eval [fail] → develop`).

### Live updates via SSE

The graph subscribes to `GET /events` (SSE). Events that affect the graph:

| SSE event | Graph update |
|-----------|-------------|
| `action_started` | Node transitions to running (fill changes, pulse starts) |
| `action_completed` | Node transitions to completed/failed (fill changes, pulse stops) |
| `action_waiting` | Node transitions to waiting (gold fill) |
| `edge_traversed` | Edge briefly flashes/thickens to indicate activation |

On state change, only the affected nodes and edges re-render — the layout
doesn't recompute unless the graph structure changes (action added/removed).

### Graph structure changes

When the graph structure changes (supervisor adds/removes actions, user
imports new tasks), the full layout recomputes:

1. Fetch `GET /actions` and rebuild the action list
2. Fetch edges for all actions
3. Recompute column/row layout
4. Animate nodes to their new positions (transition over ~200ms)

## Implementation Notes

### SVG rendering

The graph is rendered as an SVG element. Novel creates the SVG container;
internal SVG elements (circles, paths, text) are created via
`document.createElementNS('http://www.w3.org/2000/svg', ...)`.

Layer order (back to front):
1. Back-edge paths (dashed parabolas) — only if active filter includes them
2. Forward-edge paths (solid beziers) — only for active filter condition
3. Node circles (solid filled dots)
4. Node labels + costs
5. Edge labels (condition text at midpoint, except pass edges)

### Performance

For graphs under ~100 nodes, full SVG re-render on every change is fine
(sub-frame at 60fps). For larger graphs:

- Only re-render changed nodes/edges on status updates
- Full layout recompute only on structural changes
- Consider viewport culling for very large graphs (only render visible nodes)

### Interaction

- Click handler on each node group (`<g>` element) fires `onSelect(actionId)`
- Mouseenter/mouseleave on node group fires `onHover(actionId)` / `onHover(null)`
- Selected node ID and hover node ID are stored in app state
- Edge opacity is computed from whether the edge connects to the selected or
  hovered node

### Responsive behavior

The SVG scales to fit its container width (`.oc-graph__svg` has `width: 70%`
and `height: auto`). The viewBox is computed from the layout, so the graph
automatically sizes to its content. For very wide graphs, horizontal scroll
is enabled on `.oc-graph` via `overflow: auto`.

## Example: 12-node release graph

The canonical fixture graph demonstrates all layout features:

```
col:   0      1       2       3       4       5
row 0                A1 ─── A2 ─── A3 ─────────────┐
row 1  Start ──┬─────────────────── M ──────────── End
row 2          ├── B1 ─── B2 ──────────────────────┘
row 3          └── C1 ─── C2 ─── C3 ─── C4 ────────┘
```

- **Fan-out**: Start → A1, B1, C1 (column 0 → column 1)
- **Parallel chains**: A, B, C chains each on their own row
- **Mid-graph convergence**: M receives from A2 and B1 (join)
- **Spanning edges**: B2 → End spans 3 columns; M → End spans 2
- **Back-edges**: C2 [fail] → C1, C4 [fail] → C1 (dashed parabolas above C row)
- **Critical path**: Start → C1 → C2 → C3 → C4 → End (length 5)
- **Empty cells**: (col 4, row 0), (col 3, row 2), (col 4, row 2) — chains
  that finished before the critical path

Column placement follows ASAP rules:
- M is at column 3: max(A2=2, B1=1) + 1 = 3
- End is at column 5: max(A3=3, M=3, B2=2, C4=4) + 1 = 5

Row placement follows chain continuity:
- A chain: row 0 (top, isolated)
- Start/M/End: row 1 (median — source, convergence, sink)
- B chain: row 2 (below median)
- C chain: row 3 (bottom — longest chain gets its own row)
