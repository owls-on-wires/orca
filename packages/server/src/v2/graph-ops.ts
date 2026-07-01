/**
 * Pure functions for graph mutation (applying deltas) and serialization.
 * Operates on raw bun:sqlite Database instances.
 */

import { Database } from "bun:sqlite";
import type {
  ActionConfig,
  EdgeCondition,
  EdgeConfig,
  GraphDelta,
  HistoryEntry,
} from "./schema";
import { createAction } from "./schema";

// ---------------------------------------------------------------------------
// Delta application
// ---------------------------------------------------------------------------

export function applyDelta(db: Database, delta: GraphDelta): void {
  switch (delta.type) {
    case "add_action": {
      const existing = db
        .query("SELECT id FROM actions WHERE id = ?")
        .get(delta.action_id);
      if (existing) {
        throw new Error(`Action '${delta.action_id}' already exists`);
      }
      const action = createAction({ id: delta.action_id, ...delta.action });
      db.run(
        `INSERT INTO actions (id, type, status, project_id, params, output, tags, cost_usd, iteration, created_at, updated_at, started_at, completed_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          action.id,
          action.type,
          action.status,
          action.project_id ?? null,
          JSON.stringify(action.params),
          action.output ? JSON.stringify(action.output) : null,
          JSON.stringify(action.tags),
          action.cost_usd,
          action.iteration,
          action.created_at,
          action.updated_at,
          action.started_at,
          action.completed_at,
        ],
      );
      break;
    }

    case "remove_action": {
      const existing = db
        .query("SELECT id FROM actions WHERE id = ?")
        .get(delta.action_id);
      if (!existing) {
        throw new Error(`Action '${delta.action_id}' does not exist`);
      }
      // CASCADE handles edges and history due to foreign keys
      db.run("DELETE FROM actions WHERE id = ?", [delta.action_id]);
      break;
    }

    case "update_params": {
      const existing = db
        .query("SELECT params FROM actions WHERE id = ?")
        .get(delta.action_id) as { params: string } | null;
      if (!existing) {
        throw new Error(`Action '${delta.action_id}' does not exist`);
      }
      const currentParams = JSON.parse(existing.params || "{}");
      const merged = { ...currentParams, ...delta.params };
      db.run(
        "UPDATE actions SET params = ?, updated_at = ? WHERE id = ?",
        [JSON.stringify(merged), new Date().toISOString(), delta.action_id],
      );
      break;
    }

    case "add_edge": {
      const fromExists = db
        .query("SELECT id FROM actions WHERE id = ?")
        .get(delta.edge.from_action);
      if (!fromExists) {
        throw new Error(
          `From action '${delta.edge.from_action}' does not exist`,
        );
      }
      const toExists = db
        .query("SELECT id FROM actions WHERE id = ?")
        .get(delta.edge.to_action);
      if (!toExists) {
        throw new Error(
          `To action '${delta.edge.to_action}' does not exist`,
        );
      }
      if (!delta.edge.condition) {
        throw new Error("Edge condition is required");
      }
      db.run(
        "INSERT INTO edges (from_action, to_action, condition) VALUES (?, ?, ?)",
        [delta.edge.from_action, delta.edge.to_action, delta.edge.condition],
      );
      break;
    }

    case "remove_edge": {
      const existing = db
        .query("SELECT id FROM edges WHERE id = ?")
        .get(delta.edge_id);
      if (!existing) {
        throw new Error(`Edge with id ${delta.edge_id} does not exist`);
      }
      db.run("DELETE FROM edges WHERE id = ?", [delta.edge_id]);
      break;
    }
  }
}

export function applyDeltas(db: Database, deltas: GraphDelta[]): void {
  db.run("BEGIN TRANSACTION");
  try {
    for (const delta of deltas) {
      applyDelta(db, delta);
    }
    db.run("COMMIT");
  } catch (err) {
    db.run("ROLLBACK");
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Validation (Design-Rule Check)
// ---------------------------------------------------------------------------

const TERMINAL_STATUSES = new Set(["completed", "skipped", "failed"]);

export interface ValidateOptions {
  /** Maximum number of action nodes permitted in the graph. */
  maxActions?: number;
  /** Maximum number of edges permitted in the graph. */
  maxEdges?: number;
}

interface GraphSnapshot {
  actions: Array<{ id: string; status: string }>;
  edges: Array<{
    id: number;
    from_action: string;
    to_action: string;
    condition: string;
  }>;
}

function loadGraph(db: Database): GraphSnapshot {
  const actions = db
    .query("SELECT id, status FROM actions")
    .all() as Array<{ id: string; status: string }>;
  const edges = db
    .query("SELECT id, from_action, to_action, condition FROM edges")
    .all() as Array<{
    id: number;
    from_action: string;
    to_action: string;
    condition: string;
  }>;
  return { actions, edges };
}

/**
 * Strongly-connected components via Tarjan's algorithm. Returns each SCC as a
 * set of node ids. A component is a *cycle* if it has more than one member, or
 * if it is a single node carrying a self-loop.
 */
function stronglyConnectedComponents(
  nodes: string[],
  adjacency: Map<string, string[]>,
): string[][] {
  let index = 0;
  const indices = new Map<string, number>();
  const lowlink = new Map<string, number>();
  const onStack = new Set<string>();
  const stack: string[] = [];
  const components: string[][] = [];

  // Iterative Tarjan to avoid stack overflow on large graphs.
  for (const root of nodes) {
    if (indices.has(root)) continue;

    const callStack: Array<{ node: string; edgeIdx: number }> = [
      { node: root, edgeIdx: 0 },
    ];

    while (callStack.length > 0) {
      const frame = callStack[callStack.length - 1];
      const { node } = frame;

      if (frame.edgeIdx === 0) {
        indices.set(node, index);
        lowlink.set(node, index);
        index++;
        stack.push(node);
        onStack.add(node);
      }

      const neighbours = adjacency.get(node) ?? [];
      if (frame.edgeIdx < neighbours.length) {
        const next = neighbours[frame.edgeIdx];
        frame.edgeIdx++;
        if (!indices.has(next)) {
          callStack.push({ node: next, edgeIdx: 0 });
        } else if (onStack.has(next)) {
          lowlink.set(
            node,
            Math.min(lowlink.get(node)!, indices.get(next)!),
          );
        }
        continue;
      }

      // Done exploring `node`.
      if (lowlink.get(node) === indices.get(node)) {
        const component: string[] = [];
        while (true) {
          const w = stack.pop()!;
          onStack.delete(w);
          component.push(w);
          if (w === node) break;
        }
        components.push(component);
      }

      callStack.pop();
      if (callStack.length > 0) {
        const parent = callStack[callStack.length - 1].node;
        lowlink.set(parent, Math.min(lowlink.get(parent)!, lowlink.get(node)!));
      }
    }
  }

  return components;
}

/**
 * A cyclic component is a LEGAL loop when it can terminate — i.e. it has a
 * close/escape condition. Escape exists when either:
 *   (a) some member has an edge leaving the component (routes outside the
 *       cycle), or
 *   (b) some member has no outgoing `pass` edge, so a `pass` result completes
 *       the action and exits the loop (a terminal escape).
 * A component where every member routes every `pass` back into the cycle and
 * never leaves it is an ILLEGAL unbounded cycle.
 */
function cycleHasEscape(
  component: Set<string>,
  edgesByFrom: Map<string, Array<{ to_action: string; condition: string }>>,
): boolean {
  for (const node of component) {
    const outgoing = edgesByFrom.get(node) ?? [];
    // (a) escape edge — leaves the component.
    if (outgoing.some((e) => !component.has(e.to_action))) return true;
    // (b) terminal escape — no pass edge, so `pass` completes and exits.
    if (!outgoing.some((e) => e.condition === "pass")) return true;
  }
  return false;
}

export function validateGraph(
  db: Database,
  options: ValidateOptions = {},
): string[] {
  const issues: string[] = [];
  const { actions, edges } = loadGraph(db);
  const actionIds = new Set(actions.map((a) => a.id));

  // --- Size caps -----------------------------------------------------------
  if (options.maxActions !== undefined && actions.length > options.maxActions) {
    issues.push(
      `Graph exceeds action cap: ${actions.length} > ${options.maxActions}`,
    );
  }
  if (options.maxEdges !== undefined && edges.length > options.maxEdges) {
    issues.push(
      `Graph exceeds edge cap: ${edges.length} > ${options.maxEdges}`,
    );
  }

  // --- Dangling edges ------------------------------------------------------
  for (const edge of edges) {
    if (!actionIds.has(edge.from_action) || !actionIds.has(edge.to_action)) {
      issues.push(
        `Edge ${edge.id} references missing action(s): ${edge.from_action} → ${edge.to_action}`,
      );
    }
  }

  // Build adjacency (only over real actions) for reachability + cycle checks.
  const edgesByFrom = new Map<
    string,
    Array<{ to_action: string; condition: string }>
  >();
  const adjacency = new Map<string, string[]>();
  const incoming = new Map<string, number>();
  for (const id of actionIds) {
    adjacency.set(id, []);
    incoming.set(id, 0);
  }
  for (const edge of edges) {
    if (!actionIds.has(edge.from_action) || !actionIds.has(edge.to_action)) {
      continue;
    }
    edgesByFrom.get(edge.from_action)?.push(edge) ??
      edgesByFrom.set(edge.from_action, [edge]);
    adjacency.get(edge.from_action)!.push(edge.to_action);
    if (edge.from_action !== edge.to_action) {
      incoming.set(edge.to_action, (incoming.get(edge.to_action) ?? 0) + 1);
    }
  }

  const statusById = new Map(actions.map((a) => [a.id, a.status]));

  // --- Dead ends: non-terminal actions with no outgoing edges --------------
  for (const action of actions) {
    if (TERMINAL_STATUSES.has(action.status)) continue;
    if ((adjacency.get(action.id) ?? []).length === 0) {
      issues.push(
        `Action '${action.id}' has no outgoing edges and is not completed`,
      );
    }
  }

  // --- Reachability: every dormant action must be activatable --------------
  // Seeds are "live" entry points: any non-inactive action (pending/running/
  // completed/… have already been entered) plus any inactive action with no
  // incoming edges. We then only flag `inactive` actions that no path can ever
  // reach — a dormant node awaiting an activation that can never arrive. A
  // `pending` action is already schedulable, so a loop's entry node (which
  // carries a back-edge) is never mistaken for unreachable.
  if (edges.length > 0 && actions.length > 1) {
    const reachable = new Set<string>();
    const queue: string[] = [];
    for (const action of actions) {
      const isSeed =
        action.status !== "inactive" || (incoming.get(action.id) ?? 0) === 0;
      if (isSeed) {
        reachable.add(action.id);
        queue.push(action.id);
      }
    }
    while (queue.length > 0) {
      const cur = queue.shift()!;
      for (const next of adjacency.get(cur) ?? []) {
        if (!reachable.has(next)) {
          reachable.add(next);
          queue.push(next);
        }
      }
    }
    for (const action of actions) {
      if (
        !reachable.has(action.id) &&
        statusById.get(action.id) === "inactive"
      ) {
        issues.push(`Action '${action.id}' is unreachable (no incoming edges)`);
      }
    }
  }

  // --- Cycle legality: legal loop vs illegal unbounded cycle ---------------
  const components = stronglyConnectedComponents(
    actions.map((a) => a.id),
    adjacency,
  );
  for (const component of components) {
    const set = new Set(component);
    const hasSelfLoop = component.some((n) =>
      (edgesByFrom.get(n) ?? []).some((e) => e.to_action === n),
    );
    const isCycle = component.length > 1 || hasSelfLoop;
    if (!isCycle) continue;

    if (!cycleHasEscape(set, edgesByFrom)) {
      issues.push(
        `Unbounded cycle detected (no escape/close condition): ${component.join(" → ")}`,
      );
    }
  }

  return issues;
}

// ---------------------------------------------------------------------------
// Validated mutation (governed chokepoint)
// ---------------------------------------------------------------------------

export interface ApplyValidatedOptions extends ValidateOptions {
  /**
   * If set to an existing action id, an `invalid_mutation` history event is
   * recorded against it when the mutation is rejected. The event is written
   * OUTSIDE the rolled-back transaction so it survives.
   */
  recordFor?: string;
}

export interface ValidatedDeltaResult {
  ok: boolean;
  /** Present on failure: whether the delta was structurally invalid (reject) or hit an execution error (retry). */
  kind?: "validation" | "execution";
  /** Newly-introduced validation issues (validation failures). */
  issues: string[];
  /** Execution error message (execution failures). */
  error?: string;
}

/**
 * The single governed chokepoint for every graph mutation. Used by the L2
 * supervisor and (P5) the L3 primary agent so no path can commit a corrupt or
 * unbounded circuit.
 *
 * Semantics:
 *   1. Compute the pre-existing validation issues (a mutation is never blamed
 *      for problems that predate it).
 *   2. Apply all deltas inside a BEGIN/…/COMMIT transaction.
 *   3. Re-validate. If the deltas INTRODUCE new issues → ROLLBACK (validation
 *      failure, reject). If an individual delta throws (duplicate id, missing
 *      reference, SQL error) → ROLLBACK (execution failure, retry).
 *   4. On any failure the graph is left byte-identical and, when `recordFor`
 *      is set, an `invalid_mutation` history event is recorded.
 */
export function applyValidatedDelta(
  db: Database,
  deltas: GraphDelta[],
  options: ApplyValidatedOptions = {},
): ValidatedDeltaResult {
  const validateOpts: ValidateOptions = {
    maxActions: options.maxActions,
    maxEdges: options.maxEdges,
  };

  const issuesBefore = new Set(validateGraph(db, validateOpts));

  let result: ValidatedDeltaResult;

  db.run("BEGIN TRANSACTION");
  try {
    for (const delta of deltas) {
      applyDelta(db, delta);
    }

    const issuesAfter = validateGraph(db, validateOpts);
    const newIssues = issuesAfter.filter((i) => !issuesBefore.has(i));

    if (newIssues.length > 0) {
      db.run("ROLLBACK");
      result = { ok: false, kind: "validation", issues: newIssues };
    } else {
      db.run("COMMIT");
      result = { ok: true, issues: [] };
    }
  } catch (err) {
    db.run("ROLLBACK");
    result = {
      ok: false,
      kind: "execution",
      issues: [],
      error: err instanceof Error ? err.message : String(err),
    };
  }

  if (!result.ok && options.recordFor) {
    recordInvalidMutation(db, options.recordFor, deltas, result);
  }

  return result;
}

function recordInvalidMutation(
  db: Database,
  actionId: string,
  deltas: GraphDelta[],
  result: ValidatedDeltaResult,
): void {
  try {
    db.run(
      `INSERT INTO history (action_id, iteration, event_type, data, timestamp)
       VALUES (?, (SELECT iteration FROM actions WHERE id = ?), ?, ?, ?)`,
      [
        actionId,
        actionId,
        "invalid_mutation",
        JSON.stringify({
          kind: result.kind,
          issues: result.issues,
          error: result.error,
          deltas,
        }),
        new Date().toISOString(),
      ],
    );
  } catch {
    // Recording is best-effort; never let it mask the rejection.
  }
}

// ---------------------------------------------------------------------------
// Serialization for LLM prompts
// ---------------------------------------------------------------------------

export function serializeGraphForPrompt(
  db: Database,
  taskTag?: string,
): string {
  // Get actions, optionally filtered by tag
  let actions: Array<Record<string, unknown>>;
  if (taskTag) {
    actions = db
      .query(
        `SELECT * FROM actions
         WHERE EXISTS (SELECT 1 FROM json_each(tags) WHERE json_each.value = ?)
         ORDER BY created_at`,
      )
      .all(taskTag) as Array<Record<string, unknown>>;
  } else {
    actions = db
      .query("SELECT * FROM actions ORDER BY created_at")
      .all() as Array<Record<string, unknown>>;
  }

  if (actions.length === 0) {
    return "No actions in graph.";
  }

  const lines: string[] = [];
  lines.push("Actions:");

  for (const row of actions) {
    const id = row.id as string;
    const type = row.type as string;
    const status = row.status as string;
    const costUsd = row.cost_usd as number;

    // Build action label
    const parts: string[] = [type, status];
    if (costUsd > 0) {
      parts.push(`$${costUsd.toFixed(2)}`);
    }

    // Get outgoing edges
    const edges = db
      .query("SELECT to_action, condition FROM edges WHERE from_action = ?")
      .all(id) as Array<{ to_action: string; condition: string }>;

    const edgeStr = edges
      .map((e) => `${e.to_action} (${e.condition})`)
      .join(" | ");

    const label = `  ${id} [${parts.join(", ")}]`;
    if (edgeStr) {
      lines.push(`${label} → ${edgeStr}`);
    } else {
      lines.push(label);
    }
  }

  // Recent history
  const history = db
    .query(
      `SELECT h.action_id, h.event_type, h.data, h.timestamp
       FROM history h
       JOIN actions a ON h.action_id = a.id
       ${taskTag ? "WHERE EXISTS (SELECT 1 FROM json_each(a.tags) WHERE json_each.value = ?)" : ""}
       ORDER BY h.id DESC LIMIT 10`,
    )
    .all(...(taskTag ? [taskTag] : [])) as Array<{
    action_id: string;
    event_type: string;
    data: string | null;
    timestamp: string;
  }>;

  if (history.length > 0) {
    lines.push("");
    lines.push("Recent history:");
    for (const entry of history) {
      const data = entry.data ? JSON.parse(entry.data) : null;
      let detail = "";
      if (data) {
        if (data.condition) detail += ` (${data.condition})`;
        if (data.turns) detail += ` — ${data.turns} turns`;
        if (data.cost_usd) detail += `, $${data.cost_usd.toFixed(2)}`;
        if (data.summary) detail += ` — "${data.summary}"`;
      }
      lines.push(`  ${entry.action_id} ${entry.event_type}${detail}`);
    }
  }

  return lines.join("\n");
}
