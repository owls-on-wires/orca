import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { unlinkSync } from "fs";
import { OrcaDatabase } from "./db";
import { createAction, createEdge, type ActionConfig } from "./schema";

const TEST_DB = ":memory:";

let db: OrcaDatabase;

beforeEach(() => {
  db = new OrcaDatabase(TEST_DB);
});

afterEach(() => {
  db.close();
});

describe("Actions CRUD", () => {
  test("insert and get action", () => {
    const action = createAction({ id: "dev", type: "agent", status: "pending" });
    db.insertAction(action);
    const got = db.getAction("dev");
    expect(got).not.toBeNull();
    expect(got!.id).toBe("dev");
    expect(got!.type).toBe("agent");
    expect(got!.status).toBe("pending");
    expect(got!.params).toEqual({});
    expect(got!.tags).toEqual([]);
    expect(got!.output).toBeNull();
  });

  test("get nonexistent action returns null", () => {
    expect(db.getAction("nope")).toBeNull();
  });

  test("update action fields", () => {
    const action = createAction({ id: "dev", status: "pending" });
    db.insertAction(action);
    db.updateAction("dev", { status: "running", cost_usd: 1.5 });
    const got = db.getAction("dev")!;
    expect(got.status).toBe("running");
    expect(got.cost_usd).toBe(1.5);
    expect(got.updated_at).not.toBe(action.updated_at);
  });

  test("update action output", () => {
    const action = createAction({ id: "dev" });
    db.insertAction(action);
    db.updateAction("dev", {
      output: { status: "passed", summary: "all good" },
    });
    const got = db.getAction("dev")!;
    expect(got.output).toEqual({ status: "passed", summary: "all good" });
  });

  test("delete action", () => {
    db.insertAction(createAction({ id: "dev" }));
    db.deleteAction("dev");
    expect(db.getAction("dev")).toBeNull();
  });

  test("list actions with no filters", () => {
    db.insertAction(createAction({ id: "a", status: "pending" }));
    db.insertAction(createAction({ id: "b", status: "running" }));
    const all = db.listActions();
    expect(all).toHaveLength(2);
  });

  test("list actions by status", () => {
    db.insertAction(createAction({ id: "a", status: "pending" }));
    db.insertAction(createAction({ id: "b", status: "running" }));
    const pending = db.listActions({ status: "pending" });
    expect(pending).toHaveLength(1);
    expect(pending[0].id).toBe("a");
  });

  test("list actions by type", () => {
    db.insertAction(createAction({ id: "a", type: "agent" }));
    db.insertAction(createAction({ id: "b", type: "command" }));
    const agents = db.listActions({ type: "agent" });
    expect(agents).toHaveLength(1);
    expect(agents[0].id).toBe("a");
  });

  test("list actions by tag", () => {
    db.insertAction(createAction({ id: "a", tags: ["build", "v2"] }));
    db.insertAction(createAction({ id: "b", tags: ["test"] }));
    const v2 = db.listActions({ tag: "v2" });
    expect(v2).toHaveLength(1);
    expect(v2[0].id).toBe("a");
  });

  test("JSON params are preserved round-trip", () => {
    const params = { model: "opus", temperature: 0.7, files: ["a.ts", "b.ts"] };
    db.insertAction(createAction({ id: "dev", params }));
    const got = db.getAction("dev")!;
    expect(got.params).toEqual(params);
  });
});

describe("Edges", () => {
  test("insert and query edges", () => {
    db.insertAction(createAction({ id: "a" }));
    db.insertAction(createAction({ id: "b" }));
    const edgeId = db.insertEdge(createEdge("a", "b", "pass"));
    expect(edgeId).toBeGreaterThan(0);

    const from = db.getEdgesFrom("a");
    expect(from).toHaveLength(1);
    expect(from[0].condition).toBe("pass");

    const to = db.getEdgesTo("b");
    expect(to).toHaveLength(1);
    expect(to[0].from_action).toBe("a");
  });

  test("delete edge", () => {
    db.insertAction(createAction({ id: "a" }));
    db.insertAction(createAction({ id: "b" }));
    const edgeId = db.insertEdge(createEdge("a", "b", "pass"));
    db.deleteEdge(edgeId);
    expect(db.getEdgesFrom("a")).toHaveLength(0);
  });

  test("cascading delete removes edges when action deleted", () => {
    db.insertAction(createAction({ id: "a" }));
    db.insertAction(createAction({ id: "b" }));
    db.insertEdge(createEdge("a", "b", "pass"));
    db.deleteAction("a");
    expect(db.getEdgesTo("b")).toHaveLength(0);
  });

  test("edge condition is NOT NULL", () => {
    db.insertAction(createAction({ id: "a" }));
    db.insertAction(createAction({ id: "b" }));
    expect(() => {
      db.insertEdge({ from_action: "a", to_action: "b", condition: null as any });
    }).toThrow();
  });

  test("getEdgesByCondition filters correctly", () => {
    db.insertAction(createAction({ id: "a" }));
    db.insertAction(createAction({ id: "b" }));
    db.insertAction(createAction({ id: "c" }));
    db.insertEdge(createEdge("a", "b", "pass"));
    db.insertEdge(createEdge("a", "c", "fail"));

    const passEdges = db.getEdgesByCondition("a", "pass");
    expect(passEdges).toHaveLength(1);
    expect(passEdges[0].to_action).toBe("b");
  });

  test("unique constraint on (from, to, condition)", () => {
    db.insertAction(createAction({ id: "a" }));
    db.insertAction(createAction({ id: "b" }));
    db.insertEdge(createEdge("a", "b", "pass"));
    expect(() => db.insertEdge(createEdge("a", "b", "pass"))).toThrow();
  });
});

