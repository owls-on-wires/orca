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
        `INSERT INTO actions (id, type, status, params, output, tags, cost_usd, iteration, created_at, updated_at, started_at, completed_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          action.id,
          action.type,
          action.status,
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
// Validation
// ---------------------------------------------------------------------------

export function validateGraph(db: Database): string[] {
  const issues: string[] = [];

  // Check edges referencing missing actions
  const badEdges = db
    .query(
      `SELECT e.id, e.from_action, e.to_action FROM edges e
       WHERE NOT EXISTS (SELECT 1 FROM actions WHERE id = e.from_action)
          OR NOT EXISTS (SELECT 1 FROM actions WHERE id = e.to_action)`,
    )
    .all() as Array<{ id: number; from_action: string; to_action: string }>;

  for (const edge of badEdges) {
    issues.push(
      `Edge ${edge.id} references missing action(s): ${edge.from_action} → ${edge.to_action}`,
    );
  }

  // Check non-completed actions with no outgoing edges (potential dead ends)
  const deadEnds = db
    .query(
      `SELECT a.id FROM actions a
       WHERE a.status NOT IN ('completed', 'skipped', 'failed')
         AND NOT EXISTS (SELECT 1 FROM edges e WHERE e.from_action = a.id)`,
    )
    .all() as Array<{ id: string }>;

  for (const action of deadEnds) {
    issues.push(
      `Action '${action.id}' has no outgoing edges and is not completed`,
    );
  }

  // Check for actions with no incoming edges and not the first action (orphans)
  const orphans = db
    .query(
      `SELECT a.id FROM actions a
       WHERE NOT EXISTS (SELECT 1 FROM edges e WHERE e.to_action = a.id)
         AND (SELECT COUNT(*) FROM actions) > 1
         AND a.status = 'pending'`,
    )
    .all() as Array<{ id: string }>;

  // Only flag orphans if there are edges in the graph (indicating it's not a fresh graph)
  const edgeCount = db.query("SELECT COUNT(*) as cnt FROM edges").get() as {
    cnt: number;
  };
  if (edgeCount.cnt > 0) {
    for (const action of orphans) {
      // Check it's not a target of any edge
      const isTarget = db
        .query("SELECT 1 FROM edges WHERE to_action = ?")
        .get(action.id);
      if (!isTarget) {
        issues.push(`Action '${action.id}' is unreachable (no incoming edges)`);
      }
    }
  }

  return issues;
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
