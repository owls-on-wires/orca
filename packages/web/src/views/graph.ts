const NS = 'http://www.w3.org/2000/svg';

const NODE_R = 3;
const COL_W = 48;
const ROW_H = 48;
const PAD_X = 28;
const PAD_Y = 20;

// ---------------------------------------------------------------------------
// API types (matches v2-api.openapi.yaml ActionConfig / EdgeConfig)
// ---------------------------------------------------------------------------

export interface ApiAction {
  id: string;
  type: 'agent' | 'command';
  status: string;
  project_id: string | null;
  params: Record<string, unknown>;
  output: { status: string; summary: string; notes?: string; [k: string]: unknown } | null;
  tags: string[];
  cost_usd: number;
  iteration: number;
  created_at: string;
  updated_at: string;
  started_at: string | null;
  completed_at: string | null;
}

export interface ApiEdge {
  id?: number;
  from_action: string;
  to_action: string;
  condition: string;
}

// ---------------------------------------------------------------------------
// Internal layout types
// ---------------------------------------------------------------------------

export interface LayoutNode {
  id: string;
  type: string;
  status: string;
  label: string;
  task: string;
  project: string;
  iter: number;
  cost: number;
}

export interface Positioned extends LayoutNode {
  x: number;
  y: number;
  col: number;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function getTag(tags: string[], prefix: string): string {
  const t = tags.find(t => t.startsWith(prefix + ':'));
  return t ? t.slice(prefix.length + 1) : '';
}

function getLabel(id: string): string {
  const parts = id.split('.');
  return parts.length > 1 ? parts.slice(1).join('.') : id;
}

export function apiToLayout(a: ApiAction): LayoutNode {
  return {
    id: a.id,
    type: a.type,
    status: a.status,
    label: getLabel(a.id),
    task: getTag(a.tags, 'task'),
    project: getTag(a.tags, 'project'),
    iter: a.iteration,
    cost: a.cost_usd,
  };
}

const STATUS_FILL: Record<string, string> = {
  completed: 'var(--success)',
  running: 'var(--accent)',
  failed: 'var(--danger)',
  waiting: 'var(--gold)',
  pending: 'transparent',
  inactive: 'transparent',
};

const STATUS_STROKE: Record<string, string> = {
  completed: 'var(--success)',
  running: 'var(--accent)',
  failed: 'var(--danger)',
  waiting: 'var(--gold)',
  pending: 'var(--ink-mute)',
  inactive: 'color-mix(in oklab, var(--ink-mute) 40%, transparent)',
};

const COND_STROKE: Record<string, string> = {
  pass: 'color-mix(in oklab, var(--success) 70%, var(--ink-mute))',
  fail: 'color-mix(in oklab, var(--danger) 75%, var(--ink-mute))',
  max_turns: 'var(--gold)',
  timeout: 'var(--gold)',
  stuck: 'var(--gold)',
  cost_exceeded: 'color-mix(in oklab, var(--danger) 75%, var(--ink-mute))',
  error: 'color-mix(in oklab, var(--danger) 75%, var(--ink-mute))',
};

function svg(tag: string, attrs: Record<string, string | number | null> = {}): SVGElement {
  const el = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v !== null && v !== undefined) el.setAttribute(k, String(v));
  }
  return el;
}

// ---------------------------------------------------------------------------
// Layout: ASAP column assignment
// ---------------------------------------------------------------------------

