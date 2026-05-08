import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { OrcaDatabase } from "./db";
import { Executor, type ExecutorOptions, type RunActionFn } from "./executor";
import { createAction, createEdge, type ActionConfig } from "./schema";
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
});
