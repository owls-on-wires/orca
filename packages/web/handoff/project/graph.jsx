// graph.jsx — SVG render of the Orca DAG.
// Style: circle nodes, hairline accent edges, condition labels mid-arc.
// Edges curve to avoid passing through nodes; retry/dep edges are dashed.

const STATUS_FILL = {
  completed: "var(--success)",
  running:   "var(--accent)",
  failed:    "var(--danger)",
  waiting:   "var(--gold)",
  escalated: "var(--gold)",
  pending:   "transparent",
};
const STATUS_STROKE = {
  completed: "var(--success)",
  running:   "var(--accent)",
  failed:    "var(--danger)",
  waiting:   "var(--gold)",
  escalated: "var(--gold)",
  pending:   "var(--ink-mute)",
};

const NODE_R = 11;
const PAD_X = 28;
const PAD_Y = 20;
const COL_W = 112;
const ROW_H = 48;

// Topological rank: longest forward path from a root. Dashed edges (back-edges,
// fail/retry loops, deps) are ignored so they don't break the DAG.
function computeRanks(actions, edges) {
  const fwd = {};   // id -> [neighbours]
  const indeg = {}; // id -> in-count
  actions.forEach((a) => { fwd[a.id] = []; indeg[a.id] = 0; });
  edges.forEach((e) => {
    // Skip back-edges (dashed retry/fail loops) so they don't break the DAG.
    // Forward edges — including cross-task `deps` (which we render dashed for
    // emphasis) — must propagate rank so dependents land one column past
    // their dependency.
    if (e.dashed && e.cond !== "deps") return;
    if (!fwd[e.from] || indeg[e.to] == null) return;
    fwd[e.from].push(e.to);
    indeg[e.to] += 1;
  });
  const rank = {};
  const queue = [];
  actions.forEach((a) => { if (indeg[a.id] === 0) { rank[a.id] = 0; queue.push(a.id); } });
  while (queue.length) {
    const id = queue.shift();
    fwd[id].forEach((to) => {
      const r = (rank[id] || 0) + 1;
      if (rank[to] == null || r > rank[to]) rank[to] = r;
      indeg[to] -= 1;
      if (indeg[to] === 0) queue.push(to);
    });
  }
  actions.forEach((a) => { if (rank[a.id] == null) rank[a.id] = 0; });
  return rank;
}

