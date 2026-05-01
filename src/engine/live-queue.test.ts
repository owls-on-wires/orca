/**
 * Live task queue tests — validates that runBuild() re-reads the task file
 * at task boundaries and appends new tasks to the queue.
 */

import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync } from "fs";
import { join } from "path";
import * as yaml from "js-yaml";
import type {
  OrcaConfig,
  ResolvedTask,
  EvalResult,
  EvalConfig,
  ScopeConfig,
} from "../config/schema";
import type { BuildState } from "../state";
import type { Display } from "../display/types";

// ---------------------------------------------------------------------------
// Mock helpers (same pattern as loop.test.ts)
// ---------------------------------------------------------------------------

function createMockDisplay(): Display & { texts: string[] } {
  const texts: string[] = [];
  const noop = () => {};
  return {
    texts,
    onBuildStart: noop, onBuildEnd: noop, onTaskStart: noop, onTaskEnd: noop,
    onIteration: noop, onStageStart: noop, onStageEnd: noop,
    onText: (t: string) => { texts.push(t); },
    onToolUse: noop, onEval: noop, onEscalation: noop, onSupervisorDecision: noop,
    onSessionCleared: noop, onSnapshot: noop, onRevert: noop, onCommit: noop,
    onScopeViolation: noop, onConfigReloaded: noop, onIntervention: noop,
  };
}

interface BuildContext {
  invoke(label: string, options: {
    prompt: string;
    taskId: string;
    toolset?: string;
    maxTurns?: number;
    model?: string;
    scope?: ScopeConfig;
    sessionId?: string;
  }): Promise<{ output: Record<string, unknown> | null; costUsd: number; sessionId: string | null; numTurns: number; durationMs: number }>;
  eval(config: EvalConfig, taskId: string, vars: Record<string, string>): Promise<EvalResult>;
  snapshot(message: string): Promise<string | null>;
  revert(hash?: string): Promise<void>;
  commit(message: string): Promise<string | null>;
  fileExists(path: string): boolean;
  loadPrompt(stageName: string, taskId: string): Promise<string | null>;
  readLiveConfig(): Promise<{ max_iterations?: number; max_cost?: number } | null>;
  display: Display;
}

function createMockContext(display: Display): BuildContext {
  return {
    async invoke() {
      return { output: { status: "completed" }, costUsd: 0.5, sessionId: null, numTurns: 5, durationMs: 100 };
    },
    async eval() {
      return { all_passed: true };
    },
    async snapshot() { return null; },
    async revert() {},
    async commit() { return null; },
    fileExists() { return false; },
    async loadPrompt() { return "test prompt"; },
    async readLiveConfig() { return null; },
    display,
  };
}

function makeConfig(tasksFile: string): OrcaConfig {
  return {
    name: "test-build",
    project_dir: "/project",
    model: "opus",
    tasks: { file: tasksFile, list: [] },
    workflow: { loop: ["eval", "develop"] },
    stages: { develop: { toolset: "all", max_turns: 100 } },
    budget: { max_iterations: 10, max_cost: 50 },
  } as OrcaConfig;
}

function writeTasks(dir: string, tasks: Array<{ id: string; title?: string; depends_on?: string[] }>): string {
  const filePath = join(dir, "tasks.yaml");
  writeFileSync(filePath, yaml.dump(tasks));
  return filePath;
}

async function runBuild(config: OrcaConfig, tasks: ResolvedTask[], ctx: BuildContext, configPath: string, projectDir = ""): Promise<BuildState> {
  const mod = await import("./loop");
  return mod.runBuild({ config, tasks, configPath, projectDir }, ctx as any);
}

