import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { OrcaDatabase } from "./db";
import { expandConfig } from "./config";
import { Executor, type RunActionFn } from "./executor";
import { startServer } from "./server";
import type { ActionResult, WaitingResult } from "./action-runner";
import { mkdtempSync, writeFileSync, readFileSync, unlinkSync, existsSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

// ---------------------------------------------------------------------------
// 1. Full lifecycle via CLI
// ---------------------------------------------------------------------------

describe("e2e: full lifecycle", () => {
  let db: OrcaDatabase;

  beforeEach(() => {
    db = new OrcaDatabase(":memory:");
  });

  afterEach(() => {
    db.close();
  });

  test("two tasks with dependency run in correct order", async () => {
    const yaml = `
name: e2e-lifecycle
defaults:
  types:
    cmd-a:
      type: command
      params:
        command: "echo action-a"
      edges:
        pass: next
    cmd-b:
      type: command
      params:
        command: "echo action-b"
      edges:
        pass: next
    cmd-c:
      type: command
      params:
        command: "echo action-c"
      edges:
        pass: complete
tasks:
  - id: task1
    prompt: "task 1"
    actions: [cmd-a, cmd-b]
  - id: task2
    prompt: "task 2"
    actions: [cmd-c]
    depends_on: [task1]
`;

    expandConfig(yaml, db);

    // Verify actions created
    const actions = db.listActions();
    expect(actions).toHaveLength(3);
    expect(actions.map((a) => a.id).sort()).toEqual([
      "task1.cmd-a",
      "task1.cmd-b",
      "task2.cmd-c",
    ]);

    // task1.cmd-a should be pending, others inactive
    expect(db.getAction("task1.cmd-a")!.status).toBe("pending");
    expect(db.getAction("task1.cmd-b")!.status).toBe("inactive");
    expect(db.getAction("task2.cmd-c")!.status).toBe("inactive");

    // Track execution order
    const order: string[] = [];
    const edgesTraversed: string[] = [];

    const executor = new Executor(db, {
      projectDir: "/tmp",
      runActionFn: async (action) => {
        order.push(action.id);
        return {
          condition: "pass",
          output: { status: "passed", summary: `${action.id} done` },
          cost_usd: 0,
          duration_ms: 10,
          num_turns: 0,
        };
      },
      onEdgeTraversed: (from, to, condition) => {
        edgesTraversed.push(`${from}->${to}[${condition}]`);
      },
    });

    await executor.run();

    // All 3 actions completed in order
    expect(order).toEqual(["task1.cmd-a", "task1.cmd-b", "task2.cmd-c"]);

    // Edges were traversed
    expect(edgesTraversed).toContain("task1.cmd-a->task1.cmd-b[pass]");
    expect(edgesTraversed).toContain("task1.cmd-b->task2.cmd-c[pass]");

    // All completed
    for (const id of ["task1.cmd-a", "task1.cmd-b", "task2.cmd-c"]) {
      expect(db.getAction(id)!.status).toBe("completed");
    }
  });
});

// ---------------------------------------------------------------------------
// 2. Retry loop
// ---------------------------------------------------------------------------

describe("e2e: retry loop", () => {
  let db: OrcaDatabase;

  beforeEach(() => {
    db = new OrcaDatabase(":memory:");
  });

  afterEach(() => {
    db.close();
  });

  test("eval fails twice then passes on third iteration", async () => {
    const yaml = `
name: e2e-retry
defaults:
  types:
    develop-cmd:
      type: command
      params:
        command: "echo developing"
      edges:
        pass: eval-cmd
    eval-cmd:
      type: command
      params:
        command: "echo evaluating"
      edges:
        pass: complete
        fail: develop-cmd
tasks:
  - id: task1
    prompt: "retry test"
    actions: [develop-cmd, eval-cmd]
`;

    expandConfig(yaml, db);

    let evalCallCount = 0;
    const runOrder: string[] = [];

    const executor = new Executor(db, {
      projectDir: "/tmp",
      runActionFn: async (action) => {
        runOrder.push(action.id);

        if (action.id === "task1.eval-cmd") {
          evalCallCount++;
          if (evalCallCount < 3) {
            return {
              condition: "fail" as const,
              output: { status: "failed", summary: `eval fail ${evalCallCount}` },
              cost_usd: 0,
              duration_ms: 10,
              num_turns: 0,
            };
          }
        }

        return {
          condition: "pass" as const,
          output: { status: "passed", summary: `${action.id} passed` },
          cost_usd: 0,
          duration_ms: 10,
          num_turns: 0,
        };
      },
    });

    await executor.run();

    // eval-cmd called 3 times (fail, fail, pass)
    expect(evalCallCount).toBe(3);

    // develop-cmd called 3 times (initial + 2 retries)
    const developCalls = runOrder.filter((id) => id === "task1.develop-cmd");
    expect(developCalls).toHaveLength(3);

    // Final state: both completed
    expect(db.getAction("task1.develop-cmd")!.status).toBe("completed");
    expect(db.getAction("task1.eval-cmd")!.status).toBe("completed");

    // Iteration counts reflect retries
    expect(db.getAction("task1.develop-cmd")!.iteration).toBe(2);
    expect(db.getAction("task1.eval-cmd")!.iteration).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// 3. Server API
// ---------------------------------------------------------------------------

describe("e2e: server API", () => {
  let serverHandle: ReturnType<typeof startServer>;
  let baseUrl: string;

  beforeEach(() => {
    serverHandle = startServer({ port: 0, dbPath: ":memory:", noExecutor: true });
    baseUrl = `http://localhost:${serverHandle.server.port}`;
  });

  afterEach(() => {
    clearInterval(serverHandle.heartbeatInterval);
    serverHandle.server.stop();
    serverHandle.db.close();
  });

  test("import, list, pause, resume, and complete", async () => {
    const config = {
      name: "e2e-server",
      defaults: {
        types: {
          "cmd-a": {
            type: "command",
            params: { command: "echo hello" },
            edges: { pass: "complete" },
          },
        },
      },
      tasks: [{ id: "task1", prompt: "server test", actions: ["cmd-a"] }],
    };

    // POST /import
    const importRes = await fetch(`${baseUrl}/import`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ config }),
    });
    expect(importRes.status).toBe(200);
    const importData = await importRes.json();
    expect(importData.actions).toContain("task1.cmd-a");

    // GET /actions
    const listRes = await fetch(`${baseUrl}/actions`);
    expect(listRes.status).toBe(200);
    const actions = await listRes.json();
    expect(actions).toHaveLength(1);
    expect(actions[0].id).toBe("task1.cmd-a");
    expect(actions[0].status).toBe("pending");

    // Create executor manually for pause/resume test
    const executor = new Executor(serverHandle.db, {
      projectDir: "/tmp",
      runActionFn: async (action) => ({
        condition: "pass" as const,
        output: { status: "passed", summary: "done" },
        cost_usd: 0,
        duration_ms: 10,
        num_turns: 0,
      }),
    });
    serverHandle.state.executor = executor;

    // POST /executor/pause
    const pauseRes = await fetch(`${baseUrl}/executor/pause`, { method: "POST" });
    expect(pauseRes.status).toBe(200);
    const pauseData = await pauseRes.json();
    expect(pauseData.state).toBe("paused");
    expect(executor.isPaused()).toBe(true);

    // POST /executor/resume
    const resumeRes = await fetch(`${baseUrl}/executor/resume`, { method: "POST" });
    expect(resumeRes.status).toBe(200);
    const resumeData = await resumeRes.json();
    expect(resumeData.state).toBe("running");

    // Wait for executor to finish
    await new Promise((r) => setTimeout(r, 100));

    // GET /actions — should be completed
    const finalRes = await fetch(`${baseUrl}/actions`);
    const finalActions = await finalRes.json();
    expect(finalActions[0].status).toBe("completed");
  });
});

// ---------------------------------------------------------------------------
// 4. Human action
// ---------------------------------------------------------------------------

describe("e2e: human action", () => {
  let serverHandle: ReturnType<typeof startServer>;
  let baseUrl: string;

  beforeEach(() => {
    serverHandle = startServer({ port: 0, dbPath: ":memory:", noExecutor: true });
    baseUrl = `http://localhost:${serverHandle.server.port}`;
  });

  afterEach(() => {
    clearInterval(serverHandle.heartbeatInterval);
    serverHandle.server.stop();
    serverHandle.db.close();
  });

  test("notify action enters waiting, then completes on respond", async () => {
    const config = {
      name: "e2e-human",
      defaults: {
        types: {
          "cmd-a": {
            type: "command",
            params: { command: "echo cmd-a-done" },
            edges: { pass: "notify" },
          },
          notify: {
            type: "command",
            params: { command: "echo notified", wait_for_response: true },
            edges: { pass: "complete" },
          },
        },
      },
      tasks: [{ id: "task1", prompt: "human test", actions: ["cmd-a", "notify"] }],
    };

    // Import
    await fetch(`${baseUrl}/import`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ config }),
    });

    // Create and start executor — it will run cmd-a, then notify will enter waiting
    const waitingPromise = new Promise<void>((resolve) => {
      const executor = new Executor(serverHandle.db, {
        projectDir: "/tmp",
        onActionWaiting: () => resolve(),
      });
      serverHandle.state.executor = executor;
      executor.run();
    });

    await waitingPromise;

    // Verify notify is waiting
    const notifyAction = serverHandle.db.getAction("task1.notify")!;
    expect(notifyAction.status).toBe("waiting");

    // cmd-a should be completed
    expect(serverHandle.db.getAction("task1.cmd-a")!.status).toBe("completed");

    // POST /actions/task1.notify/respond
    const respondRes = await fetch(`${baseUrl}/actions/task1.notify/respond`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status: "passed", summary: "Human approved" }),
    });
    expect(respondRes.status).toBe(200);
    const respondData = await respondRes.json();
    expect(respondData.condition).toBe("pass");

    // notify should now be completed
    const final = serverHandle.db.getAction("task1.notify")!;
    expect(final.status).toBe("completed");
  });
});