// Layered graph drawing (ASAP / longest-path layering, Sugiyama-style).
//   L(v) = 1 + max(L(u)) over predecessors u   — see computeRanks above.
// Rows are the free dimension; we use them to minimise crossings and to
// visually separate parallel work. Strategy: lay out each task as a
// contiguous chain on the LOWEST row where every action in the task fits
// without colliding with already-placed actions at the same rank.
function layoutActions(actions, edges) {
  const rank = computeRanks(actions, edges);
  const taskOrder = [];
  actions.forEach((a) => { if (!taskOrder.includes(a.task)) taskOrder.push(a.task); });

  // Build a forward-edge map (excluding back-edges) so we can find each
  // node's predecessors when packing rows.
  const preds = {};
  actions.forEach((a) => { preds[a.id] = []; });
  edges.forEach((e) => {
    if (e.dashed && e.cond !== "deps") return;
    if (preds[e.to]) preds[e.to].push(e.from);
  });

  // Row packing with chain-continuity bias.
  //
  // For each action (in rank order), prefer the row of its highest-rank
  // predecessor in the same task — this keeps chains horizontal so within-
  // chain edges are straight lines. If that row's column slot is already
  // taken, fall back to the lowest-numbered free row. Honors an explicit
  // `row` hint on an action, if provided.
  const rows = []; // each row: Set<rank> of occupied (rank) slots
  const placement = {};
  const ensureRow = (idx) => { while (rows.length <= idx) rows.push(new Set()); };
  const claim = (row, r) => { ensureRow(row); rows[row].add(r); };
  const free = (row, r) => row >= 0 && row < rows.length && !rows[row].has(r);

  // Process all actions in rank order (across tasks) so a chain's earlier
  // members are placed before later ones — required for the predecessor
  // lookup to find a placed row.
  const ordered = [...actions].sort((a, b) => rank[a.id] - rank[b.id]);

  ordered.forEach((a) => {
    const r = rank[a.id];

    // 1) Explicit hint wins.
    if (typeof a.row === "number") {
      placement[a.id] = a.row;
      claim(a.row, r);
      return;
    }

    // 2) Bias: row of the highest-rank predecessor in the same task.
    const sameTaskPreds = preds[a.id]
      .map((id) => actions.find((x) => x.id === id))
      .filter((p) => p && p.task === a.task && placement[p.id] != null)
      .sort((p, q) => rank[q.id] - rank[p.id]);
    if (sameTaskPreds.length) {
      const wantRow = placement[sameTaskPreds[0].id];
      if (free(wantRow, r)) {
        placement[a.id] = wantRow;
        claim(wantRow, r);
        return;
      }
    }

    // 3) Fallback: lowest-numbered row whose rank slot is open.
    let row = rows.findIndex((s) => !s.has(r));
    if (row === -1) { rows.push(new Set()); row = rows.length - 1; }
    placement[a.id] = row;
    claim(row, r);
  });

  const positioned = actions.map((a) => ({
    ...a,
    x: rank[a.id] * COL_W,
    y: placement[a.id] * ROW_H,
    _rank: rank[a.id],
  }));
  const maxRank = Math.max(...Object.values(rank));
  return { actions: positioned, taskOrder, maxRank, rowCount: rows.length };
}

function bbox(actions) {
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  actions.forEach((a) => {
    if (a.x < minX) minX = a.x;
    if (a.x > maxX) maxX = a.x;
    if (a.y < minY) minY = a.y;
    if (a.y > maxY) maxY = a.y;
  });
  return { minX, maxX, minY, maxY, w: maxX - minX, h: maxY - minY };
}

// Edge path between two nodes.
// All forward edges enter on the LEFT side of the target circle and exit on
// the RIGHT side of the source — so all outgoing/incoming arrows share the
// same anchor point on each node. Back-edges (parabola) attach to top/bottom.
function edgePath(a, b, opts = {}) {
  // Back-edges go from the LEFT side of the source (input) to the RIGHT
  // side of the target (output) — i.e. backward through both nodes' normal
  // anchors. Routed ABOVE the row with an upward bow so they read as a
  // "rewind / failure return" without overlapping forward edges.
  if (opts.back) {
    const sx = a.x - NODE_R;
    const sy = a.y;
    const ex = b.x + NODE_R;
    const ey = b.y;
    const dip = opts.dip || 20;
    const cx1 = sx - 20;
    const cy1 = sy - dip;
    const cx2 = ex + 20;
    const cy2 = ey - dip;
    return {
      d: `M ${sx} ${sy} C ${cx1} ${cy1}, ${cx2} ${cy2}, ${ex} ${ey}`,
      mid: { x: (sx + ex) / 2, y: (sy + ey) / 2 - dip * 0.75 },
    };
  }

  // Forward edge: right side of source → left side of target.
  // Smooth cubic Bezier with horizontal tangents at both anchors so the
  // curve enters/exits each circle perpendicular to the perimeter.
  const sx = a.x + NODE_R;
  const sy = a.y;
  const ex = b.x - NODE_R;
  const ey = b.y;
  const dx = ex - sx;
  const t = Math.max(20, Math.min(80, dx * 0.5));
  const cx1 = sx + t;
  const cy1 = sy;
  const cx2 = ex - t;
  const cy2 = ey;
  return {
    d: `M ${sx} ${sy} C ${cx1} ${cy1}, ${cx2} ${cy2}, ${ex} ${ey}`,
    mid: { x: (sx + ex) / 2, y: (sy + ey) / 2 },
  };
}

