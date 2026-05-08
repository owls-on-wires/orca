import { describe, expect, test } from "bun:test";
import {
  createAction,
  createEdge,
  isTerminalCondition,
  type ActionConfig,
  type EdgeCondition,
  type GraphDelta,
} from "./schema";

describe("createAction", () => {
  test("produces valid defaults", () => {
    const action = createAction();
    expect(action.id).toBe("");
    expect(action.type).toBe("agent");
    expect(action.status).toBe("pending");
    expect(action.params).toEqual({});
    expect(action.output).toBeNull();
    expect(action.tags).toEqual([]);
    expect(action.cost_usd).toBe(0);
    expect(action.iteration).toBe(0);
    expect(action.started_at).toBeNull();
    expect(action.completed_at).toBeNull();
    expect(action.created_at).toBeTruthy();
    expect(action.updated_at).toBeTruthy();
  });

  test("allows overrides", () => {
    const action = createAction({ id: "build", type: "command", status: "running" });
    expect(action.id).toBe("build");
    expect(action.type).toBe("command");
    expect(action.status).toBe("running");
    // defaults still applied for non-overridden fields
    expect(action.cost_usd).toBe(0);
  });
});

describe("createEdge", () => {
  test("produces correct shape", () => {
    const edge = createEdge("develop", "eval", "pass");
    expect(edge.from_action).toBe("develop");
    expect(edge.to_action).toBe("eval");
    expect(edge.condition).toBe("pass");
    expect(edge.id).toBeUndefined();
  });
});

describe("EdgeCondition", () => {
  test("values are exhaustive", () => {
    const allConditions: EdgeCondition[] = [
      "pass",
      "fail",
      "max_turns",
      "timeout",
      "cost_exceeded",
      "stuck",
      "error",
    ];
    expect(allConditions).toHaveLength(7);

    // Verify each is a valid EdgeCondition by using it in createEdge
    for (const c of allConditions) {
      const edge = createEdge("a", "b", c);
      expect(edge.condition).toBe(c);
    }
  });
});

describe("isTerminalCondition", () => {
  test("pass is terminal", () => {
    expect(isTerminalCondition("pass")).toBe(true);
  });

  test("non-pass conditions are not terminal", () => {
    const nonTerminal: EdgeCondition[] = [
      "fail",
      "max_turns",
      "timeout",
      "cost_exceeded",
      "stuck",
      "error",
    ];
    for (const c of nonTerminal) {
      expect(isTerminalCondition(c)).toBe(false);
    }
  });
});

describe("GraphDelta", () => {
  test("types cover all mutation cases", () => {
    const deltas: GraphDelta[] = [
      { type: "add_action", action_id: "dev", action: { id: "dev", type: "agent" } },
      { type: "remove_action", action_id: "dev" },
      { type: "update_params", action_id: "dev", params: { model: "opus" } },
      { type: "add_edge", edge: { from_action: "a", to_action: "b", condition: "pass" } },
      { type: "remove_edge", edge_id: 1 },
    ];

    const types = deltas.map((d) => d.type);
    expect(types).toEqual([
      "add_action",
      "remove_action",
      "update_params",
      "add_edge",
      "remove_edge",
    ]);
  });
});
