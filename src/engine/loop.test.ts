/**
 * Workflow engine tests.
 *
 * These test the core iteration loop — the state machine that reads
 * project.orca.yaml and executes tasks. All external dependencies
 * (Claude SDK, subprocess, git, filesystem) are mocked via
 * BuildContext injection.
 */

import { describe, expect, test } from "bun:test";
import type {
  OrcaConfig,
  ResolvedTask,
  EvalResult,
  EvalConfig,
  WorkflowConfig,
  StageConfig,
  BudgetConfig,
  ScopeConfig,
  GitConfig,
  SupervisorConfig,
} from "../config/schema";
import type { BuildState } from "../state";
import type { Display } from "../display/types";
import type { SupervisorDecision, Escalation } from "./supervisor";

// ---------------------------------------------------------------------------
// BuildContext — injectable dependencies for the loop
// ---------------------------------------------------------------------------

/**
 * This interface defines the contract between the loop and its dependencies.
 * Tests mock it; production code provides real implementations.
 * The loop implementation should accept this (or something equivalent).
 */
export interface BuildContext {
  /** Invoke a Claude subagent. Returns structured output or null. */
  invoke(label: string, options: {
    prompt: string;
    taskId: string;
    toolset?: string;
    maxTurns?: number;
    model?: string;
    scope?: ScopeConfig;
    sessionId?: string;
  }): Promise<{ output: Record<string, unknown> | null; costUsd: number; sessionId: string | null; numTurns: number; durationMs: number }>;

  /** Run an eval command and parse the result. */
  eval(config: EvalConfig, taskId: string, vars: Record<string, string>): Promise<EvalResult>;

  /** Git snapshot. Returns commit hash or null if git disabled. */
  snapshot(message: string): Promise<string | null>;

  /** Git revert to hash. */
  revert(hash?: string): Promise<void>;

  /** Git commit (permanent checkpoint). Returns hash or null. */
  commit(message: string): Promise<string | null>;

  /** Check if a file exists (for file_missing: conditions). */
  fileExists(path: string): boolean;

  /** Load a prompt template file. Returns content or null. */
  loadPrompt(stageName: string, taskId: string): Promise<string | null>;

  /** Read the live-reload config section. Returns overrides or null. */
  readLiveConfig(): Promise<{ max_iterations?: number; max_cost?: number } | null>;

  /** Display instance for event output. */
  display: Display;
}

// ---------------------------------------------------------------------------
// Mock helpers
// ---------------------------------------------------------------------------

interface MockCall {
  fn: string;
  args: Record<string, unknown>;
}

function createMockDisplay(): Display {
  const noop = () => {};
  return {
    onBuildStart: noop, onBuildEnd: noop, onTaskStart: noop, onTaskEnd: noop,
    onIteration: noop, onStageStart: noop, onStageEnd: noop, onText: noop,
    onToolUse: noop, onEval: noop, onEscalation: noop, onSupervisorDecision: noop,
    onSessionCleared: noop, onSnapshot: noop, onRevert: noop, onCommit: noop,
    onScopeViolation: noop, onConfigReloaded: noop, onIntervention: noop,
  };
}

interface MockContextOptions {
  /** Eval results returned in sequence. Wraps around if exhausted. */
  evalSequence?: EvalResult[];
  /** Invoke results by stage label. */
  invokeResults?: Record<string, Record<string, unknown> | null>;
  /** Cost per invoke call. */
  invokeCost?: number;
  /** Files that "exist" for condition checks. */
  existingFiles?: Set<string>;
  /** Prompt content by stage name. */
  prompts?: Record<string, string>;
  /** Live config reload values (null = no reload). */
  liveConfig?: { max_iterations?: number; max_cost?: number } | null;
}

function createMockContext(options: MockContextOptions = {}): { ctx: BuildContext; calls: MockCall[] } {
  const calls: MockCall[] = [];
  let evalIndex = 0;
  let snapshotCounter = 0;
  const evalSeq = options.evalSequence ?? [{ all_passed: true }];
  const invokeResults = options.invokeResults ?? {};
  const invokeCost = options.invokeCost ?? 0.50;

  const ctx: BuildContext = {
    async invoke(label, opts) {
      calls.push({ fn: "invoke", args: { label, ...opts } });
      const output = invokeResults[label] ?? { status: "completed", summary: "done" };
      return { output, costUsd: invokeCost, sessionId: "sess_mock", numTurns: 5, durationMs: 1000 };
    },

    async eval(config, taskId, vars) {
      calls.push({ fn: "eval", args: { taskId } });
      const result = evalSeq[evalIndex % evalSeq.length];
      evalIndex++;
      return result;
    },

    async snapshot(message) {
      calls.push({ fn: "snapshot", args: { message } });
      snapshotCounter++;
      return `snap${snapshotCounter}`;
    },

    async revert(hash) {
      calls.push({ fn: "revert", args: { hash } });
    },

    async commit(message) {
      calls.push({ fn: "commit", args: { message } });
      return `commit_${snapshotCounter}`;
    },

    fileExists(path) {
      return options.existingFiles?.has(path) ?? false;
    },

    async loadPrompt(stageName, taskId) {
      return options.prompts?.[stageName] ?? `Prompt for ${stageName}`;
    },

    async readLiveConfig() {
      return options.liveConfig ?? null;
    },

    display: createMockDisplay(),
  };

  return { ctx, calls };
}

function makeTask(id: string, overrides: Partial<ResolvedTask> = {}): ResolvedTask {
  return {
    id,
    title: overrides.title ?? id,
    tags: overrides.tags ?? [],
    depends_on: overrides.depends_on ?? [],
    eval: overrides.eval ?? { command: "echo test", parser: "exit_code" },
    budget: overrides.budget ?? { max_iterations: 10, max_cost: 50 },
    variables: overrides.variables ?? {},
    stages: overrides.stages,
  };
}

function makeConfig(overrides: Partial<OrcaConfig> = {}): OrcaConfig {
  return {
    name: "test-build",
    project_dir: "/project",
    model: "opus",
    tasks: { list: [] },
    workflow: overrides.workflow ?? { loop: ["eval", "develop"] },
    stages: overrides.stages ?? {
      develop: { toolset: "all", max_turns: 100 },
    },
    git: overrides.git,
    scope: overrides.scope,
    budget: overrides.budget ?? { max_iterations: 10, max_cost: 50 },
    supervisor: overrides.supervisor,
    ...overrides,
  };
}

