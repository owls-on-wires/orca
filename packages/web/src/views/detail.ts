import { html } from '@owls-on-wires/novel';
import { api } from '../services/api';
import type { ApiAction, ApiEdge } from './graph';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface ActionDetail {
  action: ApiAction;
  edges: { from: ApiEdge[]; to: ApiEdge[] };
  history: Array<{
    id: number;
    action_id: string;
    iteration: number;
    event_type: string;
    data: Record<string, unknown> | null;
    timestamp: string;
  }>;
}

interface LogEntry {
  timestamp: string;
  event_type: string;
  label?: string;
  tool_name?: string;
  tool_input?: Record<string, unknown>;
  cost_usd?: number;
  num_turns?: number;
  duration_ms?: number;
  is_error?: boolean;
  structured_output?: Record<string, unknown>;
  prompt?: string;
  prompt_length?: number;
  [k: string]: unknown;
}

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

let currentSSE: EventSource | null = null;
let currentActionId: string | null = null;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function el(tag: string, cls: string, children?: (Node | string)[]): HTMLElement {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (children) {
    for (const c of children) {
      e.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
    }
  }
  return e;
}

function span(cls: string, text: string): HTMLSpanElement {
  const s = document.createElement('span');
  if (cls) s.className = cls;
  s.textContent = text;
  return s;
}

function statusColor(status: string): string {
  switch (status) {
    case 'running': return 'var(--accent)';
    case 'completed': return 'var(--success)';
    case 'failed': return 'var(--danger)';
    case 'waiting': return 'var(--gold)';
    case 'pending': return 'var(--fg-mute)';
    default: return 'var(--fg-mute)';
  }
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
  return `${(ms / 60000).toFixed(1)}m`;
}

function summarizeTool(name: string, input: Record<string, unknown>): string {
  switch (name) {
    case 'Read': return shorten(String(input.file_path || ''), 50);
    case 'Write': return shorten(String(input.file_path || ''), 50);
    case 'Edit': return shorten(String(input.file_path || ''), 50);
    case 'Bash': return shorten(String(input.command || input.description || ''), 60);
    case 'Glob': return shorten(String(input.pattern || ''), 50);
    case 'Grep': return shorten(String(input.pattern || ''), 50);
    case 'StructuredOutput': {
      const status = (input as any).status;
      const summary = (input as any).summary;
      return status ? `${status}: ${shorten(summary || '', 40)}` : shorten(JSON.stringify(input), 50);
    }
    default: return shorten(JSON.stringify(input), 50);
  }
}

function shorten(s: string, max: number): string {
  return s.length > max ? s.slice(0, max - 1) + '…' : s;
}

function relativeTime(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  if (ms < 60000) return `${Math.floor(ms / 1000)}s ago`;
  if (ms < 3600000) return `${Math.floor(ms / 60000)}m ago`;
  if (ms < 86400000) return `${Math.floor(ms / 3600000)}h ago`;
  return `${Math.floor(ms / 86400000)}d ago`;
}

// ---------------------------------------------------------------------------
// Render
// ---------------------------------------------------------------------------

export async function renderDetail(actionId: string | null) {
  const aside = document.querySelector('.oc-detail') as HTMLElement | null;
  if (!aside) return;

  // Teardown previous SSE
  if (currentSSE) { currentSSE.close(); currentSSE = null; }
  currentActionId = actionId;

  if (!actionId) {
    aside.className = 'oc-detail oc-detail--empty';
    aside.innerHTML = '';
    aside.appendChild(el('div', 'oz-eyebrow', ['No selection']));
    aside.appendChild(el('p', 'oz-mute oc-detail__hint', [
      'Click any node in the graph to inspect its parameters, output, edges and history.'
    ]));
    return;
  }

  aside.className = 'oc-detail';
  aside.innerHTML = '';

  // Loading state
  aside.appendChild(el('div', 'oz-eyebrow', ['Loading…']));

  let detail: ActionDetail;
  try {
    detail = await api.get<ActionDetail>(`/actions/${actionId}`);
  } catch {
    aside.innerHTML = '';
    aside.appendChild(el('div', 'oz-eyebrow oc-detail__error', ['Failed to load action']));
    return;
  }

  // Load logs for non-inactive actions
  let logs: LogEntry[] = [];
  if (detail.action.status !== 'inactive' && detail.action.status !== 'pending') {
    logs = await api.get<LogEntry[]>(`/actions/${actionId}/logs`).catch(() => []);
  }

  // Bail if selection changed during fetch
  if (currentActionId !== actionId) return;

  aside.innerHTML = '';
  aside.appendChild(buildDetailContent(detail, logs));

  // Live updates for running actions
  if (detail.action.status === 'running') {
    connectLiveUpdates(actionId, aside);
  }
}