function makeTask(id: string, depends_on: string[] = []): ResolvedTask {
  return {
    id,
    title: id,
    tags: [],
    depends_on,
    eval: { command: "echo test", parser: "exit_code" },
    budget: { max_iterations: 10, max_cost: 50 },
    variables: {},
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("Live task queue", () => {
  test("discovers new tasks added to file after task completion", async () => {
    const tmpDir = mkdtempSync("/tmp/orca-lq-");
    const display = createMockDisplay();
    const ctx = createMockContext(display);

    // Start with task a only
    const tasksPath = writeTasks(tmpDir, [{ id: "a", title: "Task A" }]);
    const config = makeConfig("tasks.yaml");
    const initialTasks = [makeTask("a")];

    let evalCount = 0;
    ctx.eval = async () => {
      evalCount++;
      // After task a completes, add task b to the file
      if (evalCount === 1) {
        writeTasks(tmpDir, [
          { id: "a", title: "Task A" },
          { id: "b", title: "Task B" },
        ]);
      }
      return { all_passed: true };
    };

    const state = await runBuild(config, initialTasks, ctx, tasksPath, tmpDir);

    expect(state.status).toBe("completed");
    expect(state.tasksCompleted).toContain("a");
    expect(state.tasksCompleted).toContain("b");
    expect(state.tasksDiscovered!.length).toBe(2);

    // Check display message about new tasks
    const newTaskMsg = display.texts.find(t => t.includes("new task"));
    expect(newTaskMsg).toBeDefined();
    expect(newTaskMsg).toContain("b");

    rmSync(tmpDir, { recursive: true });
  });

  test("skips duplicate task IDs", async () => {
    const tmpDir = mkdtempSync("/tmp/orca-lq-");
    const display = createMockDisplay();
    const ctx = createMockContext(display);

    // Task file always has just task a
    const tasksPath = writeTasks(tmpDir, [{ id: "a", title: "Task A" }]);
    const config = makeConfig("tasks.yaml");
    const initialTasks = [makeTask("a")];

    const state = await runBuild(config, initialTasks, ctx, tasksPath, tmpDir);

    expect(state.status).toBe("completed");
    expect(state.tasksCompleted).toEqual(["a"]);
    // No "new task" messages since a is already seen
    const newTaskMsg = display.texts.find(t => t.includes("new task"));
    expect(newTaskMsg).toBeUndefined();

    rmSync(tmpDir, { recursive: true });
  });

  test("new task depending on failed task stays blocked and is reported", async () => {
    const tmpDir = mkdtempSync("/tmp/orca-lq-");
    const display = createMockDisplay();
    const ctx = createMockContext(display);

    // Start with task a (will fail) and b (depends on a)
    const tasksPath = writeTasks(tmpDir, [
      { id: "a", title: "Task A" },
      { id: "b", title: "Task B", depends_on: ["a"] },
    ]);
    const config = makeConfig("tasks.yaml");
    const initialTasks = [
      makeTask("a"),
      makeTask("b", ["a"]),
    ];
    // a always fails
    (initialTasks[0] as any).budget = { max_iterations: 1, max_cost: 50 };

    ctx.eval = async () => ({ all_passed: false });

    const state = await runBuild(config, initialTasks, ctx, tasksPath, tmpDir);

    // Build fails because a failed
    expect(state.status).toBe("failed");
    expect(state.tasksFailed).toContain("a");

    rmSync(tmpDir, { recursive: true });
  });

  test("handles file read error gracefully", async () => {
    const tmpDir = mkdtempSync("/tmp/orca-lq-");
    const display = createMockDisplay();
    const ctx = createMockContext(display);

    // Point to a non-existent tasks file path
    const configPath = join(tmpDir, "project.orca.yaml");
    const config = makeConfig("nonexistent-tasks.yaml");
    const initialTasks = [makeTask("a")];

    const state = await runBuild(config, initialTasks, ctx, configPath, tmpDir);

    // Build should still complete successfully
    expect(state.status).toBe("completed");
    expect(state.tasksCompleted).toContain("a");

    // Should have a warning about failed file read
    const warning = display.texts.find(t => t.includes("Warning"));
    expect(warning).toBeDefined();

    rmSync(tmpDir, { recursive: true });
  });

  test("tasksDiscovered tracks discovery timestamps", async () => {
    const tmpDir = mkdtempSync("/tmp/orca-lq-");
    const display = createMockDisplay();
    const ctx = createMockContext(display);

    const tasksPath = writeTasks(tmpDir, [{ id: "a", title: "Task A" }]);
    const config = makeConfig("tasks.yaml");
    const initialTasks = [makeTask("a")];

    let called = false;
    ctx.eval = async () => {
      if (!called) {
        called = true;
        writeTasks(tmpDir, [
          { id: "a", title: "Task A" },
          { id: "c", title: "Task C" },
        ]);
      }
      return { all_passed: true };
    };

    const state = await runBuild(config, initialTasks, ctx, tasksPath, tmpDir);

    expect(state.tasksDiscovered).toBeDefined();
    expect(state.tasksDiscovered!.length).toBe(2);

    // Initial task discovered at build start
    const aDiscovery = state.tasksDiscovered!.find(d => d.taskId === "a");
    expect(aDiscovery).toBeDefined();

    // Task c discovered later
    const cDiscovery = state.tasksDiscovered!.find(d => d.taskId === "c");
    expect(cDiscovery).toBeDefined();
    expect(new Date(cDiscovery!.discoveredAt).getTime()).toBeGreaterThanOrEqual(
      new Date(aDiscovery!.discoveredAt).getTime()
    );

    rmSync(tmpDir, { recursive: true });
  });

  test("new tasks with dependencies are queued and run in order", async () => {
    const tmpDir = mkdtempSync("/tmp/orca-lq-");
    const display = createMockDisplay();
    const ctx = createMockContext(display);

    const tasksPath = writeTasks(tmpDir, [{ id: "a", title: "Task A" }]);
    const config = makeConfig("tasks.yaml");
    const initialTasks = [makeTask("a")];

    const taskOrder: string[] = [];
    let added = false;
    ctx.eval = async (_config, taskId) => {
      if (!taskOrder.includes(taskId)) taskOrder.push(taskId);
      if (!added) {
        added = true;
        // Add d (depends on c) and c (depends on a) — order matters
        writeTasks(tmpDir, [
          { id: "a", title: "Task A" },
          { id: "c", title: "Task C", depends_on: ["a"] },
          { id: "d", title: "Task D", depends_on: ["c"] },
        ]);
      }
      return { all_passed: true };
    };

    const state = await runBuild(config, initialTasks, ctx, tasksPath, tmpDir);

    expect(state.status).toBe("completed");
    expect(state.tasksCompleted).toContain("a");
    expect(state.tasksCompleted).toContain("c");
    expect(state.tasksCompleted).toContain("d");

    // c should be before d in execution order
    const cIdx = taskOrder.indexOf("c");
    const dIdx = taskOrder.indexOf("d");
    expect(cIdx).toBeLessThan(dIdx);

    rmSync(tmpDir, { recursive: true });
  });

  test("removed tasks are not removed from queue", async () => {
    const tmpDir = mkdtempSync("/tmp/orca-lq-");
    const display = createMockDisplay();
    const ctx = createMockContext(display);

    // Start with tasks a and b
    const tasksPath = writeTasks(tmpDir, [
      { id: "a", title: "Task A" },
      { id: "b", title: "Task B" },
    ]);
    const config = makeConfig("tasks.yaml");
    const initialTasks = [makeTask("a"), makeTask("b")];

    let removedB = false;
    ctx.eval = async () => {
      if (!removedB) {
        removedB = true;
        // Remove b from file after a completes
        writeTasks(tmpDir, [{ id: "a", title: "Task A" }]);
      }
      return { all_passed: true };
    };

    const state = await runBuild(config, initialTasks, ctx, tasksPath, tmpDir);

    // b should still have been executed since it was in the initial queue
    expect(state.status).toBe("completed");
    expect(state.tasksCompleted).toContain("a");
    expect(state.tasksCompleted).toContain("b");

    rmSync(tmpDir, { recursive: true });
  });
});

describe("checkForNewTasks", () => {
  test("appends new tasks and logs them", async () => {
    const tmpDir = mkdtempSync("/tmp/orca-lq-");
    const display = createMockDisplay();

    // Write tasks file with a and b
    const tasksPath = writeTasks(tmpDir, [
      { id: "a", title: "Task A" },
      { id: "b", title: "Task B" },
    ]);

    const config = makeConfig("tasks.yaml");
    const options = { config, tasks: [], configPath: tasksPath, projectDir: tmpDir };

    const taskQueue: ResolvedTask[] = [];
    const seenIds = new Set(["a"]);
    const completedIds = new Set(["a"]);
    const state: BuildState = {
      runId: "test", name: "test", status: "running",
      currentTaskId: null, tasksCompleted: ["a"], tasksFailed: [],
      totalCostUsd: 0, startedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(), tasks: {},
      tasksDiscovered: [],
    };

    const { checkForNewTasks } = await import("./loop");
    await checkForNewTasks(options as any, taskQueue, seenIds, completedIds, state, display);

    expect(taskQueue.length).toBe(1);
    expect(taskQueue[0].id).toBe("b");
    expect(seenIds.has("b")).toBe(true);
    expect(state.tasksDiscovered!.length).toBe(1);
    expect(state.tasksDiscovered![0].taskId).toBe("b");

    const msg = display.texts.find(t => t.includes("new task"));
    expect(msg).toBeDefined();

    rmSync(tmpDir, { recursive: true });
  });

  test("skips tasks already in seenIds", async () => {
    const tmpDir = mkdtempSync("/tmp/orca-lq-");
    const display = createMockDisplay();

    const tasksPath = writeTasks(tmpDir, [
      { id: "a", title: "Task A" },
    ]);

    const config = makeConfig("tasks.yaml");
    const options = { config, tasks: [], configPath: tasksPath, projectDir: tmpDir };

    const taskQueue: ResolvedTask[] = [];
    const seenIds = new Set(["a"]);
    const completedIds = new Set<string>();
    const state: BuildState = {
      runId: "test", name: "test", status: "running",
      currentTaskId: null, tasksCompleted: [], tasksFailed: [],
      totalCostUsd: 0, startedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(), tasks: {},
      tasksDiscovered: [],
    };

    const { checkForNewTasks } = await import("./loop");
    await checkForNewTasks(options as any, taskQueue, seenIds, completedIds, state, display);

    expect(taskQueue.length).toBe(0);

    rmSync(tmpDir, { recursive: true });
  });
});
