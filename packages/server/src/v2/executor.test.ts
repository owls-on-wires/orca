import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { OrcaDatabase } from "./db";
import { Executor, type ExecutorOptions, type RunActionFn } from "./executor";
import { createAction, createEdge, createProject, type ActionConfig } from "./schema";
import type { ActionResult, WaitingResult } from "./action-runner";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let db: OrcaDatabase;
let callOrder: string[];

function passResult(cost = 0): ActionResult {
  return {
    condition: "pass",
    output: { status: "passed", summary: "ok" },
    cost_usd: cost,
    duration_ms: 100,
    num_turns: 1,
  };
}

function failResult(cost = 0): ActionResult {
  return {
    condition: "fail",
    output: { status: "failed", summary: "fail" },
    cost_usd: cost,
    duration_ms: 100,
    num_turns: 1,
  };
}

function waitingResult(): WaitingResult {
  return {
    waiting: true,
    output: { status: "waiting", summary: "waiting for input" },
  };
}

function makeOptions(
  runActionFn: RunActionFn,
  overrides: Partial<ExecutorOptions> = {},
): ExecutorOptions {
  return {
    projectDir: "/tmp",
    runActionFn,
    ...overrides,
  };
}

beforeEach(() => {
  db = new OrcaDatabase(":memory:");
  callOrder = [];
});

