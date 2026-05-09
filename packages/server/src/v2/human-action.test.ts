import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { OrcaDatabase } from "./db";
import { Executor, type RunActionFn } from "./executor";
import { startServer } from "./server";
import { createAction, createEdge, type ActionConfig, type EdgeCondition } from "./schema";
import type { ActionResult, WaitingResult } from "./action-runner";
import { runAction } from "./action-runner";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let db: OrcaDatabase;

function passResult(cost = 0): ActionResult {
  return {
    condition: "pass",
    output: { status: "passed", summary: "ok" },
    cost_usd: cost,
    duration_ms: 100,
    num_turns: 1,
  };
}

function failResult(): ActionResult {
  return {
    condition: "fail",
    output: { status: "failed", summary: "fail" },
    cost_usd: 0,
    duration_ms: 100,
    num_turns: 1,
  };
}

function waitingResult(): WaitingResult {
  return {
    waiting: true,
    output: { status: "waiting", summary: "waiting for human" },
  };
}

beforeEach(() => {
  db = new OrcaDatabase(":memory:");
});

afterEach(() => {
  db.close();
});

// ---------------------------------------------------------------------------
// Unit: command runs, enters waiting state
// ---------------------------------------------------------------------------

describe("human action - waiting state", () => {
  test("command with wait_for_response returns WaitingResult", async () => {
    const action = createAction({
      id: "notify",
      type: "command",
      params: { command: "echo notification sent", wait_for_response: true },
    });

    const result = await runAction(action, [], { projectDir: "/tmp" });
    expect("waiting" in result && result.waiting).toBe(true);
    expect((result as WaitingResult).output.status).toBe("passed");
  });

  test("executor sets status to waiting and continues to next pending", async () => {
    const callOrder: string[] = [];

    db.insertAction(createAction({
      id: "human",
      type: "command",
      status: "pending",
      created_at: "2024-01-01T00:00:00Z",
    }));
    db.insertAction(createAction({
      id: "other",
      status: "pending",
      created_at: "2024-01-01T00:00:01Z",
    }));

    const run: RunActionFn = async (action) => {
      callOrder.push(action.id);
      if (action.id === "human") return waitingResult();
      return passResult();
    };

    const executor = new Executor(db, { projectDir: "/tmp", runActionFn: run });
    await executor.run();

    expect(callOrder).toEqual(["human", "other"]);
    expect(db.getAction("human")!.status).toBe("waiting");
    expect(db.getAction("other")!.status).toBe("completed");
  });
});

// ---------------------------------------------------------------------------
// Unit: completeWaitingAction follows edges
// ---------------------------------------------------------------------------

describe("human action - respond completes and follows edges", () => {
  test("completeWaitingAction with pass status follows pass edges", () => {
    db.insertAction(createAction({ id: "human", status: "waiting", type: "command" }));
    db.insertAction(createAction({ id: "next", status: "inactive" }));
    db.insertEdge(createEdge("human", "next", "pass"));

    const executor = new Executor(db, { projectDir: "/tmp", runActionFn: async () => passResult() });

    const condition = executor.completeWaitingAction("human", {
      status: "approved",
      summary: "Looks good",
    });

    expect(condition).toBe("pass");
    expect(db.getAction("human")!.status).toBe("completed");
    expect(db.getAction("human")!.output!.status).toBe("approved");
    expect(db.getAction("next")!.status).toBe("pending");
  });

  test("completeWaitingAction with fail status follows fail edges", () => {
    db.insertAction(createAction({ id: "human", status: "waiting", type: "command" }));
    db.insertAction(createAction({ id: "retry", status: "inactive" }));
    db.insertEdge(createEdge("human", "retry", "fail"));

    const executor = new Executor(db, { projectDir: "/tmp", runActionFn: async () => passResult() });

    const condition = executor.completeWaitingAction("human", {
      status: "rejected",
      summary: "Not ready",
    });

    expect(condition).toBe("fail");
    expect(db.getAction("human")!.status).toBe("failed");
    expect(db.getAction("retry")!.status).toBe("pending");
  });

  test("edge routing: approved → pass edge, rejected → fail edge", () => {
    db.insertAction(createAction({ id: "review", status: "waiting", type: "command" }));
    db.insertAction(createAction({ id: "deploy", status: "inactive" }));
    db.insertAction(createAction({ id: "fix", status: "inactive" }));
    db.insertEdge(createEdge("review", "deploy", "pass"));
    db.insertEdge(createEdge("review", "fix", "fail"));

    const executor = new Executor(db, { projectDir: "/tmp", runActionFn: async () => passResult() });

    // Approved → pass → deploy activates
    executor.completeWaitingAction("review", { status: "approved", summary: "Ship it" });
    expect(db.getAction("deploy")!.status).toBe("pending");
    expect(db.getAction("fix")!.status).toBe("inactive");
  });
});

