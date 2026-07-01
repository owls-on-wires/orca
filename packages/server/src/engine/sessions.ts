/**
 * Durable agent sessions (Layer B).
 *
 * The Orca-owned agent loop persists conversation state to SQLite so a run
 * survives process restart and can be resumed by `sessionId`. This replaces the
 * Claude Code SDK's opaque `resume`/`session_id` mechanism with state Orca fully
 * owns — consistent with everything-in-SQLite.
 *
 * A session row stores the full neutral message history plus the running usage,
 * cost, and turn count, so resuming re-seeds the exact conversation.
 */

import { Database } from "bun:sqlite";
import { mkdirSync } from "fs";
import { dirname } from "path";
import { randomUUID } from "crypto";
import type { ModelMessage } from "../models/types";
import type { Usage } from "../models/types";
import { emptyUsage } from "../models/types";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS agent_sessions (
  id TEXT PRIMARY KEY,
  action_id TEXT,
  model TEXT,
  messages JSON NOT NULL DEFAULT '[]',
  usage JSON NOT NULL DEFAULT '{}',
  cost_usd REAL NOT NULL DEFAULT 0,
  num_turns INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_agent_sessions_action ON agent_sessions(action_id);
`;

export interface SessionRecord {
  id: string;
  actionId: string | null;
  model: string | null;
  messages: ModelMessage[];
  usage: Usage;
  costUsd: number;
  numTurns: number;
  createdAt: string;
  updatedAt: string;
}

export interface SessionSnapshot {
  actionId?: string | null;
  model?: string | null;
  messages: ModelMessage[];
  usage: Usage;
  costUsd: number;
  numTurns: number;
}

/**
 * SQLite-backed store for agent conversation state. Owns its own table; can be
 * pointed at a shared `.orca/orca.db` or an isolated file (`:memory:` in tests).
 */
export class SessionStore {
  private db: Database;

  constructor(dbPath = ".orca/orca.db") {
    if (dbPath !== ":memory:") {
      mkdirSync(dirname(dbPath), { recursive: true });
    }
    this.db = new Database(dbPath, { create: true });
    this.db.exec("PRAGMA busy_timeout = 5000;");
    this.db.exec(SCHEMA);
  }

  /** Adopt an existing Database handle (e.g. the shared OrcaDatabase). */
  static fromDatabase(db: Database): SessionStore {
    const store = Object.create(SessionStore.prototype) as SessionStore;
    (store as any).db = db;
    db.exec(SCHEMA);
    return store;
  }

  close(): void {
    this.db.close();
  }

  /** Load a session by id, or null if it does not exist. */
  load(sessionId: string): SessionRecord | null {
    const row = this.db
      .query("SELECT * FROM agent_sessions WHERE id = ?")
      .get(sessionId) as Record<string, unknown> | null;
    return row ? rowToSession(row) : null;
  }

  /**
   * Persist a session snapshot under `sessionId`. Creates the row on first save
   * and overwrites conversation state on subsequent saves (idempotent upsert).
   */
  save(sessionId: string, snapshot: SessionSnapshot): void {
    const now = new Date().toISOString();
    this.db.run(
      `INSERT INTO agent_sessions (id, action_id, model, messages, usage, cost_usd, num_turns, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         action_id = excluded.action_id,
         model = excluded.model,
         messages = excluded.messages,
         usage = excluded.usage,
         cost_usd = excluded.cost_usd,
         num_turns = excluded.num_turns,
         updated_at = excluded.updated_at`,
      [
        sessionId,
        snapshot.actionId ?? null,
        snapshot.model ?? null,
        JSON.stringify(snapshot.messages),
        JSON.stringify(snapshot.usage),
        snapshot.costUsd,
        snapshot.numTurns,
        now,
        now,
      ],
    );
  }

  /** Generate a fresh session id. */
  newId(): string {
    return `sess_${randomUUID()}`;
  }

  deleteSession(sessionId: string): void {
    this.db.run("DELETE FROM agent_sessions WHERE id = ?", [sessionId]);
  }
}

function rowToSession(row: Record<string, unknown>): SessionRecord {
  let usage: Usage = emptyUsage();
  try {
    const parsed = JSON.parse((row.usage as string) || "{}");
    usage = { ...emptyUsage(), ...parsed };
  } catch { /* keep empty */ }

  let messages: ModelMessage[] = [];
  try {
    messages = JSON.parse((row.messages as string) || "[]");
  } catch { /* keep empty */ }

  return {
    id: row.id as string,
    actionId: (row.action_id as string) ?? null,
    model: (row.model as string) ?? null,
    messages,
    usage,
    costUsd: (row.cost_usd as number) ?? 0,
    numTurns: (row.num_turns as number) ?? 0,
    createdAt: row.created_at as string,
    updatedAt: row.updated_at as string,
  };
}