// ---------------------------------------------------------------------------
// 5. SSE events
// ---------------------------------------------------------------------------

describe("e2e: SSE events", () => {
  let serverHandle: ReturnType<typeof startServer>;
  let baseUrl: string;

  beforeEach(() => {
    serverHandle = startServer({ port: 0, dbPath: ":memory:", noExecutor: true });
    baseUrl = `http://localhost:${serverHandle.server.port}`;
  });

  afterEach(() => {
    clearInterval(serverHandle.heartbeatInterval);
    serverHandle.server.stop();
    serverHandle.db.close();
  });

  test("action_started and action_completed events received", async () => {
    // Connect to SSE
    const events: { event: string; data: unknown }[] = [];
    const sseRes = await fetch(`${baseUrl}/events`);
    const reader = sseRes.body!.getReader();
    const decoder = new TextDecoder();

    // Read initial connected event
    let buffer = "";
    const readChunk = async () => {
      const { value } = await reader.read();
      if (value) buffer += decoder.decode(value, { stream: true });
    };
    await readChunk();

    // Parse SSE events from buffer
    function parseSSE(raw: string): { event: string; data: unknown }[] {
      const results: { event: string; data: unknown }[] = [];
      const blocks = raw.split("\n\n").filter(Boolean);
      for (const block of blocks) {
        const lines = block.split("\n");
        let event = "";
        let data = "";
        for (const line of lines) {
          if (line.startsWith("event: ")) event = line.slice(7);
          if (line.startsWith("data: ")) data = line.slice(6);
        }
        if (event && data) {
          try {
            results.push({ event, data: JSON.parse(data) });
          } catch {}
        }
      }
      return results;
    }

    // Import config
    const config = {
      name: "e2e-sse",
      defaults: {
        types: {
          "cmd-a": {
            type: "command",
            params: { command: "echo sse-test" },
            edges: { pass: "complete" },
          },
        },
      },
      tasks: [{ id: "task1", prompt: "sse test", actions: ["cmd-a"] }],
    };

    await fetch(`${baseUrl}/import`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ config }),
    });

    // Create executor with SSE broadcasting
    const executor = new Executor(serverHandle.db, {
      projectDir: "/tmp",
      runActionFn: async (action) => ({
        condition: "pass" as const,
        output: { status: "passed", summary: "sse-done" },
        cost_usd: 0,
        duration_ms: 10,
        num_turns: 0,
      }),
      onActionStart: (action) => {
        const { broadcast } = require("./server");
        broadcast(serverHandle.state, "action_started", { action_id: action.id, type: action.type }, action.id);
      },
      onActionEnd: (action, result) => {
        const { broadcast } = require("./server");
        broadcast(serverHandle.state, "action_completed", {
          action_id: action.id,
          condition: result.condition,
        }, action.id);
      },
    });
    serverHandle.state.executor = executor;

    // Run executor
    await executor.run();

    // Give SSE time to flush
    await new Promise((r) => setTimeout(r, 50));

    // Read remaining SSE data
    await readChunk().catch(() => {});
    reader.cancel();

    const parsed = parseSSE(buffer);
    const eventTypes = parsed.map((e) => e.event);

    expect(eventTypes).toContain("connected");
    expect(eventTypes).toContain("action_started");
    expect(eventTypes).toContain("action_completed");
  });
});

