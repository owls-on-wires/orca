import { test, expect, describe } from "bun:test";
import { initialState } from "../src/types";
import { applyEvent, seedActions, addUserMessage, type SseEvent } from "../src/store";

const ev = (event: string, data: Record<string, unknown>): SseEvent => ({ event, data });

describe("store: circuit lifecycle", () => {
  test("seedActions builds rows from the REST action list", () => {
    let s = initialState("demo");
    s = seedActions(s, [
      { id: "a.build", type: "agent", status: "pending", cost_usd: 0 },
      { id: "a.test", type: "command", status: "inactive" },
    ]);
    expect(s.order).toEqual(["a.build", "a.test"]);
    expect(s.actions["a.build"].status).toBe("pending");
    expect(s.hasCircuit).toBe(true);
  });

  test("action_started → running, action_completed(pass) → completed + cost, tool_use sets tool", () => {
    let s = initialState();
    s = applyEvent(s, ev("action_started", { action_id: "x", type: "agent" }));
    expect(s.actions["x"].status).toBe("running");
    s = applyEvent(s, ev("tool_use", { action_id: "x", tool_name: "Bash" }));
    expect(s.actions["x"].currentTool).toBe("Bash");
    s = applyEvent(s, ev("action_completed", { action_id: "x", condition: "pass", cost_usd: 0.25 }));
    expect(s.actions["x"].status).toBe("completed");
    expect(s.actions["x"].costUsd).toBeCloseTo(0.25);
    expect(s.actions["x"].currentTool).toBeUndefined();
  });

  test("action_completed(fail) marks the row failed", () => {
    let s = applyEvent(initialState(), ev("action_started", { action_id: "y" }));
    s = applyEvent(s, ev("action_completed", { action_id: "y", condition: "fail" }));
    expect(s.actions["y"].status).toBe("failed");
  });

  test("edge_traversed records a successor and re-derives depth", () => {
    let s = seedActions(initialState(), [
      { id: "a", type: "agent", status: "pending" },
      { id: "b", type: "agent", status: "inactive" },
    ]);
    s = applyEvent(s, ev("edge_traversed", { from: "a", to: "b", condition: "pass" }));
    expect(s.actions["a"].successors).toEqual(["b"]);
    expect(s.actions["b"].depth).toBe(1);
  });

  test("stats event updates totals + executor", () => {
    let s = applyEvent(initialState(), ev("stats", {
      actions: { total: 5, running: 1, completed: 2 },
      total_cost_usd: 1.5,
      executor: "running",
    }));
    expect(s.stats.total).toBe(5);
    expect(s.stats.byStatus.running).toBe(1);
    expect(s.stats.costUsd).toBeCloseTo(1.5);
    expect(s.stats.executor).toBe("running");
  });
});

describe("store: braid", () => {
  test("l3_message streams coalesce into a single braid message", () => {
    let s = initialState();
    s = applyEvent(s, ev("l3_message", { message_id: "m1", source: "l3", text: "Reifying " }));
    s = applyEvent(s, ev("l3_message", { message_id: "m1", source: "l3", text: "a loop." }));
    const texts = s.braid.filter((b) => b.kind === "text");
    expect(texts.length).toBe(1);
    expect(texts[0].text).toBe("Reifying a loop.");
  });

  test("user message is appended locally", () => {
    let s = addUserMessage(initialState(), "build me a thing");
    expect(s.braid[0].kind).toBe("user");
    expect(s.braid[0].text).toBe("build me a thing");
  });

  test("unhandled_failure is a needs-attention escalation", () => {
    let s = applyEvent(initialState(), ev("unhandled_failure", { action_id: "z", condition: "stuck" }));
    const esc = s.braid.find((b) => b.kind === "escalation");
    expect(esc?.needsAttention).toBe(true);
  });
});

describe("store: graph_edit is the P5→P6 seam (card + circuit update in one tick)", () => {
  test("an accepted batch renders a card AND updates the circuit pane", () => {
    const edits = [
      { op: "add_action", id: "f.build", type: "agent", initial: true },
      { op: "add_action", id: "f.test", type: "command" },
      { op: "add_edge", from: "f.build", to: "f.test", condition: "pass" },
      { op: "add_edge", from: "f.test", to: "f.build", condition: "fail" },
    ];
    let s = applyEvent(initialState(), ev("graph_edit", { message_id: "m", ok: true, edits, issues: [] }));

    // Card in the braid.
    const card = s.braid.find((b) => b.kind === "graph_edit");
    expect(card?.editCard?.ok).toBe(true);
    expect(card?.editCard?.summary).toContain("+f.build");

    // Circuit updated in the same event.
    expect(s.hasCircuit).toBe(true);
    expect(s.order).toContain("f.build");
    expect(s.actions["f.build"].status).toBe("pending"); // initial
    expect(s.actions["f.test"].status).toBe("inactive");
    expect(s.actions["f.build"].successors).toContain("f.test");
    // Back-edge is present in the row model too.
    expect(s.actions["f.test"].successors).toContain("f.build");
  });

  test("a rejected batch renders a card but leaves the circuit untouched", () => {
    let s = applyEvent(initialState(), ev("graph_edit", {
      ok: false,
      edits: [{ op: "add_action", id: "bad" }],
      issues: ["Unbounded cycle detected"],
      error: undefined,
    }));
    const card = s.braid.find((b) => b.kind === "graph_edit");
    expect(card?.editCard?.ok).toBe(false);
    expect(card?.editCard?.issues[0]).toContain("Unbounded cycle");
    expect(s.order).not.toContain("bad");
    expect(s.hasCircuit).toBe(false);
  });
});
