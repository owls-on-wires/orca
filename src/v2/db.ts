import { Database } from "bun:sqlite";
import type {
  ActionConfig,
  ActionStatus,
  EdgeCondition,
  EdgeConfig,
  HistoryEntry,
} from "./schema";

const SCHEMA = `
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS actions (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  params JSON NOT NULL DEFAULT '{}',
  output JSON,
  tags JSON NOT NULL DEFAULT '[]',
  cost_usd REAL DEFAULT 0,
  iteration INTEGER DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  started_at TEXT,
  completed_at TEXT
);

CREATE TABLE IF NOT EXISTS edges (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  from_action TEXT NOT NULL REFERENCES actions(id) ON DELETE CASCADE,
  to_action TEXT NOT NULL REFERENCES actions(id) ON DELETE CASCADE,
  condition TEXT NOT NULL,
  UNIQUE(from_action, to_action, condition)
);

CREATE TABLE IF NOT EXISTS history (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  action_id TEXT NOT NULL REFERENCES actions(id) ON DELETE CASCADE,
  iteration INTEGER,
  event_type TEXT NOT NULL,
  data JSON,
  timestamp TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_actions_status ON actions(status);
CREATE INDEX IF NOT EXISTS idx_actions_type ON actions(type);
CREATE INDEX IF NOT EXISTS idx_edges_from ON edges(from_action);
CREATE INDEX IF NOT EXISTS idx_edges_to ON edges(to_action);
CREATE INDEX IF NOT EXISTS idx_history_action ON history(action_id);
`;

function rowToAction(row: Record<string, unknown>): ActionConfig {
  return {
    id: row.id as string,
    type: row.type as ActionConfig["type"],
    status: row.status as ActionStatus,
    params: JSON.parse((row.params as string) || "{}"),
    output: row.output ? JSON.parse(row.output as string) : null,
    tags: JSON.parse((row.tags as string) || "[]"),
    cost_usd: (row.cost_usd as number) ?? 0,
    iteration: (row.iteration as number) ?? 0,
    created_at: row.created_at as string,
    updated_at: row.updated_at as string,
    started_at: (row.started_at as string) ?? null,
    completed_at: (row.completed_at as string) ?? null,
  };
}

function rowToEdge(row: Record<string, unknown>): EdgeConfig {
  return {
    id: row.id as number,
    from_action: row.from_action as string,
    to_action: row.to_action as string,
    condition: row.condition as EdgeCondition,
  };
}

function rowToHistory(row: Record<string, unknown>): HistoryEntry {
  return {
    id: row.id as number,
    action_id: row.action_id as string,
    iteration: (row.iteration as number) ?? null,
    event_type: row.event_type as string,
    data: row.data ? JSON.parse(row.data as string) : null,
    timestamp: row.timestamp as string,
  };
}

export class OrcaDatabase {
  private db: Database;

  constructor(dbPath: string = ".orca/orca.db") {
    this.db = new Database(dbPath, { create: true });
    this.db.exec(SCHEMA);
  }

  get rawDb(): Database {
    return this.db;
  }

  close(): void {
    this.db.close();
  }

  // ── Actions ──

