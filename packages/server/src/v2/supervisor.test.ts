import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { OrcaDatabase } from "./db";
import { createAction, createEdge, type ActionOutput } from "./schema";
import {
  buildSupervisorPrompt,
  handleSupervisorResult,
  parseSupervisorOutput,
} from "./supervisor";
import { Executor, type RunActionFn } from "./executor";
import type { ActionResult } from "./action-runner";

let db: OrcaDatabase;

beforeEach(() => {
  db = new OrcaDatabase(":memory:");
});

afterEach(() => {
  db.close();
});

describe("buildSupervisorPrompt", () => {
  test("includes graph state and failure context", () => {
    db.insertAction(
      createAction({
        id: "t.develop",
        type: "agent",
        status: "failed",
        tags: ["task:t"],
        output: { status: "failed", summary: "Tests did not pass" },
        cost_usd: 1.5,
        iteration: 2,
      }),
    );
    db.insertAction(
      createAction({
        id: "t.eval",
        type: "command",
        status: "completed",
        tags: ["task:t"],
        cost_usd: 0.1,
      }),
    );
    db.insertEdge(createEdge("t.develop", "t.eval", "pass"));

    const trigger = db.getAction("t.develop")!;
    const prompt = buildSupervisorPrompt(db.rawDb, trigger, "fail", "task:t");

    // Should contain failure context
    expect(prompt).toContain("t.develop");
    expect(prompt).toContain("fail");
    expect(prompt).toContain("Tests did not pass");

    // Should contain graph state
    expect(prompt).toContain("Current graph state");
    expect(prompt).toContain("t.eval");

    // Should contain task history with costs/iterations
    expect(prompt).toContain("Task history");
    expect(prompt).toContain("iteration=2");
    expect(prompt).toContain("$1.50");

    // Should contain available mutations
    expect(prompt).toContain("add_action");
    expect(prompt).toContain("remove_action");
    expect(prompt).toContain("update_params");
    expect(prompt).toContain("add_edge");
    expect(prompt).toContain("remove_edge");

    // Should contain instructions
    expect(prompt).toContain("Diagnose");
  });
});

describe("parseSupervisorOutput", () => {
  test("parses valid output", () => {
    const output: ActionOutput = {
      status: "passed",
      summary: "Supervisor completed",
      diagnosis: "The prompt was too vague",
      edits: [
        { type: "update_params", action_id: "t.develop", params: { max_turns: 50 } },
      ],
      retry_action: "t.develop",
    };

    const parsed = parseSupervisorOutput(output);
    expect(parsed).not.toBeNull();
    expect(parsed!.diagnosis).toBe("The prompt was too vague");
    expect(parsed!.edits).toHaveLength(1);
    expect(parsed!.retry_action).toBe("t.develop");
  });

  test("returns null for non-supervisor output", () => {
    const output: ActionOutput = {
      status: "passed",
      summary: "Normal action",
    };

    expect(parseSupervisorOutput(output)).toBeNull();
  });
});

describe("handleSupervisorResult", () => {
  test("applies deltas from supervisor output", () => {
    db.insertAction(
      createAction({
        id: "t.develop",
        type: "agent",
        status: "failed",
        tags: ["task:t"],
        params: { prompt: "do stuff", max_turns: 10 },
      }),
    );

    const output: ActionOutput = {
      status: "passed",
      summary: "Supervisor completed",
      diagnosis: "max_turns too low",
      edits: [
        { type: "update_params", action_id: "t.develop", params: { max_turns: 50 } },
      ],
      retry_action: null,
    };

    handleSupervisorResult(db, output);

    const updated = db.getAction("t.develop")!;
    expect(updated.params.max_turns).toBe(50);
  });

  test("retry_action re-queues target action", () => {
    db.insertAction(
      createAction({
        id: "t.develop",
        type: "agent",
        status: "failed",
        tags: ["task:t"],
      }),
    );

    const output: ActionOutput = {
      status: "passed",
      summary: "Supervisor completed",
      diagnosis: "Needs retry",
      edits: [],
      retry_action: "t.develop",
    };

    handleSupervisorResult(db, output);

    const updated = db.getAction("t.develop")!;
    expect(updated.status).toBe("pending");
  });

  test("invalid deltas rejected gracefully", () => {
    db.insertAction(
      createAction({
        id: "t.develop",
        type: "agent",
        status: "completed",
        tags: ["task:t"],
      }),
    );

    const output: ActionOutput = {
      status: "passed",
      summary: "Supervisor completed",
      diagnosis: "Trying invalid edit",
      edits: [
        // update_params on a non-existent action
        { type: "update_params", action_id: "nonexistent", params: { foo: 1 } },
      ],
    };

    // Should not throw
    expect(() => handleSupervisorResult(db, output)).not.toThrow();

    // Original action unchanged
    const original = db.getAction("t.develop")!;
    expect(original.status).toBe("completed");
  });

  test("skips edits with missing required fields", () => {
    db.insertAction(
      createAction({
        id: "t.develop",
        type: "agent",
        status: "completed",
        tags: ["task:t"],
      }),
    );

    const output: ActionOutput = {
      status: "passed",
      summary: "Supervisor completed",
      diagnosis: "Incomplete edit",
      edits: [
        // remove_action with no action_id
        { type: "remove_action" },
        // add_edge with no edge
        { type: "add_edge", action_id: "foo" },
      ],
    };

    // Should not throw
    expect(() => handleSupervisorResult(db, output)).not.toThrow();
  });
});

describe("executor supervisor integration", () => {
  test("calls handleSupervisorResult after supervisor action passes", async () => {
    // Set up: a failed develop action + supervisor action
    db.insertAction(
      createAction({
        id: "t.develop",
        type: "agent",
        status: "failed",
        tags: ["task:t"],
        params: { prompt: "implement feature", max_turns: 10 },
        output: { status: "failed", summary: "Tests failed" },
      }),
    );
    db.insertAction(
      createAction({
        id: "t.supervisor",
        type: "agent",
        status: "pending",
        tags: ["task:t", "type:supervisor"],
      }),
    );

    const runAction: RunActionFn = async (action) => {
      if (action.id === "t.supervisor") {
        return {
          condition: "pass" as const,
          output: {
            status: "passed",
            summary: "Supervisor diagnosed issue",
            diagnosis: "max_turns too low",
            edits: [
              {
                type: "update_params",
                action_id: "t.develop",
                params: { max_turns: 50 },
              },
            ],
            retry_action: "t.develop",
          },
          cost_usd: 0.5,
          duration_ms: 100,
          num_turns: 1,
        };
      }
      // develop action — just pass this time
      return {
        condition: "pass" as const,
        output: { status: "passed", summary: "ok" },
        cost_usd: 0.1,
        duration_ms: 100,
        num_turns: 5,
      };
    };

    const executor = new Executor(db, {
      projectDir: "/tmp",
      runActionFn: runAction,
    });

    await executor.run();

    // After supervisor runs, t.develop should have updated params
    const develop = db.getAction("t.develop")!;
    expect(develop.params.max_turns).toBe(50);
    // And it should have been re-queued (status completed since it ran again)
    expect(develop.status).toBe("completed");
  });
});