export function computeColumns(nodes: LayoutNode[], edges: ApiEdge[]): Map<string, number> {
  const fwd: Record<string, string[]> = {};
  const indeg: Record<string, number> = {};
  nodes.forEach(a => { fwd[a.id] = []; indeg[a.id] = 0; });

  // Build an index of action positions to detect back-edges.
  // A back-edge is ANY edge where the target appears BEFORE the source
  // in the actions list — regardless of condition (fail, timeout, error, etc.).
  const actionIndex = new Map<string, number>();
  nodes.forEach((a, i) => actionIndex.set(a.id, i));

  edges.forEach(e => {
    if (!fwd[e.from_action] || indeg[e.to_action] == null) return;
    const srcIdx = actionIndex.get(e.from_action) ?? 0;
    const tgtIdx = actionIndex.get(e.to_action) ?? 0;
    if (tgtIdx <= srcIdx) return;
    fwd[e.from_action].push(e.to_action);
    indeg[e.to_action]++;
  });

  const col = new Map<string, number>();
  const queue: string[] = [];
  nodes.forEach(a => {
    if (indeg[a.id] === 0) { col.set(a.id, 0); queue.push(a.id); }
  });

  while (queue.length) {
    const id = queue.shift()!;
    for (const to of fwd[id]) {
      const r = (col.get(id) || 0) + 1;
      if (!col.has(to) || r > col.get(to)!) col.set(to, r);
      indeg[to]--;
      if (indeg[to] === 0) queue.push(to);
    }
  }

  nodes.forEach(a => { if (!col.has(a.id)) col.set(a.id, 0); });
  return col;
}

// ---------------------------------------------------------------------------
// Layout: Row assignment with task compaction
// ---------------------------------------------------------------------------

export function layoutActions(nodes: LayoutNode[], edges: ApiEdge[]): Positioned[] {
  const col = computeColumns(nodes, edges);

  // Group nodes by task and compute each task's column range
  const taskNodes = new Map<string, LayoutNode[]>();
  nodes.forEach(a => {
    const task = a.task || a.id;
    if (!taskNodes.has(task)) taskNodes.set(task, []);
    taskNodes.get(task)!.push(a);
  });

  const taskColRange = new Map<string, { min: number; max: number }>();
  taskNodes.forEach((tnodes, task) => {
    let min = Infinity, max = -Infinity;
    tnodes.forEach(n => {
      const c = col.get(n.id) || 0;
      if (c < min) min = c;
      if (c > max) max = c;
    });
    taskColRange.set(task, { min, max });
  });

  // Assign rows to tasks. A task can reuse a row if its column range
  // doesn't overlap with any task already on that row.
  const rowTasks: Array<{ task: string; min: number; max: number }[]> = [];
  const taskRow = new Map<string, number>();

  // Process tasks in order of their earliest column (leftmost tasks first)
  const taskOrder = [...taskColRange.entries()]
    .sort((a, b) => a[1].min - b[1].min)
    .map(e => e[0]);

  taskOrder.forEach(task => {
    const range = taskColRange.get(task)!;

    // Try to find an existing row where this task's columns don't overlap
    let placed = false;
    for (let r = 0; r < rowTasks.length; r++) {
      const overlaps = rowTasks[r].some(existing =>
        range.min <= existing.max && range.max >= existing.min
      );
      if (!overlaps) {
        rowTasks[r].push({ task, ...range });
        taskRow.set(task, r);
        placed = true;
        break;
      }
    }

    if (!placed) {
      rowTasks.push([{ task, ...range }]);
      taskRow.set(task, rowTasks.length - 1);
    }
  });

  // Place each node at its task's row
  const placement = new Map<string, number>();
  nodes.forEach(a => {
    const task = a.task || a.id;
    placement.set(a.id, taskRow.get(task) ?? 0);
  });

  return nodes.map(a => ({
    ...a,
    col: col.get(a.id) || 0,
    x: (col.get(a.id) || 0) * COL_W,
    y: (placement.get(a.id) || 0) * ROW_H,
  }));
}

// ---------------------------------------------------------------------------
// Edge path computation
// ---------------------------------------------------------------------------

