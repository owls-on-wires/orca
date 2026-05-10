import { html } from '@owls-on-wires/novel';
import $ from 'jquery';
import { get } from '../state/state';
import * as modifiers from '../state/modifiers';
import { renderGraph, getDemoFixture, type ApiAction, type ApiEdge } from './graph';
import { renderDetail } from './detail';
import { api } from '../services/api';

function text(s: string): Node {
  return document.createTextNode(s);
}

function orcaLogo() {
  const el = html.div({ class: 'oc-pageline__title' });
  el.innerHTML = '<span class="oz-brace oz-brace--l">{</span><span class="oz-word">0rca</span><span class="oz-brace oz-brace--r">}</span>';
  return el;
}

function legendItem(bg: string | null, label: string) {
  const dot = bg
    ? html.span({ class: 'oc-dot', style: `background:${bg}` })
    : html.span({ class: 'oc-dot oc-dot--ring' });
  const li = html.li();
  li.appendChild(dot);
  li.appendChild(text(` ${label}`));
  return li;
}

export const main = (id: string = 'main-container') => {
  const state = get();

  return html.div(
    { id, class: 'oc-app oz-enter' },
    [
      header(),
      statsStrip(),
      filterBar(),
      html.div({ class: 'oc-app__body' }, [
        html.div({ id: 'graph-container', class: 'oc-graph' }),
        html.aside({ class: 'oc-detail oc-detail--empty' }, [
          html.div({ class: 'oz-eyebrow' }, 'No selection'),
          html.p(
            { class: 'oz-mute', style: 'margin-top:12px;font-size:13px' },
            'Click any node in the graph to inspect its parameters, output, edges and history.'
          ),
          html.div({ class: 'oc-detail__legend', style: 'margin-top:28px;padding-top:20px;border-top:1px solid var(--hairline)' }, [
            html.div({ class: 'oz-eyebrow', style: 'margin-bottom:10px' }, 'Legend'),
            html.ul({ class: 'oc-legend' }, [
              legendItem('var(--accent)', 'running'),
              legendItem('var(--success)', 'completed'),
              legendItem('var(--danger)', 'failed'),
              legendItem('var(--gold)', 'waiting'),
              legendItem(null, 'pending'),
            ]),
          ]),
        ]),
      ]),
      footline(),
    ]
  );
};

function header() {
  const state = get();
  return html.div({ class: 'oc-pageline' }, [
    orcaLogo(),
    html.div({ class: 'oc-pageline__center' }, [
      html.div({ class: 'c-path' }, [
        html.span({ class: 'c-slash' }, '/projects/'),
        html.span({ class: 'c-name' }, 'orca'),
      ]),
      html.div({ class: 'c-tag' }, 'v2'),
    ]),
    html.div({ class: 'oc-pageline__actions' }, [
      html.button({ class: 'oz-btn oc-btn' }, 'Import YAML'),
      html.button({ class: 'oz-btn oc-btn' }, '+ Action'),
      html.button({ class: 'oz-btn oz-btn--primary oc-btn' }, '+ Task'),
      html.button({
        class: 'oc-themetoggle',
        'aria-label': 'toggle theme',
        onclick: async () => {
          const current = get().theme;
          modifiers.setTheme(current === 'light' ? 'dark' : 'light');
        },
      }, state.theme === 'light' ? '\u263E' : '\u2600'),
    ]),
  ]);
}

function statsStrip() {
  const state = get();
  const s = state.stats;
  const h = s?.actions || {};
  const total = (h.total as number) || 0;
  const cost = s?.total_cost_usd ?? 0;
  const execState = s?.executor || state.executorState?.state || 'idle';
  const inactive = (h.inactive as number) || 0;

  const stat = (label: string, value: string, sub: string, cls?: string) => {
    return html.div({ class: 'oc-stat' }, [
      html.span({ class: 'oc-stat__label' }, label),
      html.span({ class: `oc-stat__value ${cls || ''}` }, value),
      html.span({ class: 'oc-stat__sub' }, sub),
    ]);
  };

  return html.div({ id: 'stats-strip', class: 'oc-stats' }, [
    stat('total actions', String(total), `${inactive} blocked`),
    stat('running', String(h.running || 0), execState, 'oc-stat__value--accent'),
    stat('pending', String(h.pending || 0), 'queued'),
    stat('completed', String(h.completed || 0), 'passed', 'oc-stat__value--success'),
    stat('failed', String(h.failed || 0), 'in retry', 'oc-stat__value--danger'),
    stat('waiting', String(h.waiting || 0), 'human gate', 'oc-stat__value--gold'),
    stat('total cost', `$${cost.toFixed(2)}`, ''),
  ]);
}

