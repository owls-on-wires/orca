/**
 * The store — a PURE reducer over SSE events + REST seeds. No terminal, no
 * React, no network here: given a `TuiState` and an event, it returns the next
 * `TuiState`. This is the testable heart of the TUI; the Ink layer is a thin
 * projection of whatever this produces.
 *
 * Event shapes mirror exactly what `v2/server.ts` + `executor-worker.ts`
 * broadcast (action_started/completed/waiting, tool_use, edge_traversed,
 * executor_state, unhandled_failure, stats) and what P5 added for the braid
 * (l3_message / graph_edit / l3_result).
 */

import type {
  TuiState,
  CircuitRow,
  BraidMessage,
  ActionStatus,
} from "./types";

export interface RawAction {
  id: string;
  type: string;
  status: string;
  cost_usd?: number;
  iteration?: number;
}

export interface SseEvent {
  event: string;
  data: Record<string, unknown>;
}

// A single graph edit as carried on a `graph_edit` SSE event (P5 vocabulary).
interface Edit {
  op: string;
  id?: string;
  type?: string;
  initial?: boolean;
  from?: string;
  to?: string;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function conditionToStatus(condition: string): ActionStatus {
  if (condition === "pass") return "completed";
  if (condition === "stuck") return "stuck";
  if (condition === "timeout" || condition === "error" || condition === "max_turns" || condition === "cost_exceeded") {
    return "failed";
  }
  return "failed"; // fail
}

function blankRow(id: string, type = "agent", status: ActionStatus = "inactive"): CircuitRow {
  return { id, type, status, costUsd: 0, durationMs: 0, iteration: 0, successors: [], depth: 0 };
}

/** Recompute topological depth (BFS from roots; back-edges ignored) so the
 *  circuit pane can draw tree connectors. */
function withDepths(actions: Record<string, CircuitRow>, order: string[]): Record<string, CircuitRow> {
  const indeg = new Map<string, number>();
  for (const id of order) indeg.set(id, 0);
  for (const id of order) {
    for (const s of actions[id]?.successors ?? []) {
      if (indeg.has(s) && s !== id) indeg.set(s, (indeg.get(s) ?? 0) + 1);
    }
  }
  const depth = new Map<string, number>();
  const queue: string[] = [];
  for (const id of order) if ((indeg.get(id) ?? 0) === 0) { depth.set(id, 0); queue.push(id); }
  const seen = new Set(queue);
  while (queue.length) {
    const cur = queue.shift()!;
    const d = depth.get(cur) ?? 0;
    for (const s of actions[cur]?.successors ?? []) {
      if (!actions[s] || s === cur) continue;
      const nd = d + 1;
      if (nd > (depth.get(s) ?? -1)) depth.set(s, nd);
      if (!seen.has(s)) { seen.add(s); queue.push(s); }
    }
  }
  const next: Record<string, CircuitRow> = {};
  for (const id of order) {
    const row = actions[id];
    next[id] = { ...row, depth: depth.get(id) ?? 0 };
  }
  return next;
}

let braidSeq = 0;
function braidMsg(partial: Omit<BraidMessage, "id" | "ts"> & { ts: number }): BraidMessage {
  return { id: `b${++braidSeq}`, ...partial };
}

function bump(state: TuiState, patch: Partial<TuiState>): TuiState {
  return { ...state, ...patch, rev: state.rev + 1 };
}

// ---------------------------------------------------------------------------
// Row mutation
// ---------------------------------------------------------------------------

function upsertRow(
  state: TuiState,
  id: string,
  patch: Partial<CircuitRow>,
  seed?: Partial<CircuitRow>,
): TuiState {
  const existing = state.actions[id];
  const base = existing ?? blankRow(id, seed?.type, seed?.status as ActionStatus);
  const row: CircuitRow = { ...base, ...seed, ...patch };
  const actions = { ...state.actions, [id]: row };
  const order = existing ? state.order : [...state.order, id];
  return bump(state, { actions, order, hasCircuit: true });
}

// ---------------------------------------------------------------------------
// Public: seed from REST
// ---------------------------------------------------------------------------

export function seedActions(state: TuiState, raw: RawAction[]): TuiState {
  if (raw.length === 0) return state;
  const actions: Record<string, CircuitRow> = { ...state.actions };
  const order = [...state.order];
  for (const a of raw) {
    const existing = actions[a.id];
    const row: CircuitRow = {
      ...(existing ?? blankRow(a.id, a.type)),
      type: a.type,
      status: (a.status as ActionStatus) ?? "inactive",
      costUsd: a.cost_usd ?? existing?.costUsd ?? 0,
      iteration: a.iteration ?? existing?.iteration ?? 0,
    };
    actions[a.id] = row;
    if (!existing) order.push(a.id);
  }
  return bump(state, { actions: withDepths(actions, order), order, hasCircuit: true });
}

/** A user's outgoing chat message — added locally, not via SSE. */
export function addUserMessage(state: TuiState, text: string): TuiState {
  const braid = [...state.braid, braidMsg({ source: "user", kind: "user", text, ts: state.rev })];
  return bump(state, { braid });
}

// ---------------------------------------------------------------------------
// Public: apply one SSE event
// ---------------------------------------------------------------------------

export function applyEvent(state: TuiState, ev: SseEvent): TuiState {
  const d = ev.data ?? {};
  switch (ev.event) {
    case "connected":
      return state;

    case "action_started":
      return upsertRow(state, d.action_id as string, { status: "running" }, { type: d.type as string });

    case "action_completed": {
      const id = d.action_id as string;
      const status = conditionToStatus((d.condition as string) ?? "fail");
      const addCost = (d.cost_usd as number) ?? 0;
      const prev = state.actions[id];
      return upsertRow(state, id, {
        status,
        currentTool: undefined,
        costUsd: (prev?.costUsd ?? 0) + addCost,
      });
    }

    case "action_waiting":
      return upsertRow(state, d.action_id as string, { status: "waiting" });

    case "tool_use":
      return upsertRow(state, d.action_id as string, { currentTool: d.tool_name as string });

    case "edge_traversed": {
      const from = d.from as string;
      const to = d.to as string;
      if (!from || !to) return state;
      const row = state.actions[from];
      if (!row) return state;
      if (row.successors.includes(to)) return state;
      const actions = { ...state.actions, [from]: { ...row, successors: [...row.successors, to] } };
      return bump(state, { actions: withDepths(actions, state.order), order: state.order });
    }

    case "executor_state":
      return bump(state, { stats: { ...state.stats, executor: (d.state as Stats["executor"]) ?? state.stats.executor } });

    case "stats": {
      const a = (d.actions as Record<string, number>) ?? {};
      const byStatus: Record<string, number> = {};
      for (const [k, v] of Object.entries(a)) if (k !== "total") byStatus[k] = v as number;
      return bump(state, {
        stats: {
          total: (a.total as number) ?? state.stats.total,
          byStatus,
          costUsd: (d.total_cost_usd as number) ?? state.stats.costUsd,
          executor: (d.executor as Stats["executor"]) ?? state.stats.executor,
        },
      });
    }

    case "unhandled_failure": {
      const id = d.action_id as string | undefined;
      const reason = d.reason as string | undefined;
      const text = reason === "circuit_breaker"
        ? `⚠ circuit breaker tripped: ${JSON.stringify(d.breach)}`
        : `⚠ ${id ?? "action"} failed unhandled (${d.condition ?? "?"})`;
      const braid = [...state.braid, braidMsg({ source: id ?? "executor", kind: "escalation", text, needsAttention: true, ts: state.rev })];
      let next = bump(state, { braid });
      if (id && state.actions[id]) next = upsertRow(next, id, { status: "failed" });
      return next;
    }

    case "l3_message": {
      const text = (d.text as string) ?? "";
      const mid = (d.message_id as string) ?? "l3";
      const source = (d.source as string) ?? "l3";
      // Coalesce streamed text: append to the trailing braid message if it's the
      // same L3 turn, else start a new one.
      const last = state.braid[state.braid.length - 1];
      if (last && last.kind === "text" && last.id === `stream:${mid}`) {
        const updated = { ...last, text: last.text + text };
        return bump(state, { braid: [...state.braid.slice(0, -1), updated] });
      }
      const msg: BraidMessage = { id: `stream:${mid}`, source, kind: "text", text, ts: state.rev };
      return bump(state, { braid: [...state.braid, msg] });
    }

    case "graph_edit":
      return applyGraphEdit(state, d);

    case "l3_result": {
      const isErr = d.is_error === true;
      const out = d.output as Record<string, unknown> | undefined;
      const applied = (d.applied as number) ?? 0;
      const rejected = (d.rejected as number) ?? 0;
      const summary = isErr
        ? `L3 turn errored: ${d.error ?? out?.summary ?? "unknown"}`
        : `${out?.summary ?? "done"} · +${applied} edit(s)${rejected ? `, ${rejected} rejected` : ""}`;
      const braid = [...state.braid, braidMsg({ source: "l3", kind: "result", text: summary, ts: state.rev })];
      return bump(state, { braid });
    }

    default:
      return state;
  }
}

// ---------------------------------------------------------------------------
// graph_edit — the P5→P6 seam: render a card in the braid AND update the circuit
// pane in the same tick (spec-tui acceptance #2).
// ---------------------------------------------------------------------------

function applyGraphEdit(state: TuiState, d: Record<string, unknown>): TuiState {
  const ok = d.ok === true;
  const edits = (d.edits as Edit[]) ?? [];
  const issues = (d.issues as string[]) ?? [];
  const summary = ok
    ? edits.map((e) => editLabel(e)).join(", ") || "no-op"
    : `rejected: ${(d.error as string) ?? issues[0] ?? "invalid"}`;

  const card: BraidMessage = braidMsg({
    source: "l3",
    kind: "graph_edit",
    text: ok ? `circuit edit: ${summary}` : `circuit edit rejected`,
    editCard: { ok, summary, issues },
    ts: state.rev,
  });

  let next = bump(state, { braid: [...state.braid, card] });
  if (!ok) return next; // rejected batches leave the circuit untouched

  // Apply the accepted edits to the circuit rows immediately.
  let actions = { ...next.actions };
  let order = [...next.order];
  for (const e of edits) {
    if (e.op === "add_action" && e.id) {
      if (!actions[e.id]) order.push(e.id);
      actions[e.id] = {
        ...(actions[e.id] ?? blankRow(e.id, e.type ?? "agent")),
        type: e.type ?? actions[e.id]?.type ?? "agent",
        status: (e.initial ? "pending" : "inactive") as ActionStatus,
      };
    } else if (e.op === "add_edge" && e.from && e.to) {
      const row = actions[e.from];
      if (row && !row.successors.includes(e.to)) {
        actions[e.from] = { ...row, successors: [...row.successors, e.to] };
      }
    } else if (e.op === "remove_action" && e.id) {
      delete actions[e.id];
      order = order.filter((x) => x !== e.id);
      for (const k of order) {
        if (actions[k].successors.includes(e.id)) {
          actions[k] = { ...actions[k], successors: actions[k].successors.filter((s) => s !== e.id) };
        }
      }
    }
  }
  return bump(next, { actions: withDepths(actions, order), order, hasCircuit: order.length > 0 });
}

function editLabel(e: Edit): string {
  switch (e.op) {
    case "add_action": return `+${e.id}`;
    case "add_edge": return `${e.from}→${e.to}`;
    case "remove_action": return `−${e.id}`;
    case "update_action": return `~${e.id}`;
    case "remove_edge": return `−edge`;
    default: return e.op;
  }
}

// Local alias so the file reads without importing Stats explicitly everywhere.
type Stats = TuiState["stats"];