function buildEdgePath(a: Positioned, b: Positioned): { d: string; midX: number; midY: number; back: boolean } {
  const back = b.x <= a.x;

  if (back) {
    const sx = a.x - NODE_R;
    const sy = a.y;
    const ex = b.x + NODE_R;
    const ey = b.y;
    const cols = Math.max(1, Math.round(Math.abs(a.x - b.x) / COL_W));
    const dip = 8 + cols * 8;
    return {
      d: `M ${sx} ${sy} C ${sx - 20} ${sy - dip}, ${ex + 20} ${ey - dip}, ${ex} ${ey}`,
      midX: (sx + ex) / 2,
      midY: (sy + ey) / 2 - dip * 0.75,
      back: true,
    };
  }

  const sx = a.x + NODE_R;
  const sy = a.y;
  const ex = b.x - NODE_R;
  const ey = b.y;
  const dx = ex - sx;
  const t = Math.max(20, Math.min(80, dx * 0.5));
  return {
    d: `M ${sx} ${sy} C ${sx + t} ${sy}, ${ex - t} ${ey}, ${ex} ${ey}`,
    midX: (sx + ex) / 2,
    midY: (sy + ey) / 2,
    back: false,
  };
}

// ---------------------------------------------------------------------------
// Viewport — horizontal scroll
// ---------------------------------------------------------------------------

interface Viewport {
  x: number; y: number; w: number; h: number;
}

let currentViewport: Viewport = { x: 0, y: 0, w: 100, h: 100 };
let svgRef: SVGSVGElement | null = null;
let contentBounds = { x: 0, y: 0, w: 100, h: 100, totalW: 100 };
let panActive = false;
let panStartX = 0;
let panStartVPx = 0;

const SCROLL_SPEED = 0.8;

function setViewBox(svgEl: SVGSVGElement, vp: Viewport) {
  svgEl.setAttribute('viewBox', `${vp.x} ${vp.y} ${vp.w} ${vp.h}`);
}

function clampX(x: number): number {
  const minX = contentBounds.x - currentViewport.w * 0.1;
  const maxX = contentBounds.x + contentBounds.totalW - currentViewport.w + currentViewport.w * 0.1;
  return Math.max(minX, Math.min(maxX, x));
}

function initViewport(svgEl: SVGSVGElement, content: { x: number; y: number; w: number; h: number }, actions: Positioned[], ox: number, oy: number) {
  const container = svgEl.parentElement;
  if (!container) return;
  const ch = container.clientHeight;
  const cw = container.clientWidth;
  if (ch === 0 || cw === 0) return;

  const containerAspect = cw / ch;
  const textAbove = 8;
  const textBelow = 16;
  const svgMinY = Math.min(...actions.map(a => a.y + oy)) - NODE_R - textAbove;
  const svgMaxY = Math.max(...actions.map(a => a.y + oy)) + NODE_R + textBelow + 4;
  const rowSpan = svgMaxY - svgMinY;
  const centerY = (svgMinY + svgMaxY) / 2;

  const padding = Math.max(ROW_H, rowSpan * 0.15);
  const minViewH = ROW_H * 2;
  const viewH = Math.max(rowSpan + padding, minViewH);
  const viewW = viewH * containerAspect;
  const viewY = centerY - viewH / 2;

  contentBounds = { ...content, totalW: content.w };

  const runningActions = actions.filter(a => a.status === 'running');
  let scrollToX: number;
  if (runningActions.length > 0) {
    const minRunningX = Math.min(...runningActions.map(a => a.x + ox));
    scrollToX = minRunningX - viewW * 0.3;
  } else {
    scrollToX = content.x;
  }

  currentViewport = { x: clampX(scrollToX), y: viewY, w: viewW, h: viewH };
  setViewBox(svgEl, currentViewport);
}

function setupScrollAndDrag(svgEl: SVGSVGElement, container: HTMLElement) {
  container.addEventListener('wheel', (e) => {
    e.preventDefault();
    const rect = svgEl.getBoundingClientRect();
    const pixelsPerUnit = currentViewport.w / rect.width;
    currentViewport = { ...currentViewport, x: clampX(currentViewport.x + e.deltaY * pixelsPerUnit * SCROLL_SPEED) };
    setViewBox(svgEl, currentViewport);
  }, { passive: false });

  container.addEventListener('mousedown', (e) => {
    if (e.button !== 0) return;
    if ((e.target as Element).closest('.oc-node')) return;
    panActive = true;
    panStartX = e.clientX;
    panStartVPx = currentViewport.x;
    container.style.cursor = 'grabbing';
    e.preventDefault();
  });

  window.addEventListener('mousemove', (e) => {
    if (!panActive) return;
    const rect = svgEl.getBoundingClientRect();
    const pixelsPerUnit = currentViewport.w / rect.width;
    currentViewport = { ...currentViewport, x: clampX(panStartVPx - (e.clientX - panStartX) * pixelsPerUnit) };
    setViewBox(svgEl, currentViewport);
  });

  window.addEventListener('mouseup', () => {
    if (panActive) { panActive = false; document.querySelector('.oc-graph')?.removeAttribute('style'); }
  });
}

