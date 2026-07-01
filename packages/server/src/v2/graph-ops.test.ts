import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import {
  applyDelta,
  applyDeltas,
  applyValidatedDelta,
  validateGraph,
  serializeGraphForPrompt,
} from "./graph-ops";
import type { GraphDelta } from "./schema";

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
`;

let db: Database;

beforeEach(() => {
  db = new Database(":memory:");
  db.exec(SCHEMA);
});

afterEach(() => {
  db.close();
});

describe("applyDelta - add_action", () => {
  test("inserts a new action", () => {
    applyDelta(db, {
      type: "add_action",
      action_id: "auth.develop",
      action: { type: "agent", tags: ["auth"] },
    });
    const row = db.query("SELECT * FROM actions WHERE id = ?").get("auth.develop") as any;
    expect(row).not.toBeNull();
    expect(row.type).toBe("agent");
    expect(JSON.parse(row.tags)).toEqual(["auth"]);
  });

  test("throws if action already exists", () => {
    applyDelta(db, {
      type: "add_action",
      action_id: "x",
      action: {},
    });
    expect(() =>
      applyDelta(db, { type: "add_action", action_id: "x", action: {} }),
    ).toThrow("already exists");
  });
});

describe("applyDelta - remove_action", () => {
  test("removes action and cascades edges", () => {
    applyDelta(db, { type: "add_action", action_id: "a", action: {} });
    applyDelta(db, { type: "add_action", action_id: "b", action: {} });
    applyDelta(db, {
      type: "add_edge",
      edge: { from_action: "a", to_action: "b", condition: "pass" },
    });

    applyDelta(db, { type: "remove_action", action_id: "a" });

    expect(db.query("SELECT * FROM actions WHERE id = ?").get("a")).toBeNull();
    const edges = db.query("SELECT * FROM edges").all();
    expect(edges).toHaveLength(0);
  });

  test("throws if action does not exist", () => {
    expect(() =>
      applyDelta(db, { type: "remove_action", action_id: "nope" }),
    ).toThrow("does not exist");
  });
});

describe("applyDelta - update_params", () => {
  test("merges params into existing", () => {
    applyDelta(db, {
      type: "add_action",
      action_id: "dev",
      action: { params: { model: "opus", max_turns: 10 } },
    });
    applyDelta(db, {
      type: "update_params",
      action_id: "dev",
      params: { max_turns: 20, debug: true },
    });

    const row = db.query("SELECT params FROM actions WHERE id = ?").get("dev") as any;
    const params = JSON.parse(row.params);
    expect(params.model).toBe("opus");
    expect(params.max_turns).toBe(20);
    expect(params.debug).toBe(true);
  });

  test("throws if action does not exist", () => {
    expect(() =>
      applyDelta(db, { type: "update_params", action_id: "nope", params: {} }),
    ).toThrow("does not exist");
  });
});

describe("applyDelta - add_edge", () => {
  test("inserts edge between existing actions", () => {
    applyDelta(db, { type: "add_action", action_id: "a", action: {} });
    applyDelta(db, { type: "add_action", action_id: "b", action: {} });
    applyDelta(db, {
      type: "add_edge",
      edge: { from_action: "a", to_action: "b", condition: "fail" },
    });

    const edges = db.query("SELECT * FROM edges").all() as any[];
    expect(edges).toHaveLength(1);
    expect(edges[0].from_action).toBe("a");
    expect(edges[0].to_action).toBe("b");
    expect(edges[0].condition).toBe("fail");
  });

  test("throws if from_action does not exist", () => {
    applyDelta(db, { type: "add_action", action_id: "b", action: {} });
    expect(() =>
      applyDelta(db, {
        type: "add_edge",
        edge: { from_action: "nope", to_action: "b", condition: "pass" },
      }),
    ).toThrow("does not exist");
  });

  test("throws if to_action does not exist", () => {
    applyDelta(db, { type: "add_action", action_id: "a", action: {} });
    expect(() =>
      applyDelta(db, {
        type: "add_edge",
        edge: { from_action: "a", to_action: "nope", condition: "pass" },
      }),
    ).toThrow("does not exist");
  });
});

describe("applyDelta - remove_edge", () => {
  test("removes existing edge", () => {
    applyDelta(db, { type: "add_action", action_id: "a", action: {} });
    applyDelta(db, { type: "add_action", action_id: "b", action: {} });
    applyDelta(db, {
      type: "add_edge",
      edge: { from_action: "a", to_action: "b", condition: "pass" },
    });

    const edge = db.query("SELECT id FROM edges").get() as any;
    applyDelta(db, { type: "remove_edge", edge_id: edge.id });

    expect(db.query("SELECT * FROM edges").all()).toHaveLength(0);
  });

  test("throws if edge does not exist", () => {
    expect(() =>
      applyDelta(db, { type: "remove_edge", edge_id: 999 }),
    ).toThrow("does not exist");
  });
});

describe("applyDeltas", () => {
  test("applies multiple deltas in order", () => {
    const deltas: GraphDelta[] = [
      { type: "add_action", action_id: "a", action: { type: "agent" } },
      { type: "add_action", action_id: "b", action: { type: "command" } },
      { type: "add_edge", edge: { from_action: "a", to_action: "b", condition: "pass" } },
    ];
    applyDeltas(db, deltas);

    const actions = db.query("SELECT * FROM actions").all();
    expect(actions).toHaveLength(2);
    const edges = db.query("SELECT * FROM edges").all();
    expect(edges).toHaveLength(1);
  });

  test("rolls back all changes on error", () => {
    applyDelta(db, { type: "add_action", action_id: "existing", action: {} });

    const deltas: GraphDelta[] = [
      { type: "add_action", action_id: "new1", action: {} },
      { type: "add_action", action_id: "new2", action: {} },
      // This will fail — action doesn't exist
      { type: "remove_action", action_id: "nonexistent" },
    ];

    expect(() => applyDeltas(db, deltas)).toThrow();

    // new1 and new2 should not exist due to rollback
    expect(db.query("SELECT * FROM actions WHERE id = ?").get("new1")).toBeNull();
    expect(db.query("SELECT * FROM actions WHERE id = ?").get("new2")).toBeNull();
    // existing should still be there
    expect(db.query("SELECT * FROM actions WHERE id = ?").get("existing")).not.toBeNull();
  });
});

describe("validateGraph", () => {
  test("returns empty for valid graph", () => {
    applyDelta(db, { type: "add_action", action_id: "a", action: { status: "completed" } });
    applyDelta(db, { type: "add_action", action_id: "b", action: { status: "completed" } });
    applyDelta(db, {
      type: "add_edge",
      edge: { from_action: "a", to_action: "b", condition: "pass" },
    });

    const issues = validateGraph(db);
    expect(issues).toHaveLength(0);
  });

  test("detects actions with no outgoing edges that are not completed", () => {
    applyDelta(db, { type: "add_action", action_id: "a", action: { status: "pending" } });
    applyDelta(db, { type: "add_action", action_id: "b", action: { status: "running" } });

    const issues = validateGraph(db);
    expect(issues.some((i) => i.includes("no outgoing edges"))).toBe(true);
  });

  // ── Legal loops vs illegal unbounded cycles ──

  test("ACCEPTS a legal self-loop with an escape edge", () => {
    // loop retries itself on fail, and escapes to `done` on pass.
    applyDelta(db, { type: "add_action", action_id: "loop", action: { status: "pending" } });
    applyDelta(db, { type: "add_action", action_id: "done", action: { status: "completed" } });
    applyDelta(db, { type: "add_edge", edge: { from_action: "loop", to_action: "loop", condition: "fail" } });
    applyDelta(db, { type: "add_edge", edge: { from_action: "loop", to_action: "done", condition: "pass" } });

    expect(validateGraph(db)).toHaveLength(0);
  });

  test("ACCEPTS a self-loop whose pass condition terminates (no pass edge)", () => {
    // loop retries on fail; a `pass` result completes the action (terminal escape).
    applyDelta(db, { type: "add_action", action_id: "loop", action: { status: "pending" } });
    applyDelta(db, { type: "add_edge", edge: { from_action: "loop", to_action: "loop", condition: "fail" } });

    expect(validateGraph(db)).toHaveLength(0);
  });

  test("ACCEPTS a legal two-node loop that can exit on pass", () => {
    // a → b (pass), b → a (fail): b terminates on pass, so the loop is bounded.
    applyDelta(db, { type: "add_action", action_id: "a", action: { status: "pending" } });
    applyDelta(db, { type: "add_action", action_id: "b", action: { status: "inactive" } });
    applyDelta(db, { type: "add_edge", edge: { from_action: "a", to_action: "b", condition: "pass" } });
    applyDelta(db, { type: "add_edge", edge: { from_action: "b", to_action: "a", condition: "fail" } });

    expect(validateGraph(db)).toHaveLength(0);
  });

  test("REJECTS an unbounded self-loop on pass (never escapes)", () => {
    applyDelta(db, { type: "add_action", action_id: "spin", action: { status: "pending" } });
    applyDelta(db, { type: "add_edge", edge: { from_action: "spin", to_action: "spin", condition: "pass" } });

    const issues = validateGraph(db);
    expect(issues.some((i) => i.includes("Unbounded cycle"))).toBe(true);
  });

  test("REJECTS an unbounded two-node cycle with no escape", () => {
    // a → b (pass), b → a (pass): both loop forever on pass, no exit.
    applyDelta(db, { type: "add_action", action_id: "a", action: { status: "pending" } });
    applyDelta(db, { type: "add_action", action_id: "b", action: { status: "inactive" } });
    applyDelta(db, { type: "add_edge", edge: { from_action: "a", to_action: "b", condition: "pass" } });
    applyDelta(db, { type: "add_edge", edge: { from_action: "b", to_action: "a", condition: "pass" } });

    const issues = validateGraph(db);
    expect(issues.some((i) => i.includes("Unbounded cycle"))).toBe(true);
  });

  // ── Reachability ──

  test("does not false-flag reachable actions or entry roots", () => {
    // root (completed) → next (pending): reachable. island (pending, 0 incoming)
    // → next: island is itself an entry root, so nothing is unreachable.
    applyDelta(db, { type: "add_action", action_id: "root", action: { status: "completed" } });
    applyDelta(db, { type: "add_action", action_id: "next", action: { status: "pending" } });
    applyDelta(db, { type: "add_action", action_id: "island", action: { status: "pending" } });
    applyDelta(db, { type: "add_edge", edge: { from_action: "root", to_action: "next", condition: "pass" } });
    applyDelta(db, { type: "add_edge", edge: { from_action: "island", to_action: "next", condition: "pass" } });

    expect(validateGraph(db).some((i) => i.includes("unreachable"))).toBe(false);
  });

  test("detects a dormant action that can never be activated", () => {
    // start is the live entry. u ↔ v are inactive and only reachable from each
    // other — no live path ever activates them → unreachable.
    applyDelta(db, { type: "add_action", action_id: "start", action: { status: "completed" } });
    applyDelta(db, { type: "add_action", action_id: "u", action: { status: "inactive" } });
    applyDelta(db, { type: "add_action", action_id: "v", action: { status: "inactive" } });
    applyDelta(db, { type: "add_edge", edge: { from_action: "u", to_action: "v", condition: "fail" } });
    applyDelta(db, { type: "add_edge", edge: { from_action: "v", to_action: "u", condition: "fail" } });

    expect(validateGraph(db).some((i) => i.includes("unreachable"))).toBe(true);
  });

  // ── Size caps ──

  test("enforces action size cap", () => {
    applyDelta(db, { type: "add_action", action_id: "a", action: { status: "completed" } });
    applyDelta(db, { type: "add_action", action_id: "b", action: { status: "completed" } });
    applyDelta(db, { type: "add_action", action_id: "c", action: { status: "completed" } });

    expect(validateGraph(db, { maxActions: 2 }).some((i) => i.includes("action cap"))).toBe(true);
    expect(validateGraph(db, { maxActions: 3 }).some((i) => i.includes("action cap"))).toBe(false);
  });

  test("enforces edge size cap", () => {
    applyDelta(db, { type: "add_action", action_id: "a", action: { status: "completed" } });
    applyDelta(db, { type: "add_action", action_id: "b", action: { status: "completed" } });
    applyDelta(db, { type: "add_edge", edge: { from_action: "a", to_action: "b", condition: "pass" } });
    applyDelta(db, { type: "add_edge", edge: { from_action: "a", to_action: "b", condition: "fail" } });

    expect(validateGraph(db, { maxEdges: 1 }).some((i) => i.includes("edge cap"))).toBe(true);
    expect(validateGraph(db, { maxEdges: 2 }).some((i) => i.includes("edge cap"))).toBe(false);
  });
});

describe("applyValidatedDelta", () => {
  function snapshot(): string {
    const actions = db.query("SELECT * FROM actions ORDER BY id").all();
    const edges = db.query("SELECT * FROM edges ORDER BY id").all();
    return JSON.stringify({ actions, edges });
  }

  test("commits a valid mutation", () => {
    applyDelta(db, { type: "add_action", action_id: "a", action: { status: "completed" } });

    const result = applyValidatedDelta(db, [
      { type: "add_action", action_id: "b", action: { status: "completed" } },
      { type: "add_edge", edge: { from_action: "a", to_action: "b", condition: "pass" } },
    ]);

    expect(result.ok).toBe(true);
    expect(db.query("SELECT id FROM actions WHERE id = ?").get("b")).not.toBeNull();
  });

  test("commits a legal loop-with-escape mutation", () => {
    applyDelta(db, { type: "add_action", action_id: "done", action: { status: "completed" } });

    const result = applyValidatedDelta(db, [
      { type: "add_action", action_id: "loop", action: { status: "pending" } },
      { type: "add_edge", edge: { from_action: "loop", to_action: "loop", condition: "fail" } },
      { type: "add_edge", edge: { from_action: "loop", to_action: "done", condition: "pass" } },
    ]);

    expect(result.ok).toBe(true);
  });

  test("rolls back a validation failure (unbounded cycle) byte-identical", () => {
    applyDelta(db, { type: "add_action", action_id: "a", action: { status: "completed" } });
    const before = snapshot();

    const result = applyValidatedDelta(db, [
      { type: "add_action", action_id: "spin", action: { status: "pending" } },
      { type: "add_edge", edge: { from_action: "spin", to_action: "spin", condition: "pass" } },
    ]);

    expect(result.ok).toBe(false);
    expect(result.kind).toBe("validation");
    expect(snapshot()).toBe(before);
  });

  test("rolls back an execution failure (duplicate id) byte-identical", () => {
    applyDelta(db, { type: "add_action", action_id: "a", action: { status: "completed" } });
    const before = snapshot();

    const result = applyValidatedDelta(db, [
      { type: "add_action", action_id: "a", action: {} },
    ]);

    expect(result.ok).toBe(false);
    expect(result.kind).toBe("execution");
    expect(snapshot()).toBe(before);
  });

  test("rolls back the whole batch when a later delta is invalid", () => {
    applyDelta(db, { type: "add_action", action_id: "a", action: { status: "completed" } });
    const before = snapshot();

    const result = applyValidatedDelta(db, [
      { type: "add_action", action_id: "valid", action: { status: "completed" } },
      { type: "remove_action", action_id: "nonexistent" },
    ]);

    expect(result.ok).toBe(false);
    // The first (valid) delta must not persist.
    expect(db.query("SELECT id FROM actions WHERE id = ?").get("valid")).toBeNull();
    expect(snapshot()).toBe(before);
  });
});

describe("serializeGraphForPrompt", () => {
  test("produces readable output", () => {
    applyDelta(db, {
      type: "add_action",
      action_id: "auth.develop",
      action: { type: "agent", status: "completed", cost_usd: 2.4, tags: ["auth"] },
    });
    applyDelta(db, {
      type: "add_action",
      action_id: "auth.eval",
      action: { type: "command", status: "failed", tags: ["auth"] },
    });
    applyDelta(db, {
      type: "add_edge",
      edge: { from_action: "auth.develop", to_action: "auth.eval", condition: "pass" },
    });

    const output = serializeGraphForPrompt(db);
    expect(output).toContain("auth.develop");
    expect(output).toContain("agent, completed, $2.40");
    expect(output).toContain("→ auth.eval (pass)");
    expect(output).toContain("auth.eval");
    expect(output).toContain("command, failed");
  });

  test("filters by tag", () => {
    applyDelta(db, {
      type: "add_action",
      action_id: "auth.develop",
      action: { tags: ["auth"] },
    });
    applyDelta(db, {
      type: "add_action",
      action_id: "other.develop",
      action: { tags: ["other"] },
    });

    const output = serializeGraphForPrompt(db, "auth");
    expect(output).toContain("auth.develop");
    expect(output).not.toContain("other.develop");
  });

  test("includes recent history", () => {
    applyDelta(db, {
      type: "add_action",
      action_id: "dev",
      action: { status: "completed" },
    });

    db.run(
      "INSERT INTO history (action_id, iteration, event_type, data, timestamp) VALUES (?, ?, ?, ?, ?)",
      ["dev", 1, "completed", JSON.stringify({ condition: "pass", turns: 45, cost_usd: 2.4 }), new Date().toISOString()],
    );

    const output = serializeGraphForPrompt(db);
    expect(output).toContain("Recent history:");
    expect(output).toContain("dev completed");
    expect(output).toContain("(pass)");
    expect(output).toContain("45 turns");
  });

  test("returns message for empty graph", () => {
    const output = serializeGraphForPrompt(db);
    expect(output).toBe("No actions in graph.");
  });
});