function buildDetailContent(detail: ActionDetail, logs: LogEntry[]): DocumentFragment {
  const frag = document.createDocumentFragment();
  const { action } = detail;

  // Header
  const header = el('div', 'oc-detail__header', []);
  header.appendChild(el('div', 'oc-detail__id', [action.id]));

  const meta = el('div', 'oc-detail__meta', []);
  meta.appendChild(span('oc-detail__type', action.type));
  meta.appendChild(span('oc-detail__sep', ' · '));
  const statusSpan = span('oc-detail__status', action.status);
  statusSpan.style.color = statusColor(action.status);
  meta.appendChild(statusSpan);
  if (action.iteration > 0) {
    meta.appendChild(span('oc-detail__sep', ' · '));
    meta.appendChild(span('', `iter ${action.iteration}`));
  }
  header.appendChild(meta);

  if (action.cost_usd > 0 || action.started_at) {
    const stats = el('div', 'oc-detail__stats', []);
    if (action.cost_usd > 0) stats.appendChild(span('', `$${action.cost_usd.toFixed(4)}`));
    if (action.started_at) {
      if (action.cost_usd > 0) stats.appendChild(span('oc-detail__sep', ' · '));
      stats.appendChild(span('', relativeTime(action.started_at)));
    }
    header.appendChild(stats);
  }

  frag.appendChild(header);

  // Edges
  const edgeSection = el('div', 'oc-detail__section', []);
  edgeSection.appendChild(el('div', 'oz-eyebrow', ['Edges']));
  const edgeList = el('div', 'oc-detail__edges', []);

  for (const e of detail.edges.to) {
    const row = el('div', 'oc-detail__edge', []);
    row.appendChild(span('oc-detail__edge-dir', '←'));
    row.appendChild(span('oc-detail__edge-id', e.from_action));
    row.appendChild(span('oc-detail__edge-cond', `[${e.condition}]`));
    edgeList.appendChild(row);
  }
  for (const e of detail.edges.from) {
    const row = el('div', 'oc-detail__edge', []);
    row.appendChild(span('oc-detail__edge-dir', '→'));
    row.appendChild(span('oc-detail__edge-id', e.to_action));
    row.appendChild(span('oc-detail__edge-cond', `[${e.condition}]`));
    edgeList.appendChild(row);
  }
  edgeSection.appendChild(edgeList);
  frag.appendChild(edgeSection);

  // Tool calls
  const toolCalls = logs.filter(l => l.event_type === 'tool_use');
  if (toolCalls.length > 0 || action.status === 'running') {
    const toolSection = el('div', 'oc-detail__section', []);
    const toolHeader = el('div', 'oz-eyebrow', [
      `Tool Calls${toolCalls.length ? ` (${toolCalls.length})` : ''}`
    ]);
    toolSection.appendChild(toolHeader);

    const toolList = el('div', 'oc-detail__tools', []);
    toolList.id = 'detail-tool-list';
    for (const tc of toolCalls) {
      toolList.appendChild(buildToolRow(tc.tool_name!, tc.tool_input ?? {}));
    }
    toolSection.appendChild(toolList);
    frag.appendChild(toolSection);
  }

  // Output
  if (action.output) {
    const outSection = el('div', 'oc-detail__section', []);
    outSection.appendChild(el('div', 'oz-eyebrow', ['Output']));
    const outContent = el('div', 'oc-detail__output', []);

    const statusLine = el('div', 'oc-detail__output-status', []);
    const outStatusSpan = span('', action.output.status);
    outStatusSpan.style.color = action.output.status === 'passed' ? 'var(--success)' : 'var(--danger)';
    statusLine.appendChild(outStatusSpan);
    outContent.appendChild(statusLine);

    if (action.output.summary) {
      const summary = el('div', 'oc-detail__output-summary', [
        shorten(action.output.summary, 300)
      ]);
      outContent.appendChild(summary);
    }
    if (action.output.notes) {
      outContent.appendChild(el('div', 'oc-detail__output-notes', [action.output.notes]));
    }
    // Show stdout/stderr for command actions
    if (action.output.stderr && typeof action.output.stderr === 'string') {
      const pre = document.createElement('pre');
      pre.className = 'oc-detail__pre';
      pre.textContent = shorten(action.output.stderr as string, 500);
      outContent.appendChild(pre);
    }
    outSection.appendChild(outContent);
    frag.appendChild(outSection);
  }

  // Params (collapsed)
  if (action.params && Object.keys(action.params).length > 0) {
    const paramSection = el('div', 'oc-detail__section', []);
    const paramHeader = el('div', 'oz-eyebrow oc-detail__toggle', ['Params ▸']);
    const paramContent = el('pre', 'oc-detail__pre oc-detail__collapsed', [
      JSON.stringify(action.params, null, 2)
    ]);
    paramHeader.addEventListener('click', () => {
      paramContent.classList.toggle('oc-detail__collapsed');
      paramHeader.textContent = paramContent.classList.contains('oc-detail__collapsed')
        ? 'Params ▸' : 'Params ▾';
    });
    paramSection.appendChild(paramHeader);
    paramSection.appendChild(paramContent);
    frag.appendChild(paramSection);
  }

  // History
  if (detail.history.length > 0) {
    const histSection = el('div', 'oc-detail__section', []);
    histSection.appendChild(el('div', 'oz-eyebrow', ['History']));
    const histList = el('div', 'oc-detail__history', []);
    for (const h of detail.history) {
      const data = h.data as Record<string, unknown> | null;
      const condition = data?.condition as string ?? h.event_type;
      const cost = data?.cost_usd as number | undefined;

      const row = el('div', 'oc-detail__hist-row', []);
      row.appendChild(span('oc-detail__hist-iter', `iter ${h.iteration}`));
      row.appendChild(span('oc-detail__hist-cond', condition));
      if (cost !== undefined) {
        row.appendChild(span('oc-detail__hist-cost', `$${cost.toFixed(4)}`));
      }
      row.appendChild(span('oc-detail__hist-time', relativeTime(h.timestamp)));
      histList.appendChild(row);
    }
    histSection.appendChild(histList);
    frag.appendChild(histSection);
  }

  return frag;
}