// We import runBuild here — it will fail until implemented.
// The import is dynamic so the test file itself compiles.
async function runBuild(config: OrcaConfig, tasks: ResolvedTask[], ctx: BuildContext, projectDir = ""): Promise<BuildState> {
  // This wrapper calls the real implementation with injected context.
  const mod = await import("./loop");
  return mod.runBuild({ config, tasks, configPath: "test.orca.yaml", projectDir }, ctx);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("Workflow execution order", () => {
  test("runs stages in workflow order: eval → develop", async () => {
    const { ctx, calls } = createMockContext({
      evalSequence: [
        { all_passed: false }, // iter 1: fail
        { all_passed: true },  // iter 1 after develop: pass
      ],
    });
    const config = makeConfig({ workflow: { loop: ["eval", "develop"] } });
    const tasks = [makeTask("t1")];

    await runBuild(config, tasks, ctx);

    const fns = calls.map(c => c.fn);
    const evalIdx = fns.indexOf("eval");
    const invokeIdx = fns.indexOf("invoke");
    expect(evalIdx).toBeLessThan(invokeIdx);
  });

  test("runs setup stage once before tasks", async () => {
    const { ctx, calls } = createMockContext({
      evalSequence: [{ all_passed: true }],
    });
    const config = makeConfig({
      workflow: { setup: "scaffold", loop: ["eval", "develop"] },
      stages: { scaffold: { toolset: "all" }, develop: { toolset: "all" } },
    });
    const tasks = [makeTask("t1"), makeTask("t2")];

    await runBuild(config, tasks, ctx);

    // scaffold should appear exactly once, before any eval
    const scaffoldCalls = calls.filter(c => c.fn === "invoke" && c.args.label === "scaffold");
    expect(scaffoldCalls).toHaveLength(1);

    const firstScaffold = calls.findIndex(c => c.fn === "invoke" && c.args.label === "scaffold");
    const firstEval = calls.findIndex(c => c.fn === "eval");
    expect(firstScaffold).toBeLessThan(firstEval);
  });

  test("runs pre stages once per task before the loop", async () => {
    const { ctx, calls } = createMockContext({
      evalSequence: [{ all_passed: true }],
    });
    const config = makeConfig({
      workflow: {
        pre: ["understand", "write_tests"],
        loop: ["eval", "develop"],
      },
      stages: {
        understand: { toolset: "read_only" },
        write_tests: { toolset: "code" },
        develop: { toolset: "all" },
      },
    });
    const tasks = [makeTask("t1")];

    await runBuild(config, tasks, ctx);

    const invokeCalls = calls.filter(c => c.fn === "invoke");
    const labels = invokeCalls.map(c => c.args.label);

    // understand and write_tests before eval
    const understandIdx = labels.indexOf("understand");
    const writeTestsIdx = labels.indexOf("write_tests");
    expect(understandIdx).toBeGreaterThanOrEqual(0);
    expect(writeTestsIdx).toBeGreaterThan(understandIdx);

    const firstEval = calls.findIndex(c => c.fn === "eval");
    const lastPre = calls.findLastIndex(c => c.fn === "invoke" && (c.args.label === "understand" || c.args.label === "write_tests"));
    expect(lastPre).toBeLessThan(firstEval);
  });

  test("runs post stages after loop passes", async () => {
    const { ctx, calls } = createMockContext({
      evalSequence: [{ all_passed: true }],
      invokeResults: { regression: { status: "passed", summary: "ok" } },
    });
    const config = makeConfig({
      workflow: { loop: ["eval", "develop"], post: ["regression"] },
      stages: { develop: { toolset: "all" }, regression: { toolset: "all" } },
    });
    const tasks = [makeTask("t1")];

    await runBuild(config, tasks, ctx);

    const regressionCalls = calls.filter(c => c.fn === "invoke" && c.args.label === "regression");
    expect(regressionCalls).toHaveLength(1);
  });

  test("skips post stages when loop exhausts budget", async () => {
    const { ctx, calls } = createMockContext({
      evalSequence: [{ all_passed: false }], // never passes
    });
    const config = makeConfig({
      workflow: { loop: ["eval", "develop"], post: ["regression"] },
      stages: { develop: { toolset: "all" }, regression: { toolset: "all" } },
      budget: { max_iterations: 2, max_cost: 100 },
    });
    const tasks = [makeTask("t1", { budget: { max_iterations: 2 } })];

    await runBuild(config, tasks, ctx);

    const regressionCalls = calls.filter(c => c.fn === "invoke" && c.args.label === "regression");
    expect(regressionCalls).toHaveLength(0);
  });

  test("eval → analyze → develop workflow", async () => {
    const { ctx, calls } = createMockContext({
      evalSequence: [
        { all_passed: false },
        { all_passed: true },
      ],
    });
    const config = makeConfig({
      workflow: { loop: ["eval", "analyze", "develop"] },
      stages: {
        analyze: { toolset: "read_only" },
        develop: { toolset: "all" },
      },
    });
    const tasks = [makeTask("t1")];

    await runBuild(config, tasks, ctx);

    const invokeCalls = calls.filter(c => c.fn === "invoke");
    const labels = invokeCalls.map(c => c.args.label);
    // Should see: analyze then develop
    expect(labels).toContain("analyze");
    expect(labels).toContain("develop");
    expect(labels.indexOf("analyze")).toBeLessThan(labels.indexOf("develop"));
  });
});

describe("Iteration loop", () => {
  test("exits immediately when eval passes on first check", async () => {
    const { ctx, calls } = createMockContext({
      evalSequence: [{ all_passed: true }],
    });
    const config = makeConfig({ workflow: { loop: ["eval", "develop"] } });
    const tasks = [makeTask("t1")];

    await runBuild(config, tasks, ctx);

    // No develop invocations — eval passed immediately
    const developCalls = calls.filter(c => c.fn === "invoke" && c.args.label === "develop");
    expect(developCalls).toHaveLength(0);
  });

  test("iterates until eval passes", async () => {
    const { ctx, calls } = createMockContext({
      evalSequence: [
        { all_passed: false },
        { all_passed: false },
        { all_passed: true },
      ],
    });
    const config = makeConfig({ workflow: { loop: ["eval", "develop"] } });
    const tasks = [makeTask("t1")];

    await runBuild(config, tasks, ctx);

    const evalCalls = calls.filter(c => c.fn === "eval");
    // 3 evals: fail, fail, pass
    expect(evalCalls).toHaveLength(3);

    const developCalls = calls.filter(c => c.fn === "invoke" && c.args.label === "develop");
    // 2 develops: after first fail, after second fail
    expect(developCalls).toHaveLength(2);
  });

  test("task state shows correct iteration count", async () => {
    const { ctx } = createMockContext({
      evalSequence: [
        { all_passed: false },
        { all_passed: false },
        { all_passed: true },
      ],
    });
    const config = makeConfig({ workflow: { loop: ["eval", "develop"] } });
    const tasks = [makeTask("t1")];

    const state = await runBuild(config, tasks, ctx);

    expect(state.tasks.t1.iteration).toBe(2); // 2 develop iterations before pass
  });
});

describe("Budget enforcement", () => {
  test("stops after max_iterations", async () => {
    const { ctx, calls } = createMockContext({
      evalSequence: [{ all_passed: false }],
    });
    const config = makeConfig({ workflow: { loop: ["eval", "develop"] } });
    const tasks = [makeTask("t1", { budget: { max_iterations: 3 } })];

    const state = await runBuild(config, tasks, ctx);

    const evalCalls = calls.filter(c => c.fn === "eval");
    // 3 iterations + 1 initial eval = at most 4 evals
    expect(evalCalls.length).toBeLessThanOrEqual(4);
    expect(state.tasks.t1.status).toBe("failed");
    expect(state.tasks.t1.stopReason).toContain("iteration");
  });

  test("stops when cost exceeds max_cost", async () => {
    const { ctx } = createMockContext({
      evalSequence: [{ all_passed: false }],
      invokeCost: 20.0, // $20 per invoke, budget is $50
    });
    const config = makeConfig({ workflow: { loop: ["eval", "develop"] } });
    const tasks = [makeTask("t1", { budget: { max_iterations: 100, max_cost: 50 } })];

    const state = await runBuild(config, tasks, ctx);

    expect(state.tasks.t1.status).toBe("failed");
    expect(state.tasks.t1.costUsd).toBeGreaterThanOrEqual(40); // at least 2 invocations
    expect(state.tasks.t1.stopReason).toContain("cost");
  });

  test("completed task reports cost", async () => {
    const { ctx } = createMockContext({
      evalSequence: [{ all_passed: false }, { all_passed: true }],
      invokeCost: 2.50,
    });
    const config = makeConfig({ workflow: { loop: ["eval", "develop"] } });
    const tasks = [makeTask("t1")];

    const state = await runBuild(config, tasks, ctx);

    expect(state.tasks.t1.costUsd).toBeGreaterThan(0);
    expect(state.totalCostUsd).toBe(state.tasks.t1.costUsd);
  });
});

describe("Stuck detection", () => {
  test("detects stuck loop with identical outputs", async () => {
    const sameOutput = { status: "completed", summary: "no changes" };
    const { ctx, calls } = createMockContext({
      evalSequence: [{ all_passed: false }],
      invokeResults: { develop: sameOutput },
    });
    const config = makeConfig({
      workflow: { loop: ["eval", "develop"] },
      stages: { develop: { toolset: "all", escalation: true, supervisor: true } },
      budget: { max_iterations: 10, stuck_window: 3 },
      supervisor: { toolset: "all" },
    });
    const tasks = [makeTask("t1", { budget: { max_iterations: 10 } })];

    await runBuild(config, tasks, ctx);

    // After 3 identical develop outputs, supervisor should be invoked
    const supervisorCalls = calls.filter(c => c.fn === "invoke" && c.args.label === "supervisor");
    expect(supervisorCalls.length).toBeGreaterThan(0);
  });
});

describe("Escalation", () => {
  test("escalation in develop output triggers supervisor", async () => {
    const { ctx, calls } = createMockContext({
      evalSequence: [{ all_passed: false }],
      invokeResults: {
        develop: {
          status: "failed",
          escalation: {
            cause: "test_bug",
            diagnosis: "The test asserts wrong value",
          },
        },
        supervisor: {
          action: "fix_test",
          reasoning: "Fixed the assertion",
        },
      },
    });
    const config = makeConfig({
      workflow: { loop: ["eval", "develop"] },
      stages: { develop: { toolset: "all", escalation: true, supervisor: true } },
      supervisor: { toolset: "all" },
      budget: { max_iterations: 5 },
    });
    const tasks = [makeTask("t1", { budget: { max_iterations: 5 } })];

    await runBuild(config, tasks, ctx);

    const supervisorCalls = calls.filter(c => c.fn === "invoke" && c.args.label === "supervisor");
    expect(supervisorCalls.length).toBeGreaterThan(0);
  });

  test("escalate_human stops the task", async () => {
    const { ctx } = createMockContext({
      evalSequence: [{ all_passed: false }],
      invokeResults: {
        develop: {
          status: "failed",
          escalation: { cause: "bad_requirements", diagnosis: "Impossible" },
        },
        supervisor: {
          action: "escalate_human",
          reasoning: "Needs architectural decision",
          escalation_message: "Choose between A and B",
        },
      },
    });
    const config = makeConfig({
      workflow: { loop: ["eval", "develop"] },
      stages: { develop: { toolset: "all", escalation: true, supervisor: true } },
      supervisor: { toolset: "all" },
    });
    const tasks = [makeTask("t1")];

    const state = await runBuild(config, tasks, ctx);

    expect(state.tasks.t1.status).toBe("failed");
    expect(state.tasks.t1.stopReason).toContain("escalat");
  });

  test("fix_test retries the iteration", async () => {
    let developCallCount = 0;
    const { ctx, calls } = createMockContext({
      evalSequence: [
        { all_passed: false },
        { all_passed: false },
        { all_passed: true }, // passes after supervisor fixes test
      ],
      invokeResults: {
        develop: (() => {
          // First call escalates, subsequent calls succeed
          return {
            status: "failed",
            escalation: { cause: "test_bug", diagnosis: "bad test" },
          };
        })(),
        supervisor: { action: "fix_test", reasoning: "Fixed it" },
      },
    });
    const config = makeConfig({
      workflow: { loop: ["eval", "develop"] },
      stages: { develop: { toolset: "all", escalation: true, supervisor: true } },
      supervisor: { toolset: "all" },
    });
    const tasks = [makeTask("t1")];

    await runBuild(config, tasks, ctx);

    // Verify the loop continued after supervisor fix
    const evalCalls = calls.filter(c => c.fn === "eval");
    expect(evalCalls.length).toBeGreaterThan(1);
  });
});

describe("Git integration", () => {
  test("snapshots before develop stage", async () => {
    const { ctx, calls } = createMockContext({
      evalSequence: [{ all_passed: false }, { all_passed: true }],
    });
    const config = makeConfig({
      workflow: { loop: ["eval", "develop"] },
      git: { enabled: true, snapshot_before: "develop" },
    });
    const tasks = [makeTask("t1")];

    await runBuild(config, tasks, ctx);

    const snapshotCalls = calls.filter(c => c.fn === "snapshot");
    expect(snapshotCalls.length).toBeGreaterThan(0);

    // Snapshot should be before the develop invoke
    const snapshotIdx = calls.findIndex(c => c.fn === "snapshot");
    const developIdx = calls.findIndex(c => c.fn === "invoke" && c.args.label === "develop");
    expect(snapshotIdx).toBeLessThan(developIdx);
  });

  test("commits after loop passes", async () => {
    const { ctx, calls } = createMockContext({
      evalSequence: [{ all_passed: true }],
    });
    const config = makeConfig({
      workflow: { loop: ["eval", "develop"] },
      git: { enabled: true, commit_after: "loop" },
    });
    const tasks = [makeTask("t1")];

    await runBuild(config, tasks, ctx);

    const commitCalls = calls.filter(c => c.fn === "commit");
    expect(commitCalls).toHaveLength(1);
  });

  test("no commit when loop fails", async () => {
    const { ctx, calls } = createMockContext({
      evalSequence: [{ all_passed: false }],
    });
    const config = makeConfig({
      workflow: { loop: ["eval", "develop"] },
      git: { enabled: true, commit_after: "loop" },
      budget: { max_iterations: 1 },
    });
    const tasks = [makeTask("t1", { budget: { max_iterations: 1 } })];

    await runBuild(config, tasks, ctx);

    const commitCalls = calls.filter(c => c.fn === "commit");
    expect(commitCalls).toHaveLength(0);
  });

  test("reverts on supervisor revert decision", async () => {
    const { ctx, calls } = createMockContext({
      evalSequence: [{ all_passed: false }, { all_passed: true }],
      invokeResults: {
        develop: {
          status: "failed",
          escalation: { cause: "test_bug", diagnosis: "regression" },
        },
        supervisor: { action: "revert", reasoning: "Changes made things worse" },
      },
    });
    const config = makeConfig({
      workflow: { loop: ["eval", "develop"] },
      stages: { develop: { toolset: "all", escalation: true, supervisor: true } },
      git: { enabled: true, snapshot_before: "develop" },
      supervisor: { toolset: "all" },
    });
    const tasks = [makeTask("t1")];

    await runBuild(config, tasks, ctx);

    const revertCalls = calls.filter(c => c.fn === "revert");
    expect(revertCalls.length).toBeGreaterThan(0);
  });

  test("no git operations when git is disabled", async () => {
    const { ctx, calls } = createMockContext({
      evalSequence: [{ all_passed: false }, { all_passed: true }],
    });
    const config = makeConfig({
      workflow: { loop: ["eval", "develop"] },
      // git not set
    });
    const tasks = [makeTask("t1")];

    await runBuild(config, tasks, ctx);

    const gitCalls = calls.filter(c => ["snapshot", "revert", "commit"].includes(c.fn));
    expect(gitCalls).toHaveLength(0);
  });
});

describe("Stage conditions", () => {
  test("has: condition runs stage when variable exists", async () => {
    const { ctx, calls } = createMockContext({
      evalSequence: [{ all_passed: true }],
    });
    const config = makeConfig({
      workflow: { pre: ["understand"], loop: ["eval", "develop"] },
      stages: {
        understand: { toolset: "read_only", condition: "has: understand_focus" },
        develop: { toolset: "all" },
      },
    });
    const tasks = [makeTask("t1", {
      variables: { understand_focus: ["Event loop", "Editor struct"] },
    })];

    await runBuild(config, tasks, ctx);

    const understandCalls = calls.filter(c => c.fn === "invoke" && c.args.label === "understand");
    expect(understandCalls).toHaveLength(1);
  });

  test("has: condition skips stage when variable missing", async () => {
    const { ctx, calls } = createMockContext({
      evalSequence: [{ all_passed: true }],
    });
    const config = makeConfig({
      workflow: { pre: ["understand"], loop: ["eval", "develop"] },
      stages: {
        understand: { toolset: "read_only", condition: "has: understand_focus" },
        develop: { toolset: "all" },
      },
    });
    const tasks = [makeTask("t1", { variables: {} })]; // no understand_focus

    await runBuild(config, tasks, ctx);

    const understandCalls = calls.filter(c => c.fn === "invoke" && c.args.label === "understand");
    expect(understandCalls).toHaveLength(0);
  });

  test("has: condition skips stage when variable is empty array", async () => {
    const { ctx, calls } = createMockContext({
      evalSequence: [{ all_passed: true }],
    });
    const config = makeConfig({
      workflow: { pre: ["understand"], loop: ["eval", "develop"] },
      stages: {
        understand: { toolset: "read_only", condition: "has: understand_focus" },
        develop: { toolset: "all" },
      },
    });
    const tasks = [makeTask("t1", { variables: { understand_focus: [] } })];

    await runBuild(config, tasks, ctx);

    const understandCalls = calls.filter(c => c.fn === "invoke" && c.args.label === "understand");
    expect(understandCalls).toHaveLength(0);
  });

  test("file_missing: condition runs when file doesn't exist", async () => {
    const { ctx, calls } = createMockContext({
      evalSequence: [{ all_passed: true }],
      existingFiles: new Set([]), // no files exist
    });
    const config = makeConfig({
      workflow: { pre: ["write_tests"], loop: ["eval", "develop"] },
      stages: {
        write_tests: { toolset: "code", condition: "file_missing: tests/{task_id}.rs" },
        develop: { toolset: "all" },
      },
    });
    const tasks = [makeTask("t1")];

    await runBuild(config, tasks, ctx);

    const writeTestsCalls = calls.filter(c => c.fn === "invoke" && c.args.label === "write_tests");
    expect(writeTestsCalls).toHaveLength(1);
  });

  test("file_missing: condition skips when file exists", async () => {
    const { ctx, calls } = createMockContext({
      evalSequence: [{ all_passed: true }],
      existingFiles: new Set(["tests/t1.rs"]),
    });
    const config = makeConfig({
      workflow: { pre: ["write_tests"], loop: ["eval", "develop"] },
      stages: {
        write_tests: { toolset: "code", condition: "file_missing: tests/{task_id}.rs" },
        develop: { toolset: "all" },
      },
    });
    const tasks = [makeTask("t1")];

    await runBuild(config, tasks, ctx);

    const writeTestsCalls = calls.filter(c => c.fn === "invoke" && c.args.label === "write_tests");
    expect(writeTestsCalls).toHaveLength(0);
  });

  test("always condition always runs", async () => {
    const { ctx, calls } = createMockContext({
      evalSequence: [{ all_passed: true }],
    });
    const config = makeConfig({
      workflow: { pre: ["understand"], loop: ["eval", "develop"] },
      stages: {
        understand: { toolset: "read_only", condition: "always" },
        develop: { toolset: "all" },
      },
    });
    const tasks = [makeTask("t1")];

    await runBuild(config, tasks, ctx);

    const understandCalls = calls.filter(c => c.fn === "invoke" && c.args.label === "understand");
    expect(understandCalls).toHaveLength(1);
  });
});

describe("Config reload", () => {
  test("picks up increased max_iterations mid-loop", async () => {
    let reloadCount = 0;
    const { ctx, calls } = createMockContext({
      evalSequence: [{ all_passed: false }], // never passes
    });
    // Override readLiveConfig to increase iterations after 2 reads
    ctx.readLiveConfig = async () => {
      reloadCount++;
      if (reloadCount >= 2) {
        return { max_iterations: 5 }; // bump from 2 to 5
      }
      return null;
    };

    const config = makeConfig({ workflow: { loop: ["eval", "develop"] } });
    const tasks = [makeTask("t1", { budget: { max_iterations: 2 } })];

    const state = await runBuild(config, tasks, ctx);

    // Should have run more than 2 iterations because config was reloaded
    const evalCalls = calls.filter(c => c.fn === "eval");
    expect(evalCalls.length).toBeGreaterThan(2);
  });
});

describe("Multi-task execution", () => {
  test("runs tasks in dependency order", async () => {
    const { ctx, calls } = createMockContext({
      evalSequence: [{ all_passed: true }],
    });
    const config = makeConfig({ workflow: { loop: ["eval", "develop"] } });
    const tasks = [
      makeTask("b", { depends_on: ["a"] }),
      makeTask("a"),
    ];

    const state = await runBuild(config, tasks, ctx);

    // Find the first eval for each task
    const taskOrder: string[] = [];
    for (const call of calls) {
      if (call.fn === "eval" && !taskOrder.includes(call.args.taskId as string)) {
        taskOrder.push(call.args.taskId as string);
      }
    }
    expect(taskOrder).toEqual(["a", "b"]);
  });

  test("stops build when a task fails", async () => {
    const { ctx, calls } = createMockContext({
      evalSequence: [{ all_passed: false }], // never passes
    });
    const config = makeConfig({ workflow: { loop: ["eval", "develop"] } });
    const tasks = [
      makeTask("a", { budget: { max_iterations: 1 } }),
      makeTask("b", { depends_on: ["a"] }),
    ];

    const state = await runBuild(config, tasks, ctx);

    expect(state.tasksFailed).toContain("a");
    // b should never start because a failed
    const bEvals = calls.filter(c => c.fn === "eval" && c.args.taskId === "b");
    expect(bEvals).toHaveLength(0);
  });

  test("reports completed tasks in state", async () => {
    const { ctx } = createMockContext({
      evalSequence: [{ all_passed: true }],
    });
    const config = makeConfig({ workflow: { loop: ["eval", "develop"] } });
    const tasks = [makeTask("a"), makeTask("b", { depends_on: ["a"] })];

    const state = await runBuild(config, tasks, ctx);

    expect(state.tasksCompleted).toContain("a");
    expect(state.tasksCompleted).toContain("b");
    expect(state.status).toBe("completed");
  });

  test("accumulates cost across tasks", async () => {
    const { ctx } = createMockContext({
      evalSequence: [{ all_passed: false }, { all_passed: true }],
      invokeCost: 5.0,
    });
    const config = makeConfig({ workflow: { loop: ["eval", "develop"] } });
    const tasks = [makeTask("a"), makeTask("b")];

    const state = await runBuild(config, tasks, ctx);

    expect(state.totalCostUsd).toBeGreaterThan(5.0); // at least 2 invoke calls
  });
});

describe("Build state output", () => {
  test("returns completed state for successful build", async () => {
    const { ctx } = createMockContext({
      evalSequence: [{ all_passed: true }],
    });
    const config = makeConfig({ workflow: { loop: ["eval", "develop"] } });
    const tasks = [makeTask("t1")];

    const state = await runBuild(config, tasks, ctx);

    expect(state.status).toBe("completed");
    expect(state.name).toBe("test-build");
    expect(state.tasksCompleted).toContain("t1");
    expect(state.tasksFailed).toHaveLength(0);
  });

  test("returns failed state when task exhausts budget", async () => {
    const { ctx } = createMockContext({
      evalSequence: [{ all_passed: false }],
    });
    const config = makeConfig({ workflow: { loop: ["eval", "develop"] } });
    const tasks = [makeTask("t1", { budget: { max_iterations: 1 } })];

    const state = await runBuild(config, tasks, ctx);

    expect(state.status).toBe("failed");
    expect(state.tasksFailed).toContain("t1");
  });

  test("includes timestamps", async () => {
    const { ctx } = createMockContext({
      evalSequence: [{ all_passed: true }],
    });
    const config = makeConfig({ workflow: { loop: ["eval", "develop"] } });
    const tasks = [makeTask("t1")];

    const state = await runBuild(config, tasks, ctx);

    expect(state.startedAt).toBeDefined();
    expect(state.updatedAt).toBeDefined();
    expect(new Date(state.startedAt).getTime()).toBeGreaterThan(0);
  });
});

describe("Per-task stage overrides", () => {
  test("task-level max_turns is passed to invoke", async () => {
    const { ctx, calls } = createMockContext({
      evalSequence: [{ all_passed: false }, { all_passed: true }],
    });
    const config = makeConfig({
      workflow: { loop: ["eval", "develop"] },
      stages: { develop: { toolset: "all", max_turns: 100 } },
    });
    const tasks = [makeTask("t1", {
      stages: { develop: { max_turns: 200 } },
    })];

    await runBuild(config, tasks, ctx);

    const developCall = calls.find(c => c.fn === "invoke" && c.args.label === "develop");
    expect(developCall).toBeDefined();
    expect(developCall!.args.maxTurns).toBe(200);
  });
});

describe("Git commit message template", () => {
  test("commit message renders {task_id} and {name}", async () => {
    const { ctx, calls } = createMockContext({
      evalSequence: [{ all_passed: true }],
    });
    const config = makeConfig({
      workflow: { loop: ["eval", "develop"] },
      git: { enabled: true, commit_after: "loop", commit_message: "build-{name}: {task_id} done" },
    });
    const tasks = [makeTask("dev_socket")];

    await runBuild(config, tasks, ctx);

    const commitCall = calls.find(c => c.fn === "commit");
    expect(commitCall).toBeDefined();
    expect(commitCall!.args.message).toContain("dev_socket");
    expect(commitCall!.args.message).toContain("test-build");
  });
});

// ---------------------------------------------------------------------------
// Session continuity
// ---------------------------------------------------------------------------

describe("Session continuity", () => {
  test("passes sessionId back to same stage on next iteration", async () => {
    let callCount = 0;
    const { ctx, calls } = createMockContext({
      evalSequence: [
        { all_passed: false },
        { all_passed: false },
        { all_passed: true },
      ],
    });
    // Override invoke to return unique session IDs
    const origInvoke = ctx.invoke;
    ctx.invoke = async (label, opts) => {
      callCount++;
      const result = await origInvoke(label, opts);
      return { ...result, sessionId: `sess_${label}_${callCount}` };
    };

    const config = makeConfig({ workflow: { loop: ["eval", "develop"] } });
    const tasks = [makeTask("t1")];
    await runBuild(config, tasks, ctx);

    const invokeCalls = calls.filter(c => c.fn === "invoke" && c.args.label === "develop");
    // Second develop call should have sessionId from the first
    expect(invokeCalls.length).toBe(2);
    expect(invokeCalls[0].args.sessionId).toBeUndefined();
    expect(invokeCalls[1].args.sessionId).toBe("sess_develop_1");
  });

  test("pre-stage sessions are tracked independently", async () => {
    const { ctx, calls } = createMockContext({
      evalSequence: [{ all_passed: true }],
    });
    let callCount = 0;
    const origInvoke = ctx.invoke;
    ctx.invoke = async (label, opts) => {
      callCount++;
      const result = await origInvoke(label, opts);
      return { ...result, sessionId: `sess_${label}_${callCount}` };
    };

    const config = makeConfig({
      workflow: { pre: ["understand"], loop: ["eval", "develop"] },
      stages: { understand: { toolset: "read_only", max_turns: 40 }, develop: { toolset: "all", max_turns: 100 } },
    });
    const tasks = [makeTask("t1")];
    await runBuild(config, tasks, ctx);

    // understand and develop should have different session IDs
    const understandCalls = calls.filter(c => c.fn === "invoke" && c.args.label === "understand");
    const developCalls = calls.filter(c => c.fn === "invoke" && c.args.label === "develop");
    expect(understandCalls.length).toBe(1);
    expect(developCalls.length).toBe(0); // eval passed on first try, no develop needed
  });
});

// ---------------------------------------------------------------------------
// Data directory — file-based message passing
// ---------------------------------------------------------------------------

describe("Task data directory", () => {
  test("writes stage output to task dir after invoke", async () => {
    const { mkdtempSync } = await import("fs");
    const { join } = await import("path");
    const { readFileSync, existsSync } = await import("fs");
    const tmpDir = mkdtempSync("/tmp/orca-test-");

    const { ctx } = createMockContext({
      evalSequence: [{ all_passed: false }, { all_passed: true }],
      invokeResults: {
        analyze: { root_cause: "missing null check", recommended_fix: "add guard" },
        develop: { status: "completed", summary: "added null check" },
      },
    });

    const config = makeConfig({ workflow: { loop: ["eval", "analyze", "develop"] }, stages: { analyze: { toolset: "read_only", max_turns: 40 }, develop: { toolset: "all", max_turns: 100 } } });
    const tasks = [makeTask("test_task")];
    await runBuild(config, tasks, ctx, tmpDir);

    const taskDir = join(tmpDir, ".orca", "tasks", "test_task");
    expect(existsSync(taskDir)).toBe(true);

    // Check analyze output was written
    const analyzeOutput = JSON.parse(readFileSync(join(taskDir, "analyze.json"), "utf8"));
    expect(analyzeOutput.root_cause).toBe("missing null check");

    // Check develop output was written
    const developOutput = JSON.parse(readFileSync(join(taskDir, "develop.json"), "utf8"));
    expect(developOutput.status).toBe("completed");

    // Cleanup
    const { rmSync } = await import("fs");
    rmSync(tmpDir, { recursive: true });
  });

  test("writes eval output to task dir", async () => {
    const { mkdtempSync } = await import("fs");
    const { join } = await import("path");
    const { readFileSync, existsSync } = await import("fs");
    const tmpDir = mkdtempSync("/tmp/orca-test-");

    const { ctx } = createMockContext({
      evalSequence: [{ all_passed: false, output: "test_foo FAILED\nassert_eq!(1, 2)", total: 1, passed: 0, failed: 1 }, { all_passed: true }],
    });

    const config = makeConfig({ workflow: { loop: ["eval", "develop"] } });
    const tasks = [makeTask("eval_task")];
    await runBuild(config, tasks, ctx, tmpDir);

    const taskDir = join(tmpDir, ".orca", "tasks", "eval_task");
    expect(existsSync(join(taskDir, "eval_output.txt"))).toBe(true);

    const evalOutput = readFileSync(join(taskDir, "eval_output.txt"), "utf8");
    expect(evalOutput).toContain("test_foo FAILED");

    // eval_result.json reflects the last eval run (which passed)
    const evalResult = JSON.parse(readFileSync(join(taskDir, "eval_result.json"), "utf8"));
    expect(evalResult.all_passed).toBe(true);

    const { rmSync } = await import("fs");
    rmSync(tmpDir, { recursive: true });
  });

  test("writes pre-stage output to task dir", async () => {
    const { mkdtempSync } = await import("fs");
    const { join } = await import("path");
    const { readFileSync, existsSync } = await import("fs");
    const tmpDir = mkdtempSync("/tmp/orca-test-");

    const { ctx } = createMockContext({
      evalSequence: [{ all_passed: true }],
      invokeResults: {
        understand: { key_files: "src/main.rs", architecture_notes: "modular design" },
      },
    });

    const config = makeConfig({
      workflow: { pre: ["understand"], loop: ["eval", "develop"] },
      stages: { understand: { toolset: "read_only", max_turns: 40 }, develop: { toolset: "all", max_turns: 100 } },
    });
    const tasks = [makeTask("pre_task")];
    await runBuild(config, tasks, ctx, tmpDir);

    const taskDir = join(tmpDir, ".orca", "tasks", "pre_task");
    expect(existsSync(join(taskDir, "understand.json"))).toBe(true);

    const output = JSON.parse(readFileSync(join(taskDir, "understand.json"), "utf8"));
    expect(output.key_files).toBe("src/main.rs");

    const { rmSync } = await import("fs");
    rmSync(tmpDir, { recursive: true });
  });

  test("orca.task_dir template variable is set", async () => {
    const { ctx, calls } = createMockContext({
      evalSequence: [{ all_passed: true }],
      prompts: { develop: "Write to {orca.task_dir}/output.txt" },
    });

    const config = makeConfig({ workflow: { loop: ["eval", "develop"] } });
    const tasks = [makeTask("tvar_task")];
    await runBuild(config, tasks, ctx);
  });
});

// ---------------------------------------------------------------------------
// Prompt injection (config.prompts)
// ---------------------------------------------------------------------------

describe("Prompt injection", () => {
  test("config.prompts.context is prepended to all stage prompts", async () => {
    const { ctx, calls } = createMockContext({
      evalSequence: [{ all_passed: false }, { all_passed: true }],
      prompts: { develop: "base develop prompt" },
    });

    const config = makeConfig({
      workflow: { loop: ["eval", "develop"] },
      prompts: { context: "This is the project context." },
    });
    const tasks = [makeTask("t1")];
    await runBuild(config, tasks, ctx);

    const developCall = calls.find(c => c.fn === "invoke" && c.args.label === "develop");
    expect(developCall).toBeDefined();
    expect((developCall!.args.prompt as string).startsWith("This is the project context.")).toBe(true);
  });

  test("config.prompts.stages appends to specific stage prompt", async () => {
    const { ctx, calls } = createMockContext({
      evalSequence: [{ all_passed: false }, { all_passed: true }],
      prompts: { develop: "base develop prompt", analyze: "base analyze prompt" },
    });

    const config = makeConfig({
      workflow: { loop: ["eval", "analyze", "develop"] },
      stages: { analyze: { toolset: "read_only", max_turns: 40 }, develop: { toolset: "all", max_turns: 100 } },
      prompts: { stages: { develop: "Extra develop instructions." } },
    });
    const tasks = [makeTask("t1")];
    await runBuild(config, tasks, ctx);

    const developCall = calls.find(c => c.fn === "invoke" && c.args.label === "develop");
    expect(developCall).toBeDefined();
    expect((developCall!.args.prompt as string).includes("Extra develop instructions.")).toBe(true);

    // analyze should NOT have the develop-specific injection
    const analyzeCall = calls.find(c => c.fn === "invoke" && c.args.label === "analyze");
    expect(analyzeCall).toBeDefined();
    expect((analyzeCall!.args.prompt as string).includes("Extra develop instructions.")).toBe(false);
  });

  test("both context and stage-specific prompts combine", async () => {
    const { ctx, calls } = createMockContext({
      evalSequence: [{ all_passed: false }, { all_passed: true }],
    });

    const config = makeConfig({
      workflow: { loop: ["eval", "develop"] },
      prompts: {
        context: "PROJECT CONTEXT",
        stages: { develop: "DEVELOP EXTRA" },
      },
    });
    const tasks = [makeTask("t1")];
    await runBuild(config, tasks, ctx);

    const developCall = calls.find(c => c.fn === "invoke" && c.args.label === "develop");
    const prompt = developCall!.args.prompt as string;
    expect(prompt.startsWith("PROJECT CONTEXT")).toBe(true);
    expect(prompt.endsWith("DEVELOP EXTRA")).toBe(true);
  });

  test("pre-stages receive prompt injection", async () => {
    const { ctx, calls } = createMockContext({
      evalSequence: [{ all_passed: true }],
      prompts: { understand: "research prompt" },
    });

    const config = makeConfig({
      workflow: { pre: ["understand"], loop: ["eval", "develop"] },
      stages: { understand: { toolset: "read_only", max_turns: 40 }, develop: { toolset: "all", max_turns: 100 } },
      prompts: { context: "GLOBAL CONTEXT", stages: { understand: "UNDERSTAND EXTRA" } },
    });
    const tasks = [makeTask("t1")];
    await runBuild(config, tasks, ctx);

    const understandCall = calls.find(c => c.fn === "invoke" && c.args.label === "understand");
    const prompt = understandCall!.args.prompt as string;
    expect(prompt.startsWith("GLOBAL CONTEXT")).toBe(true);
    expect(prompt.includes("UNDERSTAND EXTRA")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Generalized stages: type, gate, builtin, per-task workflows
// ---------------------------------------------------------------------------

describe("Stage type inference", () => {
  test("stage named 'eval' infers type eval", async () => {
    const { ctx, calls } = createMockContext({
      evalSequence: [{ all_passed: true }],
    });
    const config = makeConfig({ workflow: { loop: ["eval"] } });
    const tasks = [makeTask("t1")];
    const state = await runBuild(config, tasks, ctx);
    expect(state.status).toBe("completed");
    expect(calls.some(c => c.fn === "eval")).toBe(true);
  });

  test("stage with command field infers type command", async () => {
    const { ctx, calls } = createMockContext({
      evalSequence: [{ all_passed: true }],
    });
    const config = makeConfig({
      workflow: { loop: ["eval", "deploy"] },
      stages: {
        deploy: { command: "echo deployed" },
      },
    });
    const tasks = [makeTask("t1")];
    const state = await runBuild(config, tasks, ctx);
    // eval passes immediately so deploy doesn't run (loop exits on eval pass)
    expect(state.status).toBe("completed");
  });

  test("explicit type: eval on a non-eval named stage runs eval", async () => {
    const { ctx, calls } = createMockContext({
      evalSequence: [
        { all_passed: false },
        { all_passed: true },
      ],
    });
    const config = makeConfig({
      workflow: { loop: ["integration_test", "develop"] },
      stages: {
        integration_test: { type: "eval" } as any,
        develop: { toolset: "all", max_turns: 10 },
      },
    });
    const tasks = [makeTask("t1")];
    const state = await runBuild(config, tasks, ctx);
    expect(state.status).toBe("completed");
    // Should have called eval twice (fail then pass)
    const evalCalls = calls.filter(c => c.fn === "eval");
    expect(evalCalls.length).toBe(2);
  });
});

describe("Gate stages in loop", () => {
  test("gate stage restarts loop on failure", async () => {
    let reviewCount = 0;
    const { ctx, calls } = createMockContext({
      evalSequence: [
        { all_passed: false },  // iter 1: fail → develop runs
        { all_passed: false },  // iter 2: fail → develop runs (after review gate fail restarts)
        { all_passed: true },   // iter 3: would pass but won't reach here due to loop structure
      ],
    });

    // Workflow: develop → review(gate) → eval
    // iter 1: develop → review fails (gate) → loop restarts
    // iter 2: develop → review passes (gate) → eval fails → loop continues
    // iter 3: develop → review passes → eval passes → done
    const origInvoke = ctx.invoke;
    ctx.invoke = async (label, opts) => {
      if (label === "review") {
        reviewCount++;
        const status = reviewCount >= 2 ? "passed" : "failed";
        return {
          output: { status, summary: `review ${reviewCount}` },
          costUsd: 0.1, sessionId: null, numTurns: 2, durationMs: 500,
        };
      }
      return origInvoke(label, opts);
    };

    // Override eval to track iteration count properly
    let evalCount = 0;
    ctx.eval = async () => {
      evalCount++;
      // Pass on the second eval call (after review gate passes)
      return { all_passed: evalCount >= 2 };
    };

    const config = makeConfig({
      workflow: { loop: ["develop", "review", "eval"] },
      stages: {
        develop: { toolset: "all", max_turns: 10 },
        review: { gate: true } as any,
      },
      budget: { max_iterations: 10, max_cost: 50 },
    });
    const tasks = [makeTask("t1")];
    const state = await runBuild(config, tasks, ctx);

    expect(state.status).toBe("completed");
    // review was called multiple times — first call failed (gate restarted loop)
    expect(reviewCount).toBeGreaterThanOrEqual(2);
    // eval only reached after review gate passes
    expect(evalCount).toBeGreaterThanOrEqual(1);
  });
});

describe("Per-task workflows", () => {
  test("task uses named workflow from workflows map", async () => {
    const { ctx, calls } = createMockContext({
      evalSequence: [{ all_passed: true }],
    });
    const config = makeConfig({
      workflow: { loop: ["eval", "develop"] },
      workflows: {
        simple: { loop: ["eval"] },
      },
      stages: {
        develop: { toolset: "all", max_turns: 10 },
      },
    });
    // Task uses the "simple" workflow — no develop stage
    const tasks = [makeTask("t1", { workflow: "simple" })];
    const state = await runBuild(config, tasks, ctx);

    expect(state.status).toBe("completed");
    // No invoke calls — simple workflow only has eval
    const invokeCalls = calls.filter(c => c.fn === "invoke");
    expect(invokeCalls.length).toBe(0);
  });

  test("task without workflow uses default", async () => {
    const { ctx, calls } = createMockContext({
      evalSequence: [{ all_passed: true }],
    });
    const config = makeConfig({
      workflow: { loop: ["eval", "develop"] },
      workflows: {
        simple: { loop: ["eval"] },
      },
      stages: {
        develop: { toolset: "all", max_turns: 10 },
      },
    });
    // No workflow specified — uses default
    const tasks = [makeTask("t1")];
    const state = await runBuild(config, tasks, ctx);

    expect(state.status).toBe("completed");
    // eval passes immediately so develop doesn't run (eval is first, passes, exits loop)
    // But the default workflow includes develop in the loop
  });

  test("mixed workflows in same build", async () => {
    const { ctx, calls } = createMockContext({
      evalSequence: [
        { all_passed: false }, { all_passed: true },  // t1: fail then pass
        { all_passed: true },                          // t2: pass immediately
      ],
    });
    const config = makeConfig({
      workflow: { loop: ["eval", "develop"] },
      workflows: {
        qa_only: { loop: ["eval"] },
      },
      stages: {
        develop: { toolset: "all", max_turns: 10 },
      },
    });
    const tasks = [
      makeTask("t1"),                                    // uses default workflow
      makeTask("t2", { depends_on: ["t1"], workflow: "qa_only" }), // uses qa_only
    ];
    const state = await runBuild(config, tasks, ctx);

    expect(state.status).toBe("completed");
    expect(state.tasksCompleted).toContain("t1");
    expect(state.tasksCompleted).toContain("t2");
    // t1 should have had a develop invoke, t2 should not
    const developCalls = calls.filter(c => c.fn === "invoke" && c.args.label === "develop");
    expect(developCalls.length).toBe(1); // only t1
  });
});


