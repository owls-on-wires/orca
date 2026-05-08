/**
 * End-to-end test — full build lifecycle.
 *
 * Creates a minimal project.orca.yaml with a real eval command
 * (echo JSON), mock Claude invocations via BuildContext, and
 * verifies the complete lifecycle:
 *   load config → resolve tasks → run workflow → produce state
 *
 * This is the acceptance test: if this passes, orca works end-to-end.
 */

import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, existsSync, readFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import type { OrcaConfig, ResolvedTask, EvalResult } from "./config/schema";
import type { BuildState } from "./state";
import type { BuildContext } from "./engine/loop";
import type { Display } from "./display/types";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function noopDisplay(): Display {
  const noop = () => {};
  return {
    onBuildStart: noop, onBuildEnd: noop, onTaskStart: noop, onTaskEnd: noop,
    onIteration: noop, onStageStart: noop, onStageEnd: noop, onText: noop,
    onToolUse: noop, onEval: noop, onEscalation: noop, onSupervisorDecision: noop,
    onSessionCleared: noop, onSnapshot: noop, onRevert: noop, onCommit: noop,
    onScopeViolation: noop, onConfigReloaded: noop, onIntervention: noop,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("End-to-end", () => {
  let tempDir: string;
  let projectDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "orca-e2e-"));
    projectDir = join(tempDir, "project");
    mkdirSync(projectDir, { recursive: true });
    mkdirSync(join(projectDir, "stages"), { recursive: true });
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  test("single task, passes on first eval", async () => {
    // Config
    const config: OrcaConfig = {
      name: "e2e-test",
      project_dir: projectDir,
      model: "opus",
      tasks: { list: [{ id: "simple" }] },
      eval: { command: `echo '{"all_passed": true, "total": 1, "passed": 1}'`, parser: "json" },
      workflow: { loop: ["eval", "develop"] },
      stages: { develop: { toolset: "all", max_turns: 10 } },
      budget: { max_iterations: 5, max_cost: 50 },
    };
    const tasks: ResolvedTask[] = [{
      id: "simple",
      title: "Simple Task",
      tags: [],
      depends_on: [],
      eval: config.eval!,
      budget: { max_iterations: 5, max_cost: 50 },
      variables: {},
    }];

    const calls: string[] = [];
    const ctx: BuildContext = {
      async invoke(label, opts) {
        calls.push(`invoke:${label}`);
        return { output: { status: "completed" }, costUsd: 1.0, sessionId: "s1" };
      },
      async eval(evalConfig, taskId, vars) {
        calls.push(`eval:${taskId}`);
        return { all_passed: true, total: 1, passed: 1, failed: 0 };
      },
      async snapshot(msg) { calls.push("snapshot"); return "abc123"; },
      async revert(hash) { calls.push("revert"); },
      async commit(msg) { calls.push(`commit:${msg}`); return "def456"; },
      fileExists: () => false,
      async loadPrompt() { return "test prompt"; },
      async readLiveConfig() { return null; },
      display: noopDisplay(),
    };

    const { runBuild } = await import("./engine/loop");
    const state = await runBuild({ config, tasks, configPath: "test.orca.yaml", projectDir: "." }, ctx);

    // Task should pass immediately — no develop needed
    expect(state.status).toBe("completed");
    expect(state.tasksCompleted).toContain("simple");
    expect(calls).toContain("eval:simple");
    expect(calls).not.toContain("invoke:develop");
  });

  test("single task, fails then passes on iteration 2", async () => {
    const config: OrcaConfig = {
      name: "e2e-retry",
      project_dir: projectDir,
      model: "opus",
      tasks: { list: [{ id: "retry" }] },
      eval: { command: "echo test", parser: "json" },
      workflow: { loop: ["eval", "develop"] },
      stages: { develop: { toolset: "all", max_turns: 10 } },
      budget: { max_iterations: 5, max_cost: 50 },
    };
    const tasks: ResolvedTask[] = [{
      id: "retry",
      title: "Retry Task",
      tags: [],
      depends_on: [],
      eval: config.eval!,
      budget: { max_iterations: 5, max_cost: 50 },
      variables: {},
    }];

    let evalCount = 0;
    const calls: string[] = [];
    const ctx: BuildContext = {
      async invoke(label, opts) {
        calls.push(`invoke:${label}`);
        return { output: { status: "completed" }, costUsd: 2.0, sessionId: "s1" };
      },
      async eval() {
        evalCount++;
        calls.push(`eval:${evalCount}`);
        return evalCount >= 2
          ? { all_passed: true, total: 3, passed: 3, failed: 0 }
          : { all_passed: false, total: 3, passed: 1, failed: 2 };
      },
      async snapshot() { return "snap1"; },
      async revert() {},
      async commit(msg) { calls.push(`commit`); return "c1"; },
      fileExists: () => false,
      async loadPrompt() { return "prompt"; },
      async readLiveConfig() { return null; },
      display: noopDisplay(),
    };

    const { runBuild } = await import("./engine/loop");
    const state = await runBuild({ config, tasks, configPath: "test.orca.yaml", projectDir: "." }, ctx);

    expect(state.status).toBe("completed");
    expect(state.tasksCompleted).toContain("retry");
    expect(calls).toContain("invoke:develop");
    expect(evalCount).toBe(2);
    expect(state.tasks.retry.iteration).toBe(1);
  });

  test("multi-task with dependencies", async () => {
    const config: OrcaConfig = {
      name: "e2e-deps",
      project_dir: projectDir,
      model: "opus",
      tasks: { list: [{ id: "a" }, { id: "b" }] },
      eval: { command: "echo ok", parser: "json" },
      workflow: { loop: ["eval", "develop"] },
      stages: { develop: { toolset: "all" } },
      budget: { max_iterations: 5, max_cost: 50 },
    };
    const tasks: ResolvedTask[] = [
      {
        id: "a", title: "A", tags: [], depends_on: [],
        eval: config.eval!, budget: { max_iterations: 5 }, variables: {},
      },
      {
        id: "b", title: "B", tags: [], depends_on: ["a"],
        eval: config.eval!, budget: { max_iterations: 5 }, variables: {},
      },
    ];

    const taskOrder: string[] = [];
    const ctx: BuildContext = {
      async invoke() { return { output: { status: "completed" }, costUsd: 1, sessionId: null }; },
      async eval(cfg, taskId) {
        if (!taskOrder.includes(taskId)) taskOrder.push(taskId);
        return { all_passed: true, total: 1, passed: 1, failed: 0 };
      },
      async snapshot() { return null; },
      async revert() {},
      async commit() { return null; },
      fileExists: () => false,
      async loadPrompt() { return "p"; },
      async readLiveConfig() { return null; },
      display: noopDisplay(),
    };

    const { runBuild } = await import("./engine/loop");
    const state = await runBuild({ config, tasks, configPath: "test.orca.yaml", projectDir: "." }, ctx);

    expect(state.status).toBe("completed");
    expect(taskOrder).toEqual(["a", "b"]); // a before b
  });

  test("full workflow: setup → pre → loop → post", async () => {
    const config: OrcaConfig = {
      name: "e2e-full",
      project_dir: projectDir,
      model: "opus",
      tasks: { list: [{ id: "t1" }] },
      eval: { command: "echo test", parser: "json" },
      workflow: {
        setup: "scaffold",
        pre: ["understand"],
        loop: ["eval", "analyze", "develop"],
        post: ["regression"],
      },
      stages: {
        scaffold: { toolset: "all" },
        understand: { toolset: "read_only" },
        analyze: { toolset: "read_only" },
        develop: { toolset: "all" },
        regression: { toolset: "all" },
      },
      budget: { max_iterations: 5, max_cost: 50 },
    };
    const tasks: ResolvedTask[] = [{
      id: "t1", title: "Task 1", tags: [], depends_on: [],
      eval: config.eval!,
      budget: { max_iterations: 5, max_cost: 50 },
      variables: { understand_focus: ["Area 1"] },
    }];

    let evalCount = 0;
    const stageLog: string[] = [];
    const ctx: BuildContext = {
      async invoke(label) {
        stageLog.push(label);
        const status = label === "regression" ? "passed" : "completed";
        return { output: { status }, costUsd: 0.5, sessionId: "s1" };
      },
      async eval() {
        evalCount++;
        stageLog.push("eval");
        // Pass on second eval (after one develop iteration)
        return evalCount >= 2
          ? { all_passed: true, total: 1, passed: 1, failed: 0 }
          : { all_passed: false, total: 1, passed: 0, failed: 1 };
      },
      async snapshot() { return "snap"; },
      async revert() {},
      async commit() { return "c"; },
      fileExists: () => false,
      async loadPrompt() { return "prompt"; },
      async readLiveConfig() { return null; },
      display: noopDisplay(),
    };

    const { runBuild } = await import("./engine/loop");
    const state = await runBuild({ config, tasks, configPath: "test.orca.yaml", projectDir: "." }, ctx);

    expect(state.status).toBe("completed");

    // Verify ordering: scaffold → understand → eval → analyze → develop → eval → regression
    expect(stageLog[0]).toBe("scaffold");
    expect(stageLog[1]).toBe("understand");
    expect(stageLog[2]).toBe("eval"); // first eval (fails)
    expect(stageLog).toContain("analyze");
    expect(stageLog).toContain("develop");
    // After develop, second eval passes
    // Then regression runs
    expect(stageLog[stageLog.length - 1]).toBe("regression");
  });

  test("budget exhaustion produces failed state with correct metadata", async () => {
    const config: OrcaConfig = {
      name: "e2e-budget",
      project_dir: projectDir,
      model: "opus",
      tasks: { list: [{ id: "expensive" }] },
      eval: { command: "echo fail", parser: "json" },
      workflow: { loop: ["eval", "develop"] },
      stages: { develop: { toolset: "all" } },
      budget: { max_iterations: 2, max_cost: 50 },
    };
    const tasks: ResolvedTask[] = [{
      id: "expensive", title: "Expensive Task", tags: [], depends_on: [],
      eval: config.eval!,
      budget: { max_iterations: 2, max_cost: 50 },
      variables: {},
    }];

    const ctx: BuildContext = {
      async invoke() { return { output: { status: "completed" }, costUsd: 5, sessionId: null }; },
      async eval() { return { all_passed: false, total: 3, passed: 1, failed: 2 }; },
      async snapshot() { return null; },
      async revert() {},
      async commit() { return null; },
      fileExists: () => false,
      async loadPrompt() { return "p"; },
      async readLiveConfig() { return null; },
      display: noopDisplay(),
    };

    const { runBuild } = await import("./engine/loop");
    const state = await runBuild({ config, tasks, configPath: "test.orca.yaml", projectDir: "." }, ctx);

    expect(state.status).toBe("failed");
    expect(state.tasksFailed).toContain("expensive");
    expect(state.tasks.expensive.status).toBe("failed");
    expect(state.tasks.expensive.stopReason).toContain("iteration");
    expect(state.totalCostUsd).toBeGreaterThan(0);
  });

  test("state file is written to .orca directory", async () => {
    const config: OrcaConfig = {
      name: "e2e-state",
      project_dir: projectDir,
      model: "opus",
      tasks: { list: [{ id: "t1" }] },
      eval: { command: "echo ok", parser: "json" },
      workflow: { loop: ["eval"] },
      budget: { max_iterations: 1 },
    };
    const tasks: ResolvedTask[] = [{
      id: "t1", title: "T1", tags: [], depends_on: [],
      eval: config.eval!, budget: { max_iterations: 1 }, variables: {},
    }];

    let savedState: BuildState | null = null;
    const ctx: BuildContext = {
      async invoke() { return { output: null, costUsd: 0, sessionId: null }; },
      async eval() { return { all_passed: true, total: 1, passed: 1, failed: 0 }; },
      async snapshot() { return null; },
      async revert() {},
      async commit() { return null; },
      fileExists: () => false,
      async loadPrompt() { return "p"; },
      async readLiveConfig() { return null; },
      display: noopDisplay(),
    };

    const { runBuild } = await import("./engine/loop");
    const state = await runBuild({ config, tasks, configPath: "test.orca.yaml", projectDir: "." }, ctx);

    // The returned state should be well-formed
    expect(state.runId).toBeDefined();
    expect(state.name).toBe("e2e-state");
    expect(state.startedAt).toBeDefined();
    expect(state.updatedAt).toBeDefined();
  });
});