// ---------------------------------------------------------------------------
// 6. Tag operations
// ---------------------------------------------------------------------------

describe("e2e: tag operations", () => {
  let serverHandle: ReturnType<typeof startServer>;
  let baseUrl: string;

  beforeEach(() => {
    serverHandle = startServer({ port: 0, dbPath: ":memory:", noExecutor: true });
    baseUrl = `http://localhost:${serverHandle.server.port}`;
  });

  afterEach(() => {
    clearInterval(serverHandle.heartbeatInterval);
    serverHandle.server.stop();
    serverHandle.db.close();
  });

  test("auto-tags generated and tag filtering works", async () => {
    const config = {
      name: "e2e-tags",
      defaults: {
        types: {
          "cmd-a": {
            type: "command",
            params: { command: "echo tag-a" },
            edges: { pass: "complete" },
          },
          "cmd-b": {
            type: "command",
            params: { command: "echo tag-b" },
            edges: { pass: "complete" },
          },
        },
      },
      tasks: [
        { id: "task1", prompt: "tag test 1", actions: ["cmd-a", "cmd-b"] },
        { id: "task2", prompt: "tag test 2", actions: ["cmd-a"] },
      ],
    };

    await fetch(`${baseUrl}/import`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ config }),
    });

    // GET /actions?tag=type:cmd-a → should return task1.cmd-a and task2.cmd-a
    const tagRes = await fetch(`${baseUrl}/actions?tag=type:cmd-a`);
    const tagActions = await tagRes.json();
    expect(tagActions).toHaveLength(2);
    const ids = tagActions.map((a: { id: string }) => a.id).sort();
    expect(ids).toEqual(["task1.cmd-a", "task2.cmd-a"]);

    // GET /actions?tag=task:task1 → should return task1.cmd-a and task1.cmd-b
    const task1Res = await fetch(`${baseUrl}/actions?tag=task:task1`);
    const task1Actions = await task1Res.json();
    expect(task1Actions).toHaveLength(2);
    const task1Ids = task1Actions.map((a: { id: string }) => a.id).sort();
    expect(task1Ids).toEqual(["task1.cmd-a", "task1.cmd-b"]);

    // PATCH /actions?tag=task:task1 → bulk update
    const patchRes = await fetch(`${baseUrl}/actions?tag=task:task1`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status: "skipped" }),
    });
    expect(patchRes.status).toBe(200);
    const patchData = await patchRes.json();
    expect(patchData.updated).toBe(2);

    // Verify bulk update worked
    const verifyRes = await fetch(`${baseUrl}/actions?tag=task:task1`);
    const verified = await verifyRes.json();
    for (const a of verified) {
      expect(a.status).toBe("skipped");
    }

    // task2.cmd-a should be unaffected
    const task2Res = await fetch(`${baseUrl}/actions?tag=task:task2`);
    const task2Actions = await task2Res.json();
    expect(task2Actions[0].status).toBe("pending");
  });
});