export const renderStatsStrip = () => {
  const el = document.getElementById('stats-strip');
  if (!el) return;
  el.replaceWith(statsStrip());
};

function filterBar() {
  const tags = [
    { key: 'type:agent', label: 'type:agent' },
    { key: 'type:command', label: 'type:command' },
    { key: 'status:running', label: 'running', dot: 'var(--accent)' },
    { key: 'status:failed', label: 'failed', dot: 'var(--danger)' },
    { key: 'status:waiting', label: 'waiting', dot: 'var(--gold)' },
    { key: 'status:completed', label: 'completed', dot: 'var(--success)' },
  ];

  return html.div({ class: 'oc-filter' }, [
    html.span({ class: 'oc-filter__label' }, 'filter'),
    ...tags.map(t => {
      const btn = html.button({ class: 'oc-tag', 'data-filter': t.key });
      if (t.dot) btn.appendChild(html.span({ class: 'oc-tag__dot', style: `background:${t.dot}` }));
      btn.appendChild(text(t.label));
      return btn;
    }),
  ]);
}

function footline() {
  const state = get();
  const execState = state.stats?.executor || state.executorState?.state || 'unknown';
  const connStatus = state.connected ? 'SSE connected' : 'disconnected';

  return html.div({ id: 'footline', class: 'oc-footline' }, [
    html.span(`scheduler \u00B7 serial \u00B7 ${execState}`),
    html.span('state \u00B7 orca.sqlite'),
    html.span({ class: 'oc-footline__rate' }, `live \u00B7 ${connStatus}`),
  ]);
}

export const renderFootline = () => {
  const el = document.getElementById('footline');
  if (!el) return;
  el.replaceWith(footline());
};

let graphFilter = 'pass';
let graphSelected: string | null = null;
let graphHover: string | null = null;
let userManuallySelected = false; // true when user clicked a node

let currentActions: ApiAction[] = [];
let currentEdges: ApiEdge[] = [];

async function fetchGraphData(): Promise<{ actions: ApiAction[]; edges: ApiEdge[] }> {
  const actions = await api.get<ApiAction[]>('/actions').catch(() => []);
  if (!actions || actions.length === 0) return getDemoFixture();

  const seen = new Set<string>();
  const edges: ApiEdge[] = [];
  for (const a of actions) {
    const detail = await api.get<{ edges: { from: ApiEdge[]; to: ApiEdge[] } }>(`/actions/${a.id}`).catch(() => null);
    if (detail?.edges?.from) {
      for (const e of detail.edges.from) {
        const key = `${e.from_action}-${e.to_action}-${e.condition}`;
        if (!seen.has(key)) { seen.add(key); edges.push(e); }
      }
    }
  }

  return { actions, edges };
}

let drawGraph: (() => void) | null = null;

export const initGraph = async () => {
  const container = document.getElementById('graph-container');
  if (!container) return;

  const data = await fetchGraphData();
  currentActions = data.actions;
  currentEdges = data.edges;

  const draw = () => {
    renderGraph(container, {
      actions: currentActions,
      edges: currentEdges,
      filter: graphFilter,
      selectedId: graphSelected,
      hoverId: graphHover,
      onSelect: (id) => {
        if (graphSelected === id) {
          graphSelected = null;
          userManuallySelected = false;
        } else {
          graphSelected = id;
          userManuallySelected = true;
        }
        draw();
        renderDetail(graphSelected);
      },
      onHover: (id) => {
        graphHover = id;
        draw();
      },
    });
  };

  drawGraph = draw;
  draw();
};

/** Refresh graph data from the API and redraw. Called on SSE reconnect and visibility change. */
export const refreshGraph = async () => {
  if (!drawGraph) return;
  const fresh = await fetchGraphData();
  const changed = fresh.actions.length !== currentActions.length ||
    JSON.stringify(fresh.actions.map(a => a.status)) !== JSON.stringify(currentActions.map(a => a.status));
  if (changed) {
    currentActions = fresh.actions;
    currentEdges = fresh.edges;

    // Auto-follow: if user hasn't manually selected a node, show the running action
    if (!userManuallySelected) {
      const running = currentActions.find(a => a.status === 'running');
      const newId = running?.id ?? null;
      if (newId !== graphSelected) {
        graphSelected = newId;
        renderDetail(graphSelected);
      }
    }

    drawGraph();
  }
};