// ---------------------------------------------------------------------------
// Unit: template variable injection
// ---------------------------------------------------------------------------

describe("human action - template variable injection", () => {
  test("action_id is injected into command", async () => {
    const action = createAction({
      id: "task1.notify",
      type: "command",
      tags: ["task:task1"],
      params: {
        command: "echo action={action_id} task={task_id}",
        wait_for_response: true,
      },
    });

    const result = await runAction(action, [], { projectDir: "/tmp" });
    const output = (result as WaitingResult).output;
    // The stdout should contain the interpolated values
    expect(output.stdout).toContain("action=task1.notify");
    expect(output.stdout).toContain("task=task1");
  });

  test("summary and condition from predecessor are injected", async () => {
    const action = createAction({
      id: "task1.notify",
      type: "command",
      params: {
        command: "echo summary={summary} condition={condition}",
        wait_for_response: true,
      },
    });

    const predecessors = [
      {
        actionId: "task1.eval",
        output: { status: "failed", summary: "3 tests failing" },
      },
    ];

    const result = await runAction(action, predecessors, { projectDir: "/tmp" });
    const output = (result as WaitingResult).output;
    expect(output.stdout).toContain("summary=3 tests failing");
    expect(output.stdout).toContain("condition=failed");
  });
});

// ---------------------------------------------------------------------------
// Integration: end-to-end via server
// ---------------------------------------------------------------------------

describe("human action - end-to-end via server", () => {
  let server: ReturnType<typeof startServer>;
  let baseUrl: string;

  beforeEach(() => {
    // Create server with executor that uses our mock
    const callOrder: string[] = [];
    const runFn: RunActionFn = async (action) => {
      callOrder.push(action.id);
      if (action.params.wait_for_response) return waitingResult();
      return passResult();
    };

    const testDb = new OrcaDatabase(":memory:");
    const executor = new Executor(testDb, {
      projectDir: "/tmp",
      runActionFn: runFn,
    });

    server = startServer({ port: 0, db: testDb, executor, noExecutor: true });
    baseUrl = `http://localhost:${server.server.port}`;
  });

  afterEach(() => {
    clearInterval(server.heartbeatInterval);
    server.server.stop(true);
    server.db.close();
  });

  async function post(path: string, data: unknown) {
    const res = await fetch(`${baseUrl}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(data),
    });
    return { status: res.status, body: await res.json() };
  }

  async function get(path: string) {
    const res = await fetch(`${baseUrl}${path}`);
    return { status: res.status, body: await res.json() };
  }

  async function patch(path: string, data: unknown) {
    const res = await fetch(`${baseUrl}${path}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(data),
    });
    return { status: res.status, body: await res.json() };
  }

  test("create → wait → respond → complete → edges followed", async () => {
    // Manually insert a waiting action with downstream edges
    server.db.insertAction(createAction({
      id: "review",
      type: "command",
      status: "waiting",
      params: { command: "echo notify", wait_for_response: true },
      output: { status: "waiting", summary: "awaiting review" },
    }));
    server.db.insertAction(createAction({
      id: "deploy",
      status: "inactive",
    }));
    server.db.insertEdge(createEdge("review", "deploy", "pass"));

    // Respond to the waiting action
    const { status, body } = await post("/actions/review/respond", {
      status: "approved",
      summary: "Ship it",
    });

    expect(status).toBe(200);
    expect(body.status).toBe("completed");
    expect(body.condition).toBe("pass");

    // Verify the action is completed
    const { body: actionData } = await get("/actions/review");
    expect(actionData.action.status).toBe("completed");
    expect(actionData.action.output.status).toBe("approved");

    // Verify downstream was activated (may already be completed if executor ran)
    const { body: deployData } = await get("/actions/deploy");
    expect(["pending", "running", "completed"]).toContain(deployData.action.status);
  });

  test("respond with rejection follows fail edge", async () => {
    server.db.insertAction(createAction({
      id: "review",
      type: "command",
      status: "waiting",
      output: { status: "waiting", summary: "awaiting" },
    }));
    server.db.insertAction(createAction({
      id: "fix",
      status: "inactive",
    }));
    server.db.insertEdge(createEdge("review", "fix", "fail"));

    const { status, body } = await post("/actions/review/respond", {
      status: "rejected",
      summary: "Needs work",
    });

    expect(status).toBe(200);
    expect(body.condition).toBe("fail");

    const { body: fixData } = await get("/actions/fix");
    expect(["pending", "running", "completed"]).toContain(fixData.action.status);
  });

  test("respond returns 400 for non-waiting action", async () => {
    server.db.insertAction(createAction({
      id: "running-action",
      status: "running",
    }));

    const { status, body } = await post("/actions/running-action/respond", {
      status: "approved",
      summary: "test",
    });

    expect(status).toBe(400);
    expect(body.error).toContain("not waiting");
  });
});