  insertAction(action: ActionConfig): void {
    this.db.run(
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
  }

  getAction(id: string): ActionConfig | null {
    const row = this.db.query("SELECT * FROM actions WHERE id = ?").get(id) as
      | Record<string, unknown>
      | null;
    return row ? rowToAction(row) : null;
  }

  updateAction(id: string, updates: Partial<ActionConfig>): void {
    const sets: string[] = [];
    const values: unknown[] = [];

    if (updates.type !== undefined) {
      sets.push("type = ?");
      values.push(updates.type);
    }
    if (updates.status !== undefined) {
      sets.push("status = ?");
      values.push(updates.status);
    }
    if (updates.params !== undefined) {
      sets.push("params = ?");
      values.push(JSON.stringify(updates.params));
    }
    if (updates.output !== undefined) {
      sets.push("output = ?");
      values.push(updates.output ? JSON.stringify(updates.output) : null);
    }
    if (updates.tags !== undefined) {
      sets.push("tags = ?");
      values.push(JSON.stringify(updates.tags));
    }
    if (updates.cost_usd !== undefined) {
      sets.push("cost_usd = ?");
      values.push(updates.cost_usd);
    }
    if (updates.iteration !== undefined) {
      sets.push("iteration = ?");
      values.push(updates.iteration);
    }
    if (updates.started_at !== undefined) {
      sets.push("started_at = ?");
      values.push(updates.started_at);
    }
    if (updates.completed_at !== undefined) {
      sets.push("completed_at = ?");
      values.push(updates.completed_at);
    }

    if (sets.length === 0) return;

    sets.push("updated_at = ?");
    const now = new Date();
    // Ensure sub-millisecond uniqueness by appending microsecond precision
    const micro = Math.floor((performance.now() % 1) * 1000);
    values.push(now.toISOString().replace("Z", `${micro.toString().padStart(3, "0")}Z`));
    values.push(id);

    this.db.run(`UPDATE actions SET ${sets.join(", ")} WHERE id = ?`, values);
  }

  deleteAction(id: string): void {
    this.db.run("DELETE FROM actions WHERE id = ?", [id]);
  }

  listActions(filters?: {
    status?: ActionStatus;
    type?: string;
    tag?: string;
  }): ActionConfig[] {
    const conditions: string[] = [];
    const values: unknown[] = [];

    if (filters?.status) {
      conditions.push("a.status = ?");
      values.push(filters.status);
    }
    if (filters?.type) {
      conditions.push("a.type = ?");
      values.push(filters.type);
    }
    if (filters?.tag) {
      conditions.push(
        "EXISTS (SELECT 1 FROM json_each(a.tags) WHERE json_each.value = ?)",
      );
      values.push(filters.tag);
    }

    const where =
      conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
    const rows = this.db
      .query(`SELECT a.* FROM actions a ${where}`)
      .all(...values) as Record<string, unknown>[];
    return rows.map(rowToAction);
  }

  getReadyActions(): ActionConfig[] {
    const rows = this.db
      .query("SELECT * FROM actions WHERE status = 'pending'")
      .all() as Record<string, unknown>[];
    return rows.map(rowToAction);
  }

  // ── Edges ──

  insertEdge(edge: EdgeConfig): number {
    const result = this.db.run(
      "INSERT INTO edges (from_action, to_action, condition) VALUES (?, ?, ?)",
      [edge.from_action, edge.to_action, edge.condition],
    );
    return Number(result.lastInsertRowid);
  }

  deleteEdge(id: number): void {
    this.db.run("DELETE FROM edges WHERE id = ?", [id]);
  }

  getEdgesFrom(actionId: string): EdgeConfig[] {
    const rows = this.db
      .query("SELECT * FROM edges WHERE from_action = ?")
      .all(actionId) as Record<string, unknown>[];
    return rows.map(rowToEdge);
  }

  getEdgesTo(actionId: string): EdgeConfig[] {
    const rows = this.db
      .query("SELECT * FROM edges WHERE to_action = ?")
      .all(actionId) as Record<string, unknown>[];
    return rows.map(rowToEdge);
  }

  getEdgesByCondition(
    actionId: string,
    condition: EdgeCondition,
  ): EdgeConfig[] {
    const rows = this.db
      .query(
        "SELECT * FROM edges WHERE from_action = ? AND condition = ?",
      )
      .all(actionId, condition) as Record<string, unknown>[];
    return rows.map(rowToEdge);
  }

  // ── History ──

  appendHistory(
    actionId: string,
    eventType: string,
    data?: unknown,
  ): void {
    this.db.run(
      "INSERT INTO history (action_id, iteration, event_type, data, timestamp) VALUES (?, (SELECT iteration FROM actions WHERE id = ?), ?, ?, ?)",
      [
        actionId,
        actionId,
        eventType,
        data !== undefined ? JSON.stringify(data) : null,
        new Date().toISOString(),
      ],
    );
  }

  getHistory(actionId: string, limit?: number): HistoryEntry[] {
    const sql = limit
      ? "SELECT * FROM history WHERE action_id = ? ORDER BY id DESC LIMIT ?"
      : "SELECT * FROM history WHERE action_id = ? ORDER BY id DESC";
    const args: unknown[] = limit ? [actionId, limit] : [actionId];
    const rows = this.db.query(sql).all(...args) as Record<string, unknown>[];
    return rows.map(rowToHistory);
  }

  // ── Bulk ──

  updateActionsByTag(tag: string, updates: Partial<ActionConfig>): number {
    const ids = this.getActionsByTag(tag).map((a) => a.id);
    for (const id of ids) {
      this.updateAction(id, updates);
    }
    return ids.length;
  }

  getActionsByTag(tag: string): ActionConfig[] {
    return this.listActions({ tag });
  }
}