function scrollToFit(svgEl: SVGSVGElement) {
  currentViewport = { ...currentViewport, x: clampX(contentBounds.x) };
  setViewBox(svgEl, currentViewport);
}

// ---------------------------------------------------------------------------
// Graph options
// ---------------------------------------------------------------------------

export interface GraphOptions {
  actions: ApiAction[];
  edges: ApiEdge[];
  filter: string;
  selectedId: string | null;
  hoverId: string | null;
  onSelect: (id: string) => void;
  onHover: (id: string | null) => void;
}

// ---------------------------------------------------------------------------
// Render
// ---------------------------------------------------------------------------

export function renderGraph(container: HTMLElement, opts: GraphOptions) {
  const { actions, edges, filter, selectedId, hoverId, onSelect, onHover } = opts;

  const nodes = actions.map(apiToLayout);
  const positioned = layoutActions(nodes, edges);
  const byId = new Map<string, Positioned>();
  positioned.forEach(a => byId.set(a.id, a));

  const visibleEdges = filter === 'all' ? edges : edges.filter(e => e.condition === filter);
  const connectedNodes = new Set<string>();
  visibleEdges.forEach(e => { connectedNodes.add(e.from_action); connectedNodes.add(e.to_action); });

  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  positioned.forEach(a => {
    if (a.x < minX) minX = a.x;
    if (a.x > maxX) maxX = a.x;
    if (a.y < minY) minY = a.y;
    if (a.y > maxY) maxY = a.y;
  });

  const contentW = (maxX - minX) + PAD_X * 2;
  const contentH = (maxY - minY) + PAD_Y * 2;
  const ox = PAD_X - minX;
  const oy = PAD_Y - minY;

  const isFirstRender = !svgRef || !container.contains(svgRef);

  if (isFirstRender) {
    container.innerHTML = '';
    const svgEl = svg('svg', {
      preserveAspectRatio: 'xMidYMid meet',
      class: 'oc-graph__svg',
      style: 'width:100%;height:100%',
    }) as unknown as SVGSVGElement;
    svgRef = svgEl;

    const defs = svg('defs');
    Object.entries(COND_STROKE).forEach(([cond, fill]) => {
      const marker = svg('marker', { id: `oc-arr-${cond}`, viewBox: '0 0 10 10', refX: 8, refY: 5, markerWidth: 4, markerHeight: 4, orient: 'auto-start-reverse' });
      marker.appendChild(svg('path', { d: 'M 0 0 L 10 5 L 0 10 z', fill }));
      defs.appendChild(marker);
    });
    svgEl.appendChild(defs);
    container.appendChild(svgEl);
    setupScrollAndDrag(svgEl, container);

    const fitBtn = document.createElement('button');
    fitBtn.className = 'oc-graph__fit';
    fitBtn.textContent = '\u25C0';
    fitBtn.title = 'Scroll to start';
    fitBtn.addEventListener('click', () => { if (svgRef) scrollToFit(svgRef); });
    container.appendChild(fitBtn);

    const contentRect = { x: -PAD_X, y: -PAD_Y, w: contentW + PAD_X, h: contentH + PAD_Y };
    initViewport(svgEl, contentRect, positioned, ox, oy);
  }

  const svgEl = svgRef!;
  svgEl.querySelectorAll('.oc-edges--back, .oc-edges--fwd, .oc-nodes').forEach(el => el.remove());

  const backLayer = svg('g', { class: 'oc-edges--back' });
  const fwdLayer = svg('g', { class: 'oc-edges--fwd' });
  const nodeLayer = svg('g', { class: 'oc-nodes' });

  visibleEdges.forEach(e => {
    const a = byId.get(e.from_action);
    const b = byId.get(e.to_action);
    if (!a || !b) return;

    const pa = { ...a, x: a.x + ox, y: a.y + oy } as Positioned;
    const pb = { ...b, x: b.x + ox, y: b.y + oy } as Positioned;
    const ep = buildEdgePath(pa, pb);

    const isHot = (selectedId && (e.from_action === selectedId || e.to_action === selectedId))
      || (hoverId && (e.from_action === hoverId || e.to_action === hoverId));

    let stroke = COND_STROKE[e.condition] || 'var(--hairline)';
    if (!isHot && filter === 'all' && e.condition !== 'pass') stroke = `color-mix(in oklab, ${stroke} 50%, transparent)`;
    if (!isHot && filter !== 'all') stroke = `color-mix(in oklab, ${stroke} 75%, transparent)`;

    const path = svg('path', {
      d: ep.d, fill: 'none', stroke,
      'stroke-width': isHot ? 1.2 : 0.8,
      'stroke-dasharray': ep.back ? '3 3' : null,
      'marker-end': `url(#oc-arr-${e.condition})`,
    });
    (ep.back ? backLayer : fwdLayer).appendChild(path);

    if (e.condition !== 'pass') {
      const label = svg('text', { x: ep.midX, y: ep.midY, dy: -4, 'text-anchor': 'middle', class: 'oc-edge__label', style: `opacity:${isHot ? 1 : 0.7}` });
      label.textContent = e.condition;
      (ep.back ? backLayer : fwdLayer).appendChild(label);
    }
  });

  positioned.forEach(a => {
    const cx = a.x + ox;
    const cy = a.y + oy;
    const selected = selectedId === a.id;
    const hover = hoverId === a.id;
    const dimmed = !connectedNodes.has(a.id) && filter !== 'all';

    const g = svg('g', {
      class: `oc-node oc-node--${a.status}${selected ? ' is-selected' : ''}${hover ? ' is-hover' : ''}`,
      style: `cursor:pointer;${dimmed ? 'opacity:0.3;' : ''}`,
    });
    g.addEventListener('mouseenter', () => onHover(a.id));
    g.addEventListener('mouseleave', () => onHover(null));
    g.addEventListener('click', (e) => { e.stopPropagation(); onSelect(a.id); });

    if (a.status === 'running') {
      g.appendChild(svg('circle', { cx, cy, r: NODE_R + 3, fill: 'none', stroke: 'var(--accent)', 'stroke-opacity': 0.25, 'stroke-width': 1, class: 'oc-node__pulse' }));
    }

    const fillOpacity = (a.status === 'pending' || a.status === 'inactive') ? 0 : 1;
    g.appendChild(svg('circle', { cx, cy, r: NODE_R, fill: STATUS_FILL[a.status] || 'transparent', 'fill-opacity': fillOpacity, stroke: STATUS_STROKE[a.status] || 'var(--ink-mute)', 'stroke-width': selected ? 1.6 : 0.9 }));

    if (a.iter > 0) {
      const bx = cx + NODE_R, by = cy - NODE_R;
      g.appendChild(svg('circle', { cx: bx, cy: by, r: 2.5, fill: 'var(--paper)', stroke: STATUS_STROKE[a.status] || 'var(--ink-mute)', 'stroke-width': 0.5 }));
      const it = svg('text', { x: bx, y: by, 'text-anchor': 'middle', 'dominant-baseline': 'central', class: 'oc-node__iter' });
      it.textContent = String(a.iter);
      g.appendChild(it);
    }

    const typeLabel = svg('text', { x: cx, y: cy - NODE_R - 4, 'text-anchor': 'middle', class: `oc-node__label${selected ? ' oc-node__label--selected' : ''}` });
    typeLabel.textContent = a.label;
    g.appendChild(typeLabel);

    const taskLabel = svg('text', { x: cx, y: cy + NODE_R + 7, 'text-anchor': 'middle', class: 'oc-node__task' });
    taskLabel.textContent = `task: ${a.task}`;
    g.appendChild(taskLabel);

    if (a.project) {
      const pt = svg('text', { x: cx, y: cy + NODE_R + 14, 'text-anchor': 'middle', class: 'oc-node__task' });
      pt.textContent = `project: ${a.project}`;
      g.appendChild(pt);
    }

    nodeLayer.appendChild(g);
  });

  svgEl.appendChild(backLayer);
  svgEl.appendChild(fwdLayer);
  svgEl.appendChild(nodeLayer);
}