describe("History", () => {
  test("append and retrieve history", () => {
    db.insertAction(createAction({ id: "dev", iteration: 2 }));
    db.appendHistory("dev", "started", { reason: "initial" });
    db.appendHistory("dev", "completed", { result: "ok" });

    const hist = db.getHistory("dev");
    expect(hist).toHaveLength(2);
    expect(hist[0].event_type).toBe("completed"); // DESC order
    expect(hist[1].event_type).toBe("started");
    expect(hist[1].data).toEqual({ reason: "initial" });
    expect(hist[0].iteration).toBe(2);
  });

  test("history with limit", () => {
    db.insertAction(createAction({ id: "dev" }));
    db.appendHistory("dev", "a");
    db.appendHistory("dev", "b");
    db.appendHistory("dev", "c");

    const hist = db.getHistory("dev", 2);
    expect(hist).toHaveLength(2);
  });

  test("history cascades on action delete", () => {
    db.insertAction(createAction({ id: "dev" }));
    db.appendHistory("dev", "started");
    db.deleteAction("dev");
    const hist = db.getHistory("dev");
    expect(hist).toHaveLength(0);
  });

  test("history without data", () => {
    db.insertAction(createAction({ id: "dev" }));
    db.appendHistory("dev", "started");
    const hist = db.getHistory("dev");
    expect(hist[0].data).toBeNull();
  });
});

describe("getReadyActions", () => {
  test("returns only pending actions", () => {
    db.insertAction(createAction({ id: "a", status: "pending" }));
    db.insertAction(createAction({ id: "b", status: "running" }));
    db.insertAction(createAction({ id: "c", status: "inactive" }));
    db.insertAction(createAction({ id: "d", status: "completed" }));

    const ready = db.getReadyActions();
    expect(ready).toHaveLength(1);
    expect(ready[0].id).toBe("a");
  });

  test("returns empty when no pending actions", () => {
    db.insertAction(createAction({ id: "a", status: "running" }));
    expect(db.getReadyActions()).toHaveLength(0);
  });
});

describe("Bulk operations", () => {
  test("getActionsByTag returns matching actions", () => {
    db.insertAction(createAction({ id: "a", tags: ["deploy"] }));
    db.insertAction(createAction({ id: "b", tags: ["deploy", "prod"] }));
    db.insertAction(createAction({ id: "c", tags: ["test"] }));

    const deploy = db.getActionsByTag("deploy");
    expect(deploy).toHaveLength(2);
  });

  test("updateActionsByTag updates matching actions", () => {
    db.insertAction(createAction({ id: "a", tags: ["deploy"], status: "pending" }));
    db.insertAction(createAction({ id: "b", tags: ["deploy"], status: "pending" }));
    db.insertAction(createAction({ id: "c", tags: ["test"], status: "pending" }));

    const count = db.updateActionsByTag("deploy", { status: "skipped" });
    expect(count).toBe(2);
    expect(db.getAction("a")!.status).toBe("skipped");
    expect(db.getAction("b")!.status).toBe("skipped");
    expect(db.getAction("c")!.status).toBe("pending");
  });
});

describe("Database lifecycle", () => {
  test("file-based database creates and persists", () => {
    const path = "/tmp/orca-test-" + Date.now() + ".db";
    try {
      const db1 = new OrcaDatabase(path);
      db1.insertAction(createAction({ id: "persist" }));
      db1.close();

      const db2 = new OrcaDatabase(path);
      expect(db2.getAction("persist")).not.toBeNull();
      db2.close();
    } finally {
      try { unlinkSync(path); } catch {}
    }
  });
});
