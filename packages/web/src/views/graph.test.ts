import { describe, expect, test } from "bun:test";
import {
  computeColumns,
  layoutActions,
  apiToLayout,
  getDemoFixture,
  type ApiAction,
  type ApiEdge,
  type LayoutNode,
} from "./graph";

function mkNode(id: string, task: string, extra: Partial<LayoutNode> = {}): LayoutNode {
  return { id, type: 'agent', status: 'completed', label: id.split('.').pop() || id, task, iter: 0, cost: 0, ...extra };
}

function mkAction(id: string, tags: string[], extra: Partial<ApiAction> = {}): ApiAction {
  const now = new Date().toISOString();
  return {
    id, type: 'agent', status: 'completed', project_id: null, params: {},
    output: null, tags, cost_usd: 0, iteration: 0, created_at: now,
    updated_at: now, started_at: null, completed_at: null, ...extra,
  };
}

// ---------------------------------------------------------------------------
// Column computation
// ---------------------------------------------------------------------------

describe("computeColumns", () => {
  test("linear chain gets sequential columns", () => {
    const nodes = [mkNode("a", "t"), mkNode("b", "t"), mkNode("c", "t")];
    const edges: ApiEdge[] = [
      { from_action: "a", to_action: "b", condition: "pass" },
      { from_action: "b", to_action: "c", condition: "pass" },
    ];
    const cols = computeColumns(nodes, edges);
    expect(cols.get("a")).toBe(0);
    expect(cols.get("b")).toBe(1);
    expect(cols.get("c")).toBe(2);
  });

  test("fan-out puts children in same column", () => {
    const nodes = [mkNode("a", "t"), mkNode("b", "t"), mkNode("c", "t")];
    const edges: ApiEdge[] = [
      { from_action: "a", to_action: "b", condition: "pass" },
      { from_action: "a", to_action: "c", condition: "pass" },
    ];
    const cols = computeColumns(nodes, edges);
    expect(cols.get("a")).toBe(0);
    expect(cols.get("b")).toBe(1);
    expect(cols.get("c")).toBe(1);
  });

  test("fan-in uses max predecessor column", () => {
    const nodes = [mkNode("a", "t"), mkNode("b", "t"), mkNode("c", "t"), mkNode("d", "t")];
    const edges: ApiEdge[] = [
      { from_action: "a", to_action: "b", condition: "pass" },
      { from_action: "a", to_action: "c", condition: "pass" },
      { from_action: "b", to_action: "d", condition: "pass" },
      { from_action: "c", to_action: "d", condition: "pass" },
    ];
    const cols = computeColumns(nodes, edges);
    expect(cols.get("d")).toBe(2);
  });

  test("back-edge fail loops are excluded from column computation", () => {
    const nodes = [mkNode("dev", "t"), mkNode("eval", "t")];
    const edges: ApiEdge[] = [
      { from_action: "dev", to_action: "eval", condition: "pass" },
      { from_action: "eval", to_action: "dev", condition: "fail" },
    ];
    const cols = computeColumns(nodes, edges);
    expect(cols.get("dev")).toBe(0);
    expect(cols.get("eval")).toBe(1);
  });

  test("forward fail edges are NOT excluded", () => {
    const nodes = [mkNode("dev", "t"), mkNode("eval", "t"), mkNode("dev2", "t")];
    const edges: ApiEdge[] = [
      { from_action: "dev", to_action: "eval", condition: "pass" },
      { from_action: "eval", to_action: "dev2", condition: "fail" },
    ];
    const cols = computeColumns(nodes, edges);
    expect(cols.get("dev")).toBe(0);
    expect(cols.get("eval")).toBe(1);
    expect(cols.get("dev2")).toBe(2);
  });

  test("cross-task dependency affects column", () => {
    const nodes = [
      mkNode("a.commit", "a"),
      mkNode("b.develop", "b"),
    ];
    const edges: ApiEdge[] = [
      { from_action: "a.commit", to_action: "b.develop", condition: "pass" },
    ];
    const cols = computeColumns(nodes, edges);
    expect(cols.get("b.develop")).toBe((cols.get("a.commit") || 0) + 1);
  });

  test("nodes with no edges get column 0", () => {
    const nodes = [mkNode("orphan", "t")];
    const cols = computeColumns(nodes, []);
    expect(cols.get("orphan")).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Row layout / compaction
// ---------------------------------------------------------------------------

describe("layoutActions", () => {
  test("same task stays on same row", () => {
    const nodes = [mkNode("t.a", "task1"), mkNode("t.b", "task1"), mkNode("t.c", "task1")];
    const edges: ApiEdge[] = [
      { from_action: "t.a", to_action: "t.b", condition: "pass" },
      { from_action: "t.b", to_action: "t.c", condition: "pass" },
    ];
    const positioned = layoutActions(nodes, edges);
    const ys = new Set(positioned.map(p => p.y));
    expect(ys.size).toBe(1);
  });

  test("two tasks with overlapping columns get different rows", () => {
    const nodes = [
      mkNode("a.dev", "taskA"), mkNode("a.eval", "taskA"),
      mkNode("b.dev", "taskB"), mkNode("b.eval", "taskB"),
    ];
    const edges: ApiEdge[] = [
      { from_action: "a.dev", to_action: "a.eval", condition: "pass" },
      { from_action: "b.dev", to_action: "b.eval", condition: "pass" },
    ];
    const positioned = layoutActions(nodes, edges);
    const aRow = positioned.find(p => p.id === "a.dev")!.y;
    const bRow = positioned.find(p => p.id === "b.dev")!.y;
    expect(aRow).not.toBe(bRow);
  });

  test("two tasks with non-overlapping columns share a row", () => {
    const nodes = [
      mkNode("a.dev", "taskA"), mkNode("a.eval", "taskA"),
      mkNode("b.dev", "taskB"), mkNode("b.eval", "taskB"),
    ];
    const edges: ApiEdge[] = [
      { from_action: "a.dev", to_action: "a.eval", condition: "pass" },
      { from_action: "a.eval", to_action: "b.dev", condition: "pass" },
      { from_action: "b.dev", to_action: "b.eval", condition: "pass" },
    ];
    const positioned = layoutActions(nodes, edges);
    const aRow = positioned.find(p => p.id === "a.dev")!.y;
    const bRow = positioned.find(p => p.id === "b.dev")!.y;
    expect(aRow).toBe(bRow);
  });

  test("parallel independent tasks get different rows", () => {
    const nodes = [
      mkNode("a.x", "taskA"),
      mkNode("b.x", "taskB"),
    ];
    const positioned = layoutActions(nodes, []);
    const aRow = positioned.find(p => p.id === "a.x")!.y;
    const bRow = positioned.find(p => p.id === "b.x")!.y;
    expect(aRow).not.toBe(bRow);
  });

  test("three sequential tasks compact to one row", () => {
    const nodes = [
      mkNode("a.dev", "t1"), mkNode("a.eval", "t1"),
      mkNode("b.dev", "t2"), mkNode("b.eval", "t2"),
      mkNode("c.dev", "t3"), mkNode("c.eval", "t3"),
    ];
    const edges: ApiEdge[] = [
      { from_action: "a.dev", to_action: "a.eval", condition: "pass" },
      { from_action: "a.eval", to_action: "b.dev", condition: "pass" },
      { from_action: "b.dev", to_action: "b.eval", condition: "pass" },
      { from_action: "b.eval", to_action: "c.dev", condition: "pass" },
      { from_action: "c.dev", to_action: "c.eval", condition: "pass" },
    ];
    const positioned = layoutActions(nodes, edges);
    const ys = new Set(positioned.map(p => p.y));
    expect(ys.size).toBe(1);
  });

  test("fork after linear task creates two rows", () => {
    const nodes = [
      mkNode("a.dev", "t1"), mkNode("a.commit", "t1"),
      mkNode("b.dev", "t2"), mkNode("b.eval", "t2"),
      mkNode("c.dev", "t3"), mkNode("c.eval", "t3"),
    ];
    const edges: ApiEdge[] = [
      { from_action: "a.dev", to_action: "a.commit", condition: "pass" },
      { from_action: "a.commit", to_action: "b.dev", condition: "pass" },
      { from_action: "a.commit", to_action: "c.dev", condition: "pass" },
      { from_action: "b.dev", to_action: "b.eval", condition: "pass" },
      { from_action: "c.dev", to_action: "c.eval", condition: "pass" },
    ];
    const positioned = layoutActions(nodes, edges);
    const bRow = positioned.find(p => p.id === "b.dev")!.y;
    const cRow = positioned.find(p => p.id === "c.dev")!.y;
    expect(bRow).not.toBe(cRow);
    const aRow = positioned.find(p => p.id === "a.dev")!.y;
    expect(aRow === bRow || aRow === cRow).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// API format conversion
// ---------------------------------------------------------------------------

describe("apiToLayout", () => {
  test("extracts task from tags", () => {
    const action = mkAction("auth.develop", ["task:auth", "type:develop"]);
    const node = apiToLayout(action);
    expect(node.task).toBe("auth");
  });

  test("extracts label from id", () => {
    const action = mkAction("auth.develop", []);
    const node = apiToLayout(action);
    expect(node.label).toBe("develop");
  });

  test("maps iteration and cost", () => {
    const action = mkAction("x.y", [], { iteration: 3, cost_usd: 1.5 });
    const node = apiToLayout(action);
    expect(node.iter).toBe(3);
    expect(node.cost).toBe(1.5);
  });

  test("handles missing task tag", () => {
    const action = mkAction("standalone", []);
    const node = apiToLayout(action);
    expect(node.task).toBe("");
    expect(node.label).toBe("standalone");
  });
});

// ---------------------------------------------------------------------------
// Demo fixture validation
// ---------------------------------------------------------------------------

describe("getDemoFixture", () => {
  test("fixture has correct counts", () => {
    const { actions, edges } = getDemoFixture();
    expect(actions.length).toBe(27);
    expect(edges.length).toBeGreaterThan(20);
  });

  test("all edge endpoints reference existing actions", () => {
    const { actions, edges } = getDemoFixture();
    const ids = new Set(actions.map(a => a.id));
    for (const e of edges) {
      expect(ids.has(e.from_action)).toBe(true);
      expect(ids.has(e.to_action)).toBe(true);
    }
  });

  test("fixture has mixed statuses", () => {
    const { actions } = getDemoFixture();
    const statuses = new Set(actions.map(a => a.status));
    expect(statuses.has("completed")).toBe(true);
    expect(statuses.has("running")).toBe(true);
    expect(statuses.has("failed")).toBe(true);
    expect(statuses.has("inactive")).toBe(true);
    expect(statuses.has("pending")).toBe(true);
  });

  test("fixture has 5 tasks", () => {
    const { actions } = getDemoFixture();
    const tasks = new Set(actions.map(a => {
      const t = a.tags.find(t => t.startsWith("task:"));
      return t ? t.slice(5) : null;
    }).filter(Boolean));
    expect(tasks.size).toBe(5);
  });

  test("fixture layout produces no overlapping labels", () => {
    const { actions, edges } = getDemoFixture();
    const nodes = actions.map(apiToLayout);
    const positioned = layoutActions(nodes, edges);
    const occupied = new Map<string, string>();
    for (const p of positioned) {
      const key = `${p.col},${p.y}`;
      if (occupied.has(key)) {
        throw new Error(`Column/row collision: ${p.id} and ${occupied.get(key)} at ${key}`);
      }
      occupied.set(key, p.id);
    }
  });

  test("fixture compacts to 3 or fewer rows", () => {
    const { actions, edges } = getDemoFixture();
    const nodes = actions.map(apiToLayout);
    const positioned = layoutActions(nodes, edges);
    const rows = new Set(positioned.map(p => p.y));
    expect(rows.size).toBeLessThanOrEqual(3);
  });

  test("all actions conform to API schema", () => {
    const { actions } = getDemoFixture();
    for (const a of actions) {
      expect(typeof a.id).toBe("string");
      expect(["agent", "command"]).toContain(a.type);
      expect(typeof a.status).toBe("string");
      expect(Array.isArray(a.tags)).toBe(true);
      expect(typeof a.cost_usd).toBe("number");
      expect(typeof a.iteration).toBe("number");
      expect(typeof a.created_at).toBe("string");
      expect(typeof a.updated_at).toBe("string");
    }
  });

  test("all edges conform to API schema", () => {
    const { edges } = getDemoFixture();
    for (const e of edges) {
      expect(typeof e.from_action).toBe("string");
      expect(typeof e.to_action).toBe("string");
      expect(typeof e.condition).toBe("string");
    }
  });
});