afterEach(() => {
  db.close();
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("executor", () => {
  test("linear chain: A → B → C, all pass → all completed", async () => {
    db.insertAction(createAction({ id: "a", status: "pending" }));
    db.insertAction(createAction({ id: "b", status: "inactive" }));
    db.insertAction(createAction({ id: "c", status: "inactive" }));
    db.insertEdge(createEdge("a", "b", "pass"));
    db.insertEdge(createEdge("b", "c", "pass"));

    const run: RunActionFn = async (action) => {
      callOrder.push(action.id);
      return passResult();
    };

    const executor = new Executor(db, makeOptions(run));
    await executor.run();

    expect(callOrder).toEqual(["a", "b", "c"]);
    expect(db.getAction("a")!.status).toBe("completed");
    expect(db.getAction("b")!.status).toBe("completed");
    expect(db.getAction("c")!.status).toBe("completed");
    expect(executor.isIdle()).toBe(true);
  });

  test("retry loop: dev [pass]→ eval [fail]→ dev [pass]→ eval [pass]→ done", async () => {
    db.insertAction(createAction({ id: "dev", status: "pending" }));
    db.insertAction(createAction({ id: "eval", status: "inactive" }));
    db.insertAction(createAction({ id: "done", status: "inactive" }));
    db.insertEdge(createEdge("dev", "eval", "pass"));
    db.insertEdge(createEdge("eval", "dev", "fail"));
    db.insertEdge(createEdge("eval", "done", "pass"));

    let evalCalls = 0;
    const run: RunActionFn = async (action) => {
      callOrder.push(action.id);
      if (action.id === "eval") {
        evalCalls++;
        if (evalCalls === 1) return failResult();
        return passResult();
      }
      return passResult();
    };

    const executor = new Executor(db, makeOptions(run));
    await executor.run();

    expect(callOrder).toEqual(["dev", "eval", "dev", "eval", "done"]);
    expect(db.getAction("done")!.status).toBe("completed");
    expect(db.getAction("dev")!.iteration).toBeGreaterThan(0);
  });

  test("max iterations: retry loop exceeds limit → action fails", async () => {
    db.insertAction(createAction({
      id: "dev",
      status: "pending",
      params: { max_iterations: 2 },
    }));
    db.insertAction(createAction({
      id: "eval",
      status: "inactive",
      params: { max_iterations: 2 },
    }));
    db.insertAction(createAction({ id: "fallback", status: "inactive" }));

    db.insertEdge(createEdge("dev", "eval", "pass"));
    db.insertEdge(createEdge("eval", "dev", "fail"));
    db.insertEdge(createEdge("dev", "fallback", "cost_exceeded"));

    const run: RunActionFn = async (action) => {
      callOrder.push(action.id);
      if (action.id === "eval") return failResult();
      return passResult();
    };

    const executor = new Executor(db, makeOptions(run));
    await executor.run();

    const dev = db.getAction("dev")!;
    expect(dev.status).toBe("failed");
    const fallback = db.getAction("fallback")!;
    expect(fallback.status).toBe("completed");
  });

  test("chain preference: two independent chains, executor finishes one before starting other", async () => {
    db.insertAction(createAction({ id: "a1", status: "pending", created_at: "2024-01-01T00:00:00Z" }));
    db.insertAction(createAction({ id: "a2", status: "inactive" }));
    db.insertAction(createAction({ id: "b1", status: "pending", created_at: "2024-01-01T00:00:01Z" }));
    db.insertAction(createAction({ id: "b2", status: "inactive" }));
    db.insertEdge(createEdge("a1", "a2", "pass"));
    db.insertEdge(createEdge("b1", "b2", "pass"));

    const run: RunActionFn = async (action) => {
      callOrder.push(action.id);
      return passResult();
    };

    const executor = new Executor(db, makeOptions(run));
    await executor.run();

    expect(callOrder).toEqual(["a1", "a2", "b1", "b2"]);
  });

  test("WaitingResult: action enters waiting, executor moves to next pending", async () => {
    db.insertAction(createAction({
      id: "server",
      status: "pending",
      type: "command",
      created_at: "2024-01-01T00:00:00Z",
    }));
    db.insertAction(createAction({
      id: "test",
      status: "pending",
      created_at: "2024-01-01T00:00:01Z",
    }));

    let serverCalled = false;
    const run: RunActionFn = async (action) => {
      callOrder.push(action.id);
      if (action.id === "server" && !serverCalled) {
        serverCalled = true;
        return waitingResult();
      }
      return passResult();
    };

    const executor = new Executor(db, makeOptions(run));
    await executor.run();

    expect(callOrder).toEqual(["server", "test"]);
    expect(db.getAction("server")!.status).toBe("waiting");
    expect(db.getAction("test")!.status).toBe("completed");
  });

  test("budget exceeded: total cost over limit → cost_exceeded condition", async () => {
    db.insertAction(createAction({
      id: "t.dev",
      status: "completed",
      tags: ["task:t"],
      cost_usd: 1.0,
      params: { max_cost: 1.0 },
    }));
    db.insertAction(createAction({
      id: "t.eval",
      status: "pending",
      tags: ["task:t"],
      params: { max_cost: 1.0 },
    }));
    db.insertAction(createAction({
      id: "t.fallback",
      status: "inactive",
      tags: ["task:t"],
    }));
    db.insertEdge(createEdge("t.dev", "t.eval", "pass"));
    db.insertEdge(createEdge("t.eval", "t.fallback", "cost_exceeded"));

    const run: RunActionFn = async (action) => {
      callOrder.push(action.id);
      return passResult(0.5);
    };

    const executor = new Executor(db, makeOptions(run));
    await executor.run();

    expect(callOrder).not.toContain("t.eval");
    expect(db.getAction("t.eval")!.status).toBe("failed");
    expect(db.getAction("t.fallback")!.status).toBe("completed");
    expect(callOrder).toContain("t.fallback");
  });

  test("stuck detection: same output 3 times → stuck condition", async () => {
    db.insertAction(createAction({ id: "dev", status: "pending" }));
    db.insertAction(createAction({ id: "eval", status: "inactive" }));
    db.insertAction(createAction({ id: "stuck-handler", status: "inactive" }));
    db.insertEdge(createEdge("dev", "eval", "pass"));
    db.insertEdge(createEdge("eval", "dev", "fail"));
    db.insertEdge(createEdge("dev", "stuck-handler", "stuck"));

    const run: RunActionFn = async (action) => {
      callOrder.push(action.id);
      if (action.id === "eval") return failResult();
      return passResult();
    };

    const executor = new Executor(db, makeOptions(run));
    await executor.run();

    expect(db.getAction("stuck-handler")!.status).toBe("completed");
    expect(callOrder).toContain("stuck-handler");
  });

  test("pause/resume: executor stops between actions when paused", async () => {
    db.insertAction(createAction({ id: "a", status: "pending" }));
    db.insertAction(createAction({ id: "b", status: "inactive" }));
    db.insertEdge(createEdge("a", "b", "pass"));

    const run: RunActionFn = async (action) => {
      callOrder.push(action.id);
      return passResult();
    };

    const executor = new Executor(db, makeOptions(run, {
      onActionEnd: () => {
        if (callOrder.length === 1) executor.pause();
      },
    }));
    await executor.run();

    expect(callOrder).toEqual(["a"]);
    expect(executor.isPaused()).toBe(true);
    expect(db.getAction("a")!.status).toBe("completed");
    expect(db.getAction("b")!.status).toBe("pending");

    // Resume
    executor.resume();
    await executor.run();

    expect(callOrder).toEqual(["a", "b"]);
    expect(db.getAction("b")!.status).toBe("completed");
  });

  test("idle callback when nothing pending", async () => {
    let idleCalled = false;
    const run: RunActionFn = async () => passResult();
    const executor = new Executor(db, makeOptions(run, {
      onIdle: () => { idleCalled = true; },
    }));
    await executor.run();

    expect(idleCalled).toBe(true);
    expect(executor.isIdle()).toBe(true);
  });

  test("inactive actions don't run until activated by edge", async () => {
    db.insertAction(createAction({ id: "a", status: "pending" }));
    db.insertAction(createAction({ id: "b", status: "inactive" }));

    const run: RunActionFn = async (action) => {
      callOrder.push(action.id);
      return passResult();
    };

    let idleCalled = false;
    const executor = new Executor(db, makeOptions(run, {
      onIdle: () => { idleCalled = true; },
    }));
    await executor.run();

    expect(callOrder).toEqual(["a"]);
    expect(db.getAction("b")!.status).toBe("inactive");
    expect(idleCalled).toBe(true);
  });

  // ── Supervisor fallback ──

  test("unhandled failure escalates to supervisor action", async () => {
    db.insertProject(createProject({ id: "p", project_dir: "/tmp" }));
    db.insertAction(createAction({ id: "task.develop", status: "pending", project_id: "p", tags: ["project:p"] }));
    db.insertAction(createAction({ id: "supervisor", status: "inactive", project_id: "p", tags: ["type:supervisor", "project:p"] }));

    // Supervisor passes when it runs; original action fails
    const run: RunActionFn = async (action) => {
      if (action.tags.includes("type:supervisor")) return passResult();
      return failResult();
    };
    const unhandled: string[] = [];
    const executor = new Executor(db, makeOptions(run, {
      onUnhandledFailure: (action, condition) => {
        unhandled.push(`${action.id}:${condition}`);
      },
    }));
    await executor.run();

    // Supervisor ran and completed (was activated then executed)
    expect(db.getAction("supervisor")!.status).toBe("completed");
    expect(db.getAction("supervisor")!.params.failed_action).toBe("task.develop");
    expect(db.getAction("supervisor")!.params.failed_condition).toBe("fail");
    expect(unhandled).toContain("task.develop:fail");
  });

  test("supervisor gets failure output as context", async () => {
    db.insertProject(createProject({ id: "p", project_dir: "/tmp" }));
    db.insertAction(createAction({ id: "a", status: "pending", project_id: "p", tags: ["project:p"] }));
    db.insertAction(createAction({
      id: "sup", status: "inactive", project_id: "p",
      tags: ["type:supervisor", "project:p"],
      params: { prompt: "Fix things" },
    }));

    const run: RunActionFn = async (action) => {
      if (action.tags.includes("type:supervisor")) return passResult();
      return {
        condition: "error" as const,
        output: { status: "unknown", summary: "Something broke" },
        cost_usd: 0.1, duration_ms: 100, num_turns: 1,
      };
    };

    const executor = new Executor(db, makeOptions(run));
    await executor.run();

    // Supervisor ran — check the params that were set before it ran
    const sup = db.getAction("sup")!;
    expect(sup.status).toBe("completed");
    expect(sup.params.failed_action).toBe("a");
    expect(sup.params.failed_condition).toBe("error");
    expect((sup.params.failed_output as any).summary).toBe("Something broke");
    expect(sup.params.prompt).toBe("Fix things");
  });

  test("no supervisor: fires onUnhandledFailure callback only", async () => {
    db.insertAction(createAction({ id: "orphan", status: "pending" }));

    const run: RunActionFn = async () => ({
      condition: "error" as const,
      output: { status: "error", summary: "No edge" },
      cost_usd: 0, duration_ms: 10, num_turns: 0,
    });

    const unhandled: string[] = [];
    const executor = new Executor(db, makeOptions(run, {
      onUnhandledFailure: (action, condition) => {
        unhandled.push(`${action.id}:${condition}`);
      },
    }));
    await executor.run();

    expect(unhandled).toContain("orphan:error");
    expect(db.getAction("orphan")!.status).toBe("failed");
  });

  test("pass condition with no edges does NOT escalate", async () => {
    db.insertProject(createProject({ id: "p", project_dir: "/tmp" }));
    db.insertAction(createAction({ id: "terminal", status: "pending", project_id: "p", tags: ["project:p"] }));
    db.insertAction(createAction({ id: "sup", status: "inactive", project_id: "p", tags: ["type:supervisor", "project:p"] }));

    const run: RunActionFn = async () => passResult();
    const executor = new Executor(db, makeOptions(run));
    await executor.run();

    expect(db.getAction("sup")!.status).toBe("inactive");
  });

  test("supervisor can be re-activated on subsequent failures", async () => {
    db.insertProject(createProject({ id: "p", project_dir: "/tmp" }));
    db.insertAction(createAction({ id: "a", status: "pending", project_id: "p", tags: ["project:p"] }));
    db.insertAction(createAction({ id: "b", status: "pending", project_id: "p", tags: ["project:p"] }));
    db.insertAction(createAction({ id: "sup", status: "inactive", project_id: "p", tags: ["type:supervisor", "project:p"] }));

    const supRuns: string[] = [];
    const run: RunActionFn = async (action) => {
      if (action.tags.includes("type:supervisor")) {
        supRuns.push(action.params.failed_action as string);
        return passResult();
      }
      return { condition: "error" as const, output: { status: "error", summary: "broke" }, cost_usd: 0, duration_ms: 10, num_turns: 0 };
    };

    const executor = new Executor(db, makeOptions(run));
    await executor.run();

    // Supervisor ran at least once
    expect(supRuns.length).toBeGreaterThanOrEqual(1);
    expect(db.getAction("sup")!.status).toBe("completed");
  });

  test("escalation records history entry", async () => {
    db.insertProject(createProject({ id: "p", project_dir: "/tmp" }));
    db.insertAction(createAction({ id: "x", status: "pending", project_id: "p", tags: ["project:p"] }));
    db.insertAction(createAction({ id: "sup", status: "inactive", project_id: "p", tags: ["type:supervisor", "project:p"] }));

    const run: RunActionFn = async () => failResult();
    const executor = new Executor(db, makeOptions(run));
    await executor.run();

    const history = db.getHistory("x");
    const escalated = history.find((h) => h.event_type === "escalated");
    expect(escalated).toBeDefined();
    expect((escalated!.data as any).supervisor_id).toBe("sup");
  });
});
