/**
 * P4 Governance — Design-Rule Check (DRC) for graph mutations.
 *
 * Every prospective mutation is validated against the post-delta state and
 * applied inside a BEGIN/COMMIT/ROLLBACK transaction. A rejected mutation must
 * leave the actions+edges graph BYTE-IDENTICAL and emit an `invalid_mutation`
 * history event. Legal loops (a back-edge with a close/escape condition) must be
 * accepted.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { OrcaDatabase } from "./db";
import { createAction, type ActionOutput, type GraphDelta } from "./schema";
import { applyValidatedDelta } from "./graph-ops";
import { handleSupervisorResult } from "./supervisor";

let db: OrcaDatabase;
let raw: Database;

beforeEach(() => {
  db = new OrcaDatabase(":memory:");
  raw = db.rawDb;
  // A minimal, clean base graph: one completed supervisor action to attach
  // invalid_mutation history events to.
  db.insertAction(createAction({ id: "sup", status: "completed", tags: ["type:supervisor"] }));
  db.insertAction(createAction({ id: "keep", status: "completed" }));
});

afterEach(() => {
  db.close();
});

/** Byte-level snapshot of the mutable graph (actions + edges), history excluded. */
function graphSnapshot(): string {
  const actions = raw.query("SELECT * FROM actions ORDER BY id").all();
  const edges = raw.query("SELECT * FROM edges ORDER BY id").all();
  return JSON.stringify({ actions, edges });
}

function invalidMutationCount(): number {
  return (
    raw
      .query(
        "SELECT COUNT(*) AS n FROM history WHERE event_type = 'invalid_mutation'",
      )
      .get() as { n: number }
  ).n;
}

// ---------------------------------------------------------------------------
// Adversarial malformed deltas: 12 scenarios, each must roll back the graph
// byte-identical AND record an invalid_mutation event.
// ---------------------------------------------------------------------------

const ADVERSARIAL: Array<{ name: string; deltas: GraphDelta[]; kind: "validation" | "execution" }> = [
  {
    name: "duplicate action id",
    deltas: [{ type: "add_action", action_id: "sup", action: {} }],
    kind: "execution",
  },
  {
    name: "remove nonexistent action",
    deltas: [{ type: "remove_action", action_id: "ghost" }],
    kind: "execution",
  },
  {
    name: "update nonexistent action",
    deltas: [{ type: "update_params", action_id: "ghost", params: { x: 1 } }],
    kind: "execution",
  },
  {
    name: "edge from nonexistent action",
    deltas: [{ type: "add_edge", edge: { from_action: "ghost", to_action: "sup", condition: "pass" } }],
    kind: "execution",
  },
  {
    name: "edge to nonexistent action",
    deltas: [{ type: "add_edge", edge: { from_action: "sup", to_action: "ghost", condition: "pass" } }],
    kind: "execution",
  },
  {
    name: "remove nonexistent edge",
    deltas: [{ type: "remove_edge", edge_id: 9999 }],
    kind: "execution",
  },
  {
    name: "edge with missing condition",
    // Deliberately malformed — bypass the type to model a bad agent payload.
    deltas: [{ type: "add_edge", edge: { from_action: "sup", to_action: "keep" } } as unknown as GraphDelta],
    kind: "execution",
  },
  {
    name: "unbounded self-loop on pass",
    deltas: [
      { type: "add_action", action_id: "spin", action: { status: "pending" } },
      { type: "add_edge", edge: { from_action: "spin", to_action: "spin", condition: "pass" } },
    ],
    kind: "validation",
  },
  {
    name: "unbounded two-node cycle (pass↔pass)",
    deltas: [
      { type: "add_action", action_id: "p", action: { status: "pending" } },
      { type: "add_action", action_id: "q", action: { status: "inactive" } },
      { type: "add_edge", edge: { from_action: "p", to_action: "q", condition: "pass" } },
      { type: "add_edge", edge: { from_action: "q", to_action: "p", condition: "pass" } },
    ],
    kind: "validation",
  },
  {
    name: "valid-then-invalid batch (partial rollback)",
    deltas: [
      { type: "add_action", action_id: "half", action: { status: "completed" } },
      { type: "remove_action", action_id: "ghost" },
    ],
    kind: "execution",
  },
  {
    name: "valid action then unbounded cycle",
    deltas: [
      { type: "add_action", action_id: "good", action: { status: "completed" } },
      { type: "add_action", action_id: "bad", action: { status: "pending" } },
      { type: "add_edge", edge: { from_action: "bad", to_action: "bad", condition: "pass" } },
    ],
    kind: "validation",
  },
  {
    name: "duplicate edge (unique constraint)",
    deltas: [
      { type: "add_edge", edge: { from_action: "sup", to_action: "keep", condition: "pass" } },
      { type: "add_edge", edge: { from_action: "sup", to_action: "keep", condition: "pass" } },
    ],
    kind: "execution",
  },
];