// ---------------------------------------------------------------------------
// Demo fixture — uses API format (ActionConfig[] + EdgeConfig[])
// ---------------------------------------------------------------------------

function mkAction(id: string, type: 'agent' | 'command', status: string, tags: string[], extra: Partial<ApiAction> = {}): ApiAction {
  const now = new Date().toISOString();
  return {
    id, type, status, project_id: 'demo', params: {}, output: null, tags,
    cost_usd: 0, iteration: 0, created_at: now, updated_at: now,
    started_at: null, completed_at: null, ...extra,
  };
}

export function getDemoFixture(): { actions: ApiAction[]; edges: ApiEdge[] } {
  const actions: ApiAction[] = [
    // ── auth (completed) ──
    mkAction('auth.develop',  'agent',   'completed', ['task:auth', 'type:develop'],  { iteration: 1, cost_usd: 1.82 }),
    mkAction('auth.eval',     'command', 'completed', ['task:auth', 'type:eval']),
    mkAction('auth.develop2', 'agent',   'completed', ['task:auth', 'type:develop'],  { iteration: 2, cost_usd: 0.94 }),
    mkAction('auth.eval2',    'command', 'completed', ['task:auth', 'type:eval']),
    mkAction('auth.deploy',   'command', 'completed', ['task:auth', 'type:deploy']),
    mkAction('auth.qa',       'agent',   'completed', ['task:auth', 'type:qa'],       { iteration: 1, cost_usd: 0.45 }),
    mkAction('auth.commit',   'command', 'completed', ['task:auth', 'type:commit']),

    // ── css-fix (completed, no deps, parallel with auth) ──
    mkAction('css.develop',   'agent',   'completed', ['task:css-fix', 'type:develop'], { iteration: 1, cost_usd: 0.21 }),
    mkAction('css.eval',      'command', 'completed', ['task:css-fix', 'type:eval']),
    mkAction('css.commit',    'command', 'completed', ['task:css-fix', 'type:commit']),

    // ── api (depends on auth, in progress) ──
    mkAction('api.develop',   'agent',   'completed', ['task:api', 'type:develop'],   { iteration: 1, cost_usd: 2.31 }),
    mkAction('api.eval',      'command', 'completed', ['task:api', 'type:eval']),
    mkAction('api.deploy',    'command', 'completed', ['task:api', 'type:deploy']),
    mkAction('api.qa',        'agent',   'failed',    ['task:api', 'type:qa'],        { iteration: 1, cost_usd: 0.52 }),
    mkAction('api.develop2',  'agent',   'running',   ['task:api', 'type:develop'],   { iteration: 2, cost_usd: 0.88 }),
    mkAction('api.eval2',     'command', 'pending',   ['task:api', 'type:eval']),
    mkAction('api.deploy2',   'command', 'inactive',  ['task:api', 'type:deploy']),
    mkAction('api.qa2',       'agent',   'inactive',  ['task:api', 'type:qa']),
    mkAction('api.commit',    'command', 'inactive',  ['task:api', 'type:commit']),

    // ── payments (depends on api, waiting) ──
    mkAction('pay.develop',   'agent',   'inactive',  ['task:payments', 'type:develop']),
    mkAction('pay.eval',      'command', 'inactive',  ['task:payments', 'type:eval']),
    mkAction('pay.deploy',    'command', 'inactive',  ['task:payments', 'type:deploy']),
    mkAction('pay.qa',        'agent',   'inactive',  ['task:payments', 'type:qa']),
    mkAction('pay.commit',    'command', 'inactive',  ['task:payments', 'type:commit']),

    // ── notifications (depends on api, parallel with payments) ──
    mkAction('notif.develop', 'agent',   'inactive',  ['task:notifs', 'type:develop']),
    mkAction('notif.eval',    'command', 'inactive',  ['task:notifs', 'type:eval']),
    mkAction('notif.commit',  'command', 'inactive',  ['task:notifs', 'type:commit']),
  ];

  const edges: ApiEdge[] = [
    // auth chain
    { from_action: 'auth.develop',  to_action: 'auth.eval',     condition: 'pass' },
    { from_action: 'auth.eval',     to_action: 'auth.develop2', condition: 'fail' },
    { from_action: 'auth.develop2', to_action: 'auth.eval2',    condition: 'pass' },
    { from_action: 'auth.eval2',    to_action: 'auth.deploy',   condition: 'pass' },
    { from_action: 'auth.deploy',   to_action: 'auth.qa',       condition: 'pass' },
    { from_action: 'auth.qa',       to_action: 'auth.commit',   condition: 'pass' },
    { from_action: 'auth.eval',     to_action: 'auth.develop',  condition: 'fail' },
    { from_action: 'auth.qa',       to_action: 'auth.develop',  condition: 'fail' },

    // css-fix chain
    { from_action: 'css.develop',   to_action: 'css.eval',      condition: 'pass' },
    { from_action: 'css.eval',      to_action: 'css.commit',    condition: 'pass' },
    { from_action: 'css.eval',      to_action: 'css.develop',   condition: 'fail' },

    // api chain (depends on auth)
    { from_action: 'auth.commit',   to_action: 'api.develop',   condition: 'pass' },
    { from_action: 'api.develop',   to_action: 'api.eval',      condition: 'pass' },
    { from_action: 'api.eval',      to_action: 'api.deploy',    condition: 'pass' },
    { from_action: 'api.deploy',    to_action: 'api.qa',        condition: 'pass' },
    { from_action: 'api.qa',        to_action: 'api.develop2',  condition: 'fail' },
    { from_action: 'api.develop2',  to_action: 'api.eval2',     condition: 'pass' },
    { from_action: 'api.eval2',     to_action: 'api.deploy2',   condition: 'pass' },
    { from_action: 'api.deploy2',   to_action: 'api.qa2',       condition: 'pass' },
    { from_action: 'api.qa2',       to_action: 'api.commit',    condition: 'pass' },
    { from_action: 'api.eval',      to_action: 'api.develop',   condition: 'fail' },
    { from_action: 'api.qa',        to_action: 'api.develop',   condition: 'fail' },

    // payments (depends on api)
    { from_action: 'api.commit',    to_action: 'pay.develop',   condition: 'pass' },
    { from_action: 'pay.develop',   to_action: 'pay.eval',      condition: 'pass' },
    { from_action: 'pay.eval',      to_action: 'pay.deploy',    condition: 'pass' },
    { from_action: 'pay.deploy',    to_action: 'pay.qa',        condition: 'pass' },
    { from_action: 'pay.qa',        to_action: 'pay.commit',    condition: 'pass' },
    { from_action: 'pay.eval',      to_action: 'pay.develop',   condition: 'fail' },
    { from_action: 'pay.qa',        to_action: 'pay.develop',   condition: 'fail' },

    // notifications (depends on api, parallel with payments)
    { from_action: 'api.commit',    to_action: 'notif.develop', condition: 'pass' },
    { from_action: 'notif.develop', to_action: 'notif.eval',    condition: 'pass' },
    { from_action: 'notif.eval',    to_action: 'notif.commit',  condition: 'pass' },
    { from_action: 'notif.eval',    to_action: 'notif.develop', condition: 'fail' },
  ];

  return { actions, edges };
}