function Graph({ fixture, selectedId, hoverId, onSelect, onHover }) {
  const { edges, tasks } = fixture;
  const laid = React.useMemo(
    () => layoutActions(fixture.actions, fixture.edges),
    [fixture.actions, fixture.edges]
  );
  const actions = laid.actions;
  const box = bbox(actions);
  const W = box.w + PAD_X * 2;
  const H = box.h + PAD_Y * 2;
  const ox = PAD_X - box.minX;
  const oy = PAD_Y - box.minY;

  const byId = React.useMemo(() => {
    const m = {};
    actions.forEach((a) => { m[a.id] = a; });
    return m;
  }, [actions]);

  // Back-edges (b.x < a.x) render as symmetric parabolas; forward edges as
  // gentle cubic curves with small perpendicular bow. We tag each so we can
  // draw back-edges in a layer BEHIND forward edges (which sit behind nodes).
  const buildEdge = (e, i) => {
    const a = byId[e.from];
    const b = byId[e.to];
    if (!a || !b) return null;
    const back = b.x < a.x;
    const sameRow = Math.abs(a.y - b.y) < 1;
    const dxAbs = Math.abs(a.x - b.x);

    const pa = { x: a.x + ox, y: a.y + oy };
    const pb = { x: b.x + ox, y: b.y + oy };
    let path;
    if (back) {
      // Parabola height scales with the number of columns spanned.
      // 1-column hop = base height; each additional column adds a step.
      const cols = Math.max(1, Math.round(dxAbs / COL_W));
      const dip = 8 + cols * 8;
      path = edgePath(pa, pb, { back: true, dip });
    } else {
      const bow = sameRow ? 0 : (b.y - a.y) > 0 ? 24 : -24;
      path = edgePath(pa, pb, { bow });
    }

    const isHot = (selectedId && (e.from === selectedId || e.to === selectedId))
               || (hoverId && (e.from === hoverId || e.to === hoverId));

    let stroke = "var(--hairline)";
    if (e.cond === "pass")   stroke = "color-mix(in oklab, var(--success) 70%, var(--ink-mute))";
    if (e.cond === "fail")   stroke = "color-mix(in oklab, var(--danger) 75%, var(--ink-mute))";
    if (e.cond === "retry")  stroke = "var(--gold)";
    if (e.cond === "deps")   stroke = "color-mix(in oklab, var(--accent) 60%, var(--ink-mute))";
    if (e.cond === "approve") stroke = "color-mix(in oklab, var(--success) 70%, var(--ink-mute))";

    if (!isHot) stroke = `color-mix(in oklab, ${stroke} 55%, transparent)`;

    return { e, i, path, stroke, isHot, back };
  };

  const allEdges = edges.map(buildEdge).filter(Boolean);
  const backEdges = allEdges.filter((x) => x.back);
  const forwardEdges = allEdges.filter((x) => !x.back);

  const renderEdge = ({ e, i, path, stroke, isHot }) => (
    <g key={i} className={`oc-edge oc-edge--${e.cond}`}>
      <path
        d={path.d}
        fill="none"
        stroke={stroke}
        strokeWidth={isHot ? 1.1 : 0.7}
        strokeDasharray={e.dashed ? "3 3" : null}
        markerEnd={`url(#oc-arrow-${e.cond})`}
      />
      {e.cond && e.cond !== "pass" && (
        <text
          x={path.mid.x}
          y={path.mid.y}
          dy="-4"
          textAnchor="middle"
          className="oc-edge__label"
          style={{ opacity: isHot ? 1 : 0.85 }}
        >{e.cond}</text>
      )}
    </g>
  );

  return (
    <div className="oc-graph">
      <svg viewBox={`0 0 ${W} ${H}`} width={W} height={H} preserveAspectRatio="xMidYMid meet" className="oc-graph__svg">
        <defs>
          {["pass","fail","retry","deps","approve"].map((cond) => {
            const fill = ({
              pass:    "color-mix(in oklab, var(--success) 70%, var(--ink-mute))",
              fail:    "color-mix(in oklab, var(--danger) 75%, var(--ink-mute))",
              retry:   "var(--gold)",
              deps:    "color-mix(in oklab, var(--accent) 60%, var(--ink-mute))",
              approve: "color-mix(in oklab, var(--success) 70%, var(--ink-mute))",
            })[cond];
            return (
              <marker key={cond} id={`oc-arrow-${cond}`} viewBox="0 0 10 10" refX="8" refY="5"
                      markerWidth="4" markerHeight="4" orient="auto-start-reverse">
                <path d="M 0 0 L 10 5 L 0 10 z" fill={fill}/>
              </marker>
            );
          })}
          <pattern id="oc-graph-grain" width="6" height="6" patternUnits="userSpaceOnUse">
            <circle cx="1" cy="1" r="0.5" fill="var(--ink)" fillOpacity="0.04"/>
          </pattern>
        </defs>

        {/* Back-edges (fail/retry parabolas) sit BEHIND forward edges. */}
        <g className="oc-edges oc-edges--back">{backEdges.map(renderEdge)}</g>
        <g className="oc-edges oc-edges--forward">{forwardEdges.map(renderEdge)}</g>

        {/* Nodes */}
        {actions.map((a) => {
          const cx = a.x + ox;
          const cy = a.y + oy;
          const selected = selectedId === a.id;
          const hover = hoverId === a.id;
          const running = a.status === "running";
          const fill = STATUS_FILL[a.status] || "transparent";
          const stroke = STATUS_STROKE[a.status] || "var(--ink-mute)";
          return (
            <g key={a.id}
               className={`oc-node oc-node--${a.status} ${selected ? "is-selected" : ""} ${hover ? "is-hover" : ""}`}
               onMouseEnter={() => onHover(a.id)}
               onMouseLeave={() => onHover(null)}
               onClick={() => onSelect(a.id)}
               style={{ cursor: "pointer" }}>
              {running && (
                <circle cx={cx} cy={cy} r={NODE_R + 6} fill="none"
                        stroke="var(--accent)" strokeOpacity="0.25" strokeWidth="1.2"
                        className="oc-node__pulse"/>
              )}
              <circle cx={cx} cy={cy} r={NODE_R}
                      fill={fill}
                      fillOpacity={a.status === "completed" ? 0.18 : a.status === "pending" ? 0 : 0.22}
                      stroke={stroke}
                      strokeWidth={selected ? 1.6 : 0.9}/>
              {/* type glyph inside (centred) */}
              <text x={cx} y={cy} textAnchor="middle" dominantBaseline="central"
                    className={`oc-node__glyph oc-node__glyph--${a.type}`}>
                {a.type === "agent" ? "◇" : "▢"}
              </text>
              {/* iteration badge */}
              {a.iter > 0 && (
                <g>
                  <circle cx={cx + NODE_R - 2} cy={cy - NODE_R + 2} r="4"
                          fill="var(--paper)" stroke={stroke} strokeWidth="0.6"/>
                  <text x={cx + NODE_R - 2} y={cy - NODE_R + 2}
                        textAnchor="middle" dominantBaseline="central"
                        className="oc-node__iter">{a.iter}</text>
                </g>
              )}
              {/* label below */}
              <text x={cx} y={cy + NODE_R + 7} textAnchor="middle"
                    className="oc-node__label">{a.label}</text>
              {a.cost > 0 && (
                <text x={cx} y={cy + NODE_R + 14} textAnchor="middle"
                      className="oc-node__cost">${a.cost.toFixed(2)}</text>
              )}
            </g>
          );
        })}
      </svg>
    </div>
  );
}

window.OrcaGraph = Graph;