function buildToolRow(toolName: string, toolInput: Record<string, unknown>): HTMLElement {
  const row = el('div', 'oc-detail__tool', []);
  row.appendChild(span('oc-detail__tool-name', toolName));
  row.appendChild(span('oc-detail__tool-summary', summarizeTool(toolName, toolInput)));
  return row;
}

// ---------------------------------------------------------------------------
// Live SSE for running actions
// ---------------------------------------------------------------------------

function connectLiveUpdates(actionId: string, aside: HTMLElement) {
  const url = `${api.getBaseUrl()}/actions/${actionId}/events`;
  currentSSE = new EventSource(url);

  currentSSE.addEventListener('tool_use', (event: MessageEvent) => {
    if (currentActionId !== actionId) return;
    const data = JSON.parse(event.data);
    const toolList = document.getElementById('detail-tool-list');
    if (toolList) {
      toolList.appendChild(buildToolRow(data.tool_name, data.tool_input ?? {}));
      // Update count in header
      const count = toolList.children.length;
      const header = toolList.previousElementSibling;
      if (header) header.textContent = `Tool Calls (${count})`;
      // Scroll to bottom
      toolList.scrollTop = toolList.scrollHeight;
    }
  });

  currentSSE.addEventListener('action_completed', () => {
    if (currentActionId !== actionId) return;
    // Re-render with final data
    renderDetail(actionId);
  });

  currentSSE.onerror = () => {
    // Silently handle SSE errors
  };
}

export function cleanupDetail() {
  if (currentSSE) { currentSSE.close(); currentSSE = null; }
  currentActionId = null;
}
