/**
 * TUI state vocabulary. Deliberately provider/transport-neutral: the store is a
 * pure reducer over SSE events, so all of this is plain data that unit tests can
 * assert on without a terminal or a live server.
 */

export type ActionStatus =
  | "inactive"
  | "pending"
  | "running"
  | "completed"
  | "failed"
  | "skipped"
  | "waiting"
  | "stuck";

/** A row in the circuit pane (list-as-default; see spec-tui). */
export interface CircuitRow {
  id: string;
  type: string;
  status: ActionStatus;
  costUsd: number;
  durationMs: number;
  iteration: number;
  currentTool?: string;
  /** Ids this row routes to (for tree connectors / topology). */
  successors: string[];
  /** Depth in the topological layering (for `├─ │` indentation). */
  depth: number;
}

/** One message in the braid (multi-agent activity feed). Source-tagged. */
export interface BraidMessage {
  id: string;
  /** Which agent emitted this: "user", "l3", an action id (L0), a supervisor… */
  source: string;
  kind: "user" | "text" | "graph_edit" | "result" | "escalation" | "system";
  text: string;
  /** For graph_edit cards: a compact rendering of the applied/rejected edits. */
  editCard?: { ok: boolean; summary: string; issues: string[] };
  /** True when the message needs the user (approval / clarifying question). */
  needsAttention?: boolean;
  ts: number;
}

export interface Stats {
  total: number;
  byStatus: Record<string, number>;
  costUsd: number;
  /** Executor lifecycle as reported by the daemon. */
  executor: "running" | "paused" | "idle";
}

export type Focus = "conversation" | "circuit";

export interface TuiState {
  /** Circuit rows keyed by id (order preserved via `order`). */
  actions: Record<string, CircuitRow>;
  order: string[];
  braid: BraidMessage[];
  stats: Stats;
  /** Whether any work has been reified yet — the circuit pane appears only then. */
  hasCircuit: boolean;
  /** Currently-selected circuit row id (detail pane), or null. */
  selected: string | null;
  focus: Focus;
  /** Build identity for the top bar. */
  buildName: string;
  /** ms since attach — drives elapsed + burn-rate. */
  startedAt: number;
  /** A monotonically-increasing revision, bumped on every applied event, so a
   *  render layer can cheaply detect "did anything change". */
  rev: number;
}

export function initialState(buildName = "orca", now = 0): TuiState {
  return {
    actions: {},
    order: [],
    braid: [],
    stats: { total: 0, byStatus: {}, costUsd: 0, executor: "idle" },
    hasCircuit: false,
    selected: null,
    focus: "conversation",
    buildName,
    startedAt: now,
    rev: 0,
  };
}
