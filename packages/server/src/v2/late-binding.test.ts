/**
 * CG4 — late-binding semantics for task context.
 *
 * A task's context is not frozen at creation: a planner can rewrite a PENDING
 * task's prompt and it takes effect when the task runs. The freeze is exactly
 * "no mutating a running action": once a task is RUNNING, its prompt is frozen
 * and a rewrite is rejected (see kbase/vision/context-as-graph.md).
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { OrcaDatabase } from "./db";
import { createAction } from "./schema";
import { Executor, type RunActionFn } from "./executor";
import { applyValidatedDelta } from "./graph-ops";

let db: OrcaDatabase;
let tmpDir: string;

beforeEach(() => {
  db = new OrcaDatabase(":memory:");
  tmpDir = mkdtempSync(join(tmpdir(), "late-binding-"));
});

afterEach(() => {
  db.close();
});

describe("CG4: late-binding — pending prompt update reflected at run", () => {
  test("the executor runs the LATEST prompt, not the one at creation time", async () => {
    db.insertAction(
      createAction({ id: "a", status: "pending", type: "agent", params: { prompt: "OLD prompt" } }),
    );

    // Rebind context while the action is still pending.
    const upd = applyValidatedDelta(db.rawDb, [
      { type: "update_params", action_id: "a", params: { prompt: "NEW prompt" } },
    ]);
    expect(upd.ok).toBe(true);

    let seenPrompt: unknown;
    const spy: RunActionFn = async (action) => {
      seenPrompt = action.params.prompt;
      return { condition: "pass", output: { status: "passed", summary: "ok" }, cost_usd: 0, duration_ms: 1, num_turns: 1 };
    };

    const exec = new Executor(db, { projectDir: tmpDir, runActionFn: spy });
    await exec.run();

    expect(seenPrompt).toBe("NEW prompt");
  });
});

describe("CG4: freeze-on-run — running prompt update rejected", () => {
  test("rewriting a RUNNING action's prompt is rejected; prompt unchanged", () => {
    db.insertAction(
      createAction({ id: "r", status: "running", type: "agent", params: { prompt: "FROZEN" } }),
    );

    const result = applyValidatedDelta(db.rawDb, [
      { type: "update_params", action_id: "r", params: { prompt: "sneaky rewrite" } },
    ]);

    expect(result.ok).toBe(false);
    expect(result.kind).toBe("execution");
    expect(result.error).toContain("frozen on run");
    // The prompt is untouched.
    expect(db.getAction("r")!.params.prompt).toBe("FROZEN");
  });

  test("a NON-prompt param update on a running action still succeeds", () => {
    db.insertAction(
      createAction({ id: "r2", status: "running", type: "agent", params: { prompt: "FROZEN", max_turns: 10 } }),
    );

    const result = applyValidatedDelta(db.rawDb, [
      { type: "update_params", action_id: "r2", params: { max_turns: 25 } },
    ]);

    expect(result.ok).toBe(true);
    expect(db.getAction("r2")!.params.max_turns).toBe(25);
    expect(db.getAction("r2")!.params.prompt).toBe("FROZEN"); // untouched
  });

  test("rewriting a PENDING action's prompt is allowed (not yet frozen)", () => {
    db.insertAction(
      createAction({ id: "p", status: "pending", type: "agent", params: { prompt: "before" } }),
    );

    const result = applyValidatedDelta(db.rawDb, [
      { type: "update_params", action_id: "p", params: { prompt: "after" } },
    ]);

    expect(result.ok).toBe(true);
    expect(db.getAction("p")!.params.prompt).toBe("after");
  });
});