describe("applyValidatedDelta — adversarial rollback", () => {
  for (const scenario of ADVERSARIAL) {
    test(`rejects + rolls back byte-identical: ${scenario.name}`, () => {
      const before = graphSnapshot();
      const beforeInvalid = invalidMutationCount();

      const result = applyValidatedDelta(raw, scenario.deltas, { recordFor: "sup" });

      // Rejected
      expect(result.ok).toBe(false);
      expect(result.kind).toBe(scenario.kind);

      // Graph byte-identical (rollback proven)
      expect(graphSnapshot()).toBe(before);

      // invalid_mutation emitted
      expect(invalidMutationCount()).toBe(beforeInvalid + 1);
    });
  }

  test("all 12 adversarial deltas leave the graph byte-identical in sequence", () => {
    const before = graphSnapshot();
    for (const scenario of ADVERSARIAL) {
      applyValidatedDelta(raw, scenario.deltas, { recordFor: "sup" });
    }
    expect(graphSnapshot()).toBe(before);
    expect(invalidMutationCount()).toBe(ADVERSARIAL.length);
  });
});

// ---------------------------------------------------------------------------
// Legal loop acceptance.
// ---------------------------------------------------------------------------

describe("applyValidatedDelta — legal loop acceptance", () => {
  test("ACCEPTS a self-loop with an escape condition", () => {
    const result = applyValidatedDelta(raw, [
      { type: "add_action", action_id: "build", action: { status: "pending" } },
      { type: "add_action", action_id: "ship", action: { status: "completed" } },
      // Back-edge: retry on fail.
      { type: "add_edge", edge: { from_action: "build", to_action: "build", condition: "fail" } },
      // Escape: exit the loop on pass.
      { type: "add_edge", edge: { from_action: "build", to_action: "ship", condition: "pass" } },
    ]);

    expect(result.ok).toBe(true);
    expect(db.getAction("build")).not.toBeNull();
    // Both the back-edge and the escape edge were committed.
    expect(db.getEdgesFrom("build")).toHaveLength(2);
    // No invalid_mutation recorded for an accepted mutation.
    expect(invalidMutationCount()).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// handleSupervisorResult routes through the governed chokepoint.
// ---------------------------------------------------------------------------

describe("handleSupervisorResult DRC", () => {
  test("applies a valid supervisor edit", () => {
    db.insertAction(
      createAction({ id: "t.develop", status: "failed", tags: ["task:t"], params: { max_turns: 10 } }),
    );

    const output: ActionOutput = {
      status: "passed",
      summary: "diagnosed",
      diagnosis: "raise max_turns",
      edits: [{ type: "update_params", action_id: "t.develop", params: { max_turns: 50 } }],
    };

    const result = handleSupervisorResult(db, output, "sup");
    expect(result?.ok).toBe(true);
    expect(db.getAction("t.develop")!.params.max_turns).toBe(50);
  });

  test("rejects an invalid supervisor edit and records invalid_mutation", () => {
    const before = graphSnapshot();

    const output: ActionOutput = {
      status: "passed",
      summary: "diagnosed",
      diagnosis: "bad edit",
      // update a nonexistent action → execution error → reject.
      edits: [{ type: "update_params", action_id: "does-not-exist", params: { x: 1 } }],
    };

    const result = handleSupervisorResult(db, output, "sup");

    expect(result?.ok).toBe(false);
    expect(graphSnapshot()).toBe(before);
    expect(invalidMutationCount()).toBe(1);
  });

  test("supervisor cannot commit an unbounded loop", () => {
    db.insertAction(createAction({ id: "t.develop", status: "pending", tags: ["task:t"] }));
    const before = graphSnapshot();

    const output: ActionOutput = {
      status: "passed",
      summary: "diagnosed",
      diagnosis: "loop it",
      edits: [
        // self-loop on pass = unbounded, must be rejected by the DRC.
        { type: "add_edge", edge: { from_action: "t.develop", to_action: "t.develop", condition: "pass" } },
      ],
    };

    const result = handleSupervisorResult(db, output, "sup");
    expect(result?.ok).toBe(false);
    expect(result?.kind).toBe("validation");
    expect(graphSnapshot()).toBe(before);
  });
});
