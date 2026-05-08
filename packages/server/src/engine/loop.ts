/**
 * Core iteration loop — the state machine.
 *
 * Reads the config, iterates through tasks, runs the workflow
 * (setup → pre → loop → post) for each task, manages budget,
 * stuck detection, and escalation.
 */

import { createHash } from "crypto";
import { existsSync, mkdirSync, writeFileSync, appendFileSync } from "fs";
import { join } from "path";
import type {
  OrcaConfig, ResolvedTask, EvalConfig, EvalResult,
  ScopeConfig, StageConfig, StageOverride, WorkflowConfig,
} from "../config/schema";
import type { BuildState, TaskState, TaskDiscovery } from "../state";
import { saveState, getRunDir } from "../state";
import { loadTasks } from "../config/loader";
import type { Display } from "../display/types";
import { resolveExecutionOrder } from "../config/tasks";
import { extractEscalation, detectStuck, shouldRetry, shouldStop } from "./supervisor";
import { buildTaskVars, applyVars, formatVariable } from "../templates";
import { notify } from "../notifications";
import type { NotificationPayload } from "../notifications";
import { writeIntervention, pollForResponse, clearIntervention } from "../intervention";
import { getOrcaDir } from "../state";

// ---------------------------------------------------------------------------
// BuildContext — injectable dependencies
// ---------------------------------------------------------------------------

export interface BuildContext {
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

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

export interface LoopOptions {
  config: OrcaConfig;
  tasks: ResolvedTask[];
  configPath: string;
  projectDir: string;
  taskId?: string;
  parallel?: boolean;
  /** State from a prior run — used by resume to seed completions, cost, and task history. */
  priorState?: BuildState;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function hashOutput(output: Record<string, unknown> | null): string | null {
  if (!output) return null;
  return createHash("md5").update(JSON.stringify(output, null, 0)).digest("hex");
}

interface ResolvedStage {
  type: "agent" | "command" | "eval";
  gate?: boolean;
  builtin?: string;
  toolset?: string;
  maxTurns?: number;
  model?: string;
  escalation?: boolean;
  supervisor?: boolean;
  condition?: string;
  scope?: ScopeConfig;
  command?: string;
  parser?: string;
  wait_for?: string;
  wait_timeout?: number;
}

function resolveStage(
  label: string,
  config: OrcaConfig,
  task: ResolvedTask,
): ResolvedStage {
  const base = config.stages?.[label] ?? {};
  const override: StageOverride = task.stages?.[label] ?? {};

  // Infer type: explicit > command field > name "eval" > agent
  const type = base.type
    ?? (base.command ? "command" : undefined)
    ?? (label === "eval" ? "eval" : undefined)
    ?? "agent";

  return {
    type,
    gate: base.gate,
    builtin: base.builtin,
    toolset: override.toolset ?? base.toolset ?? "all",
    maxTurns: override.maxTurns ?? override.max_turns ?? base.max_turns ?? 40,
    model: override.model ?? base.model,
    escalation: base.escalation,
    supervisor: base.supervisor,
    condition: base.condition,
    scope: base.scope ?? config.scope,
    command: base.command,
    parser: base.parser,
    wait_for: base.wait_for,
    wait_timeout: base.wait_timeout,
  };
}

/** Resolve the workflow for a task — per-task override or default. */
function resolveWorkflow(config: OrcaConfig, task: ResolvedTask): WorkflowConfig {
  if (task.workflow && config.workflows?.[task.workflow]) {
    return config.workflows[task.workflow];
  }
  return config.workflow;
}

function evaluateCondition(
  condition: string | undefined,
  task: ResolvedTask,
  ctx: BuildContext,
): boolean {
  if (!condition || condition === "always") return true;

  if (condition.startsWith("has:")) {
    const varName = condition.slice(4).trim();
    const value = task.variables[varName];
    if (value === undefined || value === null) return false;
    if (Array.isArray(value) && value.length === 0) return false;
    if (typeof value === "string" && value.trim() === "") return false;
    return true;
  }

  if (condition.startsWith("file_missing:")) {
    const pathTemplate = condition.slice(13).trim();
    const path = pathTemplate.replace(/\{task_id\}/g, task.id);
    return !ctx.fileExists(path);
  }

  return true;
}

function renderTemplate(template: string, vars: Record<string, string>): string {
  let result = template;
  for (const [key, value] of Object.entries(vars)) {
    result = result.replaceAll(`{${key}}`, value);
  }
  return result;
}

function now(): string {
  return new Date().toISOString();
}

// ---------------------------------------------------------------------------
// Command stage execution — deploy-style stages that run shell commands
// ---------------------------------------------------------------------------

async function runCommandStage(
  command: string,
  waitFor: string | undefined,
  waitTimeout: number,
): Promise<{ success: boolean; output: string; durationMs: number }> {
  const startMs = Date.now();

  // Run the main command
  const proc = Bun.spawn(["bash", "-c", command], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const exitCode = await proc.exited;
  const stdout = await new Response(proc.stdout).text();
  const stderr = await new Response(proc.stderr).text();
  const output = (stdout + stderr).trim();

  if (exitCode !== 0) {
    return { success: false, output: output || `Command exited with code ${exitCode}`, durationMs: Date.now() - startMs };
  }

  // Poll wait_for health check if configured
  if (waitFor) {
    const deadline = Date.now() + waitTimeout * 1000;
    while (Date.now() < deadline) {
      const check = Bun.spawnSync(["bash", "-c", waitFor], {
        stdout: "pipe",
        stderr: "pipe",
      });
      if (check.exitCode === 0) {
        return { success: true, output, durationMs: Date.now() - startMs };
      }
      await Bun.sleep(5000);
    }
    return { success: false, output: `Health check timed out after ${waitTimeout}s: ${waitFor}`, durationMs: Date.now() - startMs };
  }

  return { success: true, output, durationMs: Date.now() - startMs };
}

// ---------------------------------------------------------------------------
// Notification helper
// ---------------------------------------------------------------------------

async function sendNotify(
  config: OrcaConfig,
  event: NotificationPayload["event"],
  message: string,
  taskId?: string,
  details?: string,
): Promise<void> {
  if (!config.notifications) return;
  try {
    await notify(config.notifications, {
      event,
      buildName: config.name,
      taskId,
      message,
      details,
    });
  } catch {}
}

// ---------------------------------------------------------------------------
// Build event logger — .orca/build.jsonl
// ---------------------------------------------------------------------------

class BuildLog {
  private path: string | null;

  constructor(projectDir: string) {
    if (!projectDir) { this.path = null; return; }
    const dir = getOrcaDir(projectDir);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    this.path = join(dir, "build.jsonl");
  }

  write(event: string, data: Record<string, unknown> = {}) {
    if (!this.path) return;
    const record = { ts: new Date().toISOString(), event, ...data };
    try { appendFileSync(this.path, JSON.stringify(record) + "\n"); } catch {}
  }
}

// ---------------------------------------------------------------------------
// Task data directory — file-based message passing between stages
// ---------------------------------------------------------------------------

function getTaskDir(projectDir: string, taskId: string): string {
  return join(getOrcaDir(projectDir), "tasks", taskId);
}

function ensureTaskDir(projectDir: string, taskId: string): string {
  const dir = getTaskDir(projectDir, taskId);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  return dir;
}

function writeStageOutput(
  projectDir: string,
  taskId: string,
  stageName: string,
  output: Record<string, unknown> | null,
): void {
  if (!output) return;
  const dir = ensureTaskDir(projectDir, taskId);
  writeFileSync(join(dir, `${stageName}.json`), JSON.stringify(output, null, 2));
}

function writeEvalOutput(
  projectDir: string,
  taskId: string,
  result: EvalResult,
  rawOutput?: string,
): void {
  const dir = ensureTaskDir(projectDir, taskId);
  // Write raw test output for analyze to read
  if (rawOutput) {
    writeFileSync(join(dir, "eval_output.txt"), rawOutput);
  }
  // Also write parsed result
  writeFileSync(join(dir, "eval_result.json"), JSON.stringify(result, null, 2));
}

// ---------------------------------------------------------------------------
// Invoke with retry — wraps ctx.invoke with error handling
// ---------------------------------------------------------------------------

async function invokeWithRetry(
  ctx: BuildContext,
  label: string,
  opts: Parameters<BuildContext["invoke"]>[1],
  config: OrcaConfig,
  maxRetries = 1,
): Promise<{ output: Record<string, unknown> | null; costUsd: number; sessionId: string | null; numTurns: number; durationMs: number }> {
  // Guard against empty prompts — the API rejects empty text blocks with cache_control
  if (!opts.prompt || opts.prompt.trim() === "") {
    throw new Error(`Empty prompt for stage "${label}". Check that a prompt template exists for this stage.`);
  }

  let lastError: Error | null = null;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await ctx.invoke(label, opts);
    } catch (err: any) {
      lastError = err;
      if (attempt < maxRetries) {
        ctx.display.onStageEnd(label, 0, 0, 0, `crashed, retrying (${attempt + 1}/${maxRetries})`);
        await sendNotify(config, "stage_error",
          `Stage ${label} crashed (attempt ${attempt + 1}), retrying: ${err.message}`,
          opts.taskId);
        // Brief pause before retry
        await Bun.sleep(3000);
        ctx.display.onStageStart(label, 0);
      }
    }
  }

  // All retries exhausted
  await sendNotify(config, "stage_error",
    `Stage ${label} failed after ${maxRetries + 1} attempts: ${lastError?.message}`,
    opts.taskId);
  throw lastError!;
}

// ---------------------------------------------------------------------------
// Build
// ---------------------------------------------------------------------------

export async function runBuild(options: LoopOptions, ctx?: BuildContext): Promise<BuildState> {
  if (!ctx) throw new Error("BuildContext required");

  const { config, tasks: rawTasks, projectDir } = options;
  const tasks = resolveExecutionOrder(rawTasks);
  const startedAt = now();

  const prior = options.priorState;
  const state: BuildState = {
    runId: new Date().toISOString().replace(/[-:T.]/g, "").slice(0, 14),
    name: config.name,
    status: "running",
    currentTaskId: null,
    tasksCompleted: prior ? [...prior.tasksCompleted] : [],
    tasksFailed: prior ? [...prior.tasksFailed] : [],
    totalCostUsd: prior ? prior.totalCostUsd : 0,
    startedAt,
    updatedAt: startedAt,
    tasks: prior ? { ...prior.tasks } : {},
    tasksDiscovered: [],
  };

  // Compute runDir for incremental state persistence
  const runDir = projectDir
    ? getRunDir(projectDir, config.name, state.runId)
    : null;

  async function persist() {
    if (!runDir) return;
    state.updatedAt = now();
    try { await saveState(runDir, state); } catch {}
  }

  // Initial state — creates .orca/runs/{name}/{runId}/state.json
  await persist();

  ctx.display.onBuildStart(config.name, tasks.length);
  await sendNotify(config, "build_start",
    `Build ${config.name} started — ${tasks.length} tasks`);

  // --- Setup (once) ---
  if (config.workflow.setup) {
    const setupName = config.workflow.setup;
    state.currentTaskId = setupName;
    state.tasks[setupName] = {
      taskId: setupName,
      status: "running",
      currentStage: setupName,
      stageStartedAt: new Date().toISOString(),
      stageTurns: null,
      stageMaxTurns: null,
      iteration: 0,
      maxIterations: 1,
      costUsd: 0,
      maxCost: 0,
      stopReason: null,
      snapshots: [],
      history: [],
    };
    await persist();

    const setupStage = resolveStage(setupName, config, tasks[0] ?? {} as ResolvedTask);
    let prompt = await ctx.loadPrompt(setupName, "") ?? "";
    if (config.prompts?.context) prompt = config.prompts.context.trim() + "\n\n" + prompt;
    if (config.prompts?.stages?.[setupName]) prompt = prompt + "\n\n" + config.prompts.stages[setupName].trim();
    ctx.display.onStageStart(setupName, 0);
    const result = await invokeWithRetry(ctx, setupName, {
      prompt,
      taskId: "",
      toolset: setupStage.toolset,
      maxTurns: setupStage.maxTurns,
    }, config);
    state.totalCostUsd += result.costUsd;
    state.tasks[setupName].costUsd = result.costUsd;
    state.tasks[setupName].status = "completed";
    state.currentTaskId = null;
    ctx.display.onStageEnd(setupName, 0, result.costUsd, 0, "done");
    await persist();
  }

  // --- Run each task (queue-based with live re-reading) ---
  const taskQueue: ResolvedTask[] = [...tasks];
  const completedIds = new Set<string>(state.tasksCompleted);
  // Seed seenIds with ALL tasks from the file, not just the filtered subset.
  // This prevents checkForNewTasks from re-discovering tasks that were excluded
  // by --tag/--from/--task filters. Only truly new tasks added mid-build get picked up.
  let seenIds: Set<string>;
  try {
    const allTasks = await loadTasks(options.config, options.configPath);
    seenIds = new Set<string>(allTasks.map(t => t.id));
  } catch {
    seenIds = new Set<string>(tasks.map(t => t.id));
  }
  let tasksStarted = 0;

  // Record initial tasks as discovered at build start
  for (const t of tasks) {
    state.tasksDiscovered!.push({ taskId: t.id, discoveredAt: startedAt });
  }

  while (taskQueue.length > 0) {
    // Find first task whose dependencies are all completed
    const nextIndex = taskQueue.findIndex(t =>
      t.depends_on.every(dep => completedIds.has(dep))
    );

    if (nextIndex === -1) {
      // No eligible tasks — all remaining are blocked
      break;
    }

    const task = taskQueue.splice(nextIndex, 1)[0];
    tasksStarted++;

    state.currentTaskId = task.id;
    ctx.display.onTaskStart(task.id, task.title, tasksStarted, tasksStarted + taskQueue.length);
    await sendNotify(config, "task_start",
      `Task ${task.id} started (${tasksStarted}/${tasksStarted + taskQueue.length})`, task.id);
    await persist();

    const taskResult = await runTask(config, task, ctx, state, projectDir, persist);

    state.tasks[task.id] = taskResult;
    state.totalCostUsd += taskResult.costUsd;

    if (taskResult.status === "completed") {
      state.tasksCompleted.push(task.id);
      completedIds.add(task.id);
      ctx.display.onTaskEnd(task.id, true, taskResult.costUsd, 0);
      await sendNotify(config, "task_complete",
        `Task ${task.id} completed ($${taskResult.costUsd.toFixed(2)})`, task.id);
    } else {
      state.tasksFailed.push(task.id);
      ctx.display.onTaskEnd(task.id, false, taskResult.costUsd, 0);
      state.status = "failed";
      state.currentTaskId = null;
      ctx.display.onBuildEnd(state.tasksCompleted.length, state.totalCostUsd, 0);
      await sendNotify(config, "build_complete",
        `Build ${config.name} failed on task ${task.id}: ${taskResult.stopReason ?? "unknown"}`, task.id);
      await persist();
      return state;
    }
    await persist();

    // Check for new tasks added to the task file
    await checkForNewTasks(options, taskQueue, seenIds, completedIds, state, ctx.display);
    await persist();
  }

  // Report blocked tasks remaining in queue
  if (taskQueue.length > 0) {
    for (const blocked of taskQueue) {
      state.tasksFailed.push(blocked.id);
      state.tasks[blocked.id] = makeTaskState(blocked, "skipped", "dependency not met");
    }
    ctx.display.onText(`${taskQueue.length} task(s) blocked: [${taskQueue.map(t => t.id).join(", ")}]`);
  }

  state.status = taskQueue.length > 0 ? "failed" : "completed";
  state.currentTaskId = null;
  ctx.display.onBuildEnd(state.tasksCompleted.length, state.totalCostUsd, 0);
  await sendNotify(config, "build_complete",
    `Build ${config.name} completed — ${state.tasksCompleted.length} tasks, $${state.totalCostUsd.toFixed(2)}`);
  await persist();
  return state;
}

// ---------------------------------------------------------------------------
// Live task queue — re-read task file and append new tasks
// ---------------------------------------------------------------------------

export async function checkForNewTasks(
  options: LoopOptions,
  taskQueue: ResolvedTask[],
  seenIds: Set<string>,
  completedIds: Set<string>,
  state: BuildState,
  display: Display,
): Promise<void> {
  try {
    const freshTasks = await loadTasks(options.config, options.configPath);
    const resolved = resolveExecutionOrder(freshTasks);

    const newTasks: ResolvedTask[] = [];
    for (const task of resolved) {
      if (seenIds.has(task.id) || completedIds.has(task.id)) continue;

      // Validate dependencies: each dep must either exist in seenIds/completedIds
      // or be a known task ID from the fresh load
      const allFreshIds = new Set(resolved.map(t => t.id));
      const depsValid = task.depends_on.every(dep =>
        completedIds.has(dep) || seenIds.has(dep) || allFreshIds.has(dep)
      );
      if (!depsValid) continue;

      seenIds.add(task.id);
      newTasks.push(task);
    }

    if (newTasks.length > 0) {
      taskQueue.push(...newTasks);
      const ids = newTasks.map(t => t.id);
      display.onText(`Found ${newTasks.length} new task(s): [${ids.join(", ")}]`);

      const discoveredAt = new Date().toISOString();
      for (const t of newTasks) {
        state.tasksDiscovered!.push({ taskId: t.id, discoveredAt });
      }
    }
  } catch (err: any) {
    display.onText(`Warning: failed to re-read task file: ${err.message}`);
  }
}

// ---------------------------------------------------------------------------
// Single task runner
// ---------------------------------------------------------------------------

async function runTask(
  config: OrcaConfig,
  task: ResolvedTask,
  ctx: BuildContext,
  buildState: BuildState,
  projectDir: string,
  persist?: () => Promise<void>,
): Promise<TaskState> {
  const maxIterations = task.budget.max_iterations ?? config.budget?.max_iterations ?? 10;
  const maxCost = task.budget.max_cost ?? config.budget?.max_cost ?? 50;
  const stuckWindow = config.budget?.stuck_window ?? 3;

  const taskState: TaskState = {
    taskId: task.id,
    status: "running",
    currentStage: null,
    stageStartedAt: null,
    stageTurns: null,
    stageMaxTurns: null,
    iteration: 0,
    maxIterations,
    costUsd: 0,
    maxCost,
    stopReason: null,
    snapshots: [],
    history: [],
  };

  // Persist initial running state so monitors can show the task immediately
  buildState.tasks[task.id] = taskState;
  if (persist) await persist();

  // Session continuity — track session IDs per stage for resume across iterations
  const sessionIds: Record<string, string | null> = {};

  // Build event logger
  const buildLog = new BuildLog(projectDir);

  // Stage tracking helpers
  function setStage(name: string, maxTurns?: number) {
    taskState.currentStage = name;
    taskState.stageStartedAt = new Date().toISOString();
    taskState.stageTurns = null;
    taskState.stageMaxTurns = maxTurns ?? null;
  }
  function clearStage(numTurns?: number, durationMs?: number) {
    const stage = taskState.currentStage;
    if (stage) {
      buildLog.write("stage_end", {
        task: task.id,
        stage,
        iteration: taskState.iteration,
        turns: numTurns ?? null,
        duration_ms: durationMs ?? null,
      });
    }
    taskState.currentStage = null;
    taskState.stageStartedAt = null;
    taskState.stageTurns = numTurns ?? null;
    taskState.stageMaxTurns = null;
  }

  // Per-task data directory for file-based message passing between stages
  const taskDir = projectDir ? getTaskDir(projectDir, task.id) : null;
  if (taskDir) ensureTaskDir(projectDir, task.id);

  // Template vars — merge task variables + built-in vars
  const templateVars: Record<string, string> = buildTaskVars(
    task.id,
    task.title,
    task.variables,
    {
      name: config.name,
      project_dir: config.project_dir ?? ".",
      shared_data_dir: `${config.project_dir ?? "."}/tmp/${config.name}`,
      data_dir: ".orca",
      "orca.task_dir": taskDir ?? ".orca/tasks/" + task.id,
    },
  );

  // Helper to render a prompt with current orca vars and config-level injection
  function renderPrompt(raw: string, stageName?: string): string {
    // Prepend project-wide context
    const contextPrefix = config.prompts?.context ? config.prompts.context.trim() + "\n\n" : "";
    // Append per-stage context
    const stageSuffix = stageName && config.prompts?.stages?.[stageName]
      ? "\n\n" + config.prompts.stages[stageName].trim()
      : "";

    // Update orca built-in vars
    templateVars["orca.iteration"] = String(taskState.iteration);
    templateVars["orca.total_cost"] = taskState.costUsd.toFixed(2);
    templateVars["orca.budget_remaining"] = Math.max(0, currentMaxCost - taskState.costUsd).toFixed(2);
    templateVars["orca.max_iterations"] = String(currentMaxIterations);
    templateVars["orca.last_snapshot"] = taskState.snapshots.length > 0
      ? taskState.snapshots[taskState.snapshots.length - 1]
      : "";
    return applyVars(contextPrefix + raw + stageSuffix, templateVars);
  }

  // Mutable budget (may change via live config reload)
  let currentMaxIterations = maxIterations;
  let currentMaxCost = maxCost;

  // Resolve workflow for this task (per-task override or default)
  const workflow = resolveWorkflow(config, task);

  // --- Pre stages ---
  for (const stageName of workflow.pre ?? []) {
    const stageConfig = resolveStage(stageName, config, task);
    if (!evaluateCondition(stageConfig.condition, task, ctx)) continue;

    const rawPrompt = await ctx.loadPrompt(stageName, task.id) ?? "";
    const prompt = renderPrompt(rawPrompt, stageName);
    setStage(stageName, stageConfig.maxTurns);
    buildLog.write("stage_start", { task: task.id, stage: stageName, iteration: 0 });
    buildState.tasks[task.id] = taskState;
    if (persist) await persist();
    ctx.display.onStageStart(stageName, 0);
    try {
      const result = await invokeWithRetry(ctx, stageName, {
        prompt,
        taskId: task.id,
        toolset: stageConfig.toolset,
        maxTurns: stageConfig.maxTurns,
        model: stageConfig.model,
        scope: stageConfig.scope,
        sessionId: sessionIds[stageName] ?? undefined,
      }, config);
      taskState.costUsd += result.costUsd;
      if (result.sessionId) sessionIds[stageName] = result.sessionId;
      if (projectDir) writeStageOutput(projectDir, task.id, stageName, result.output);
      clearStage(result.numTurns, result.durationMs);
      ctx.display.onStageEnd(stageName, 0, result.costUsd, 0, "done");
    } catch (err: any) {
      clearStage();
      ctx.display.onStageEnd(stageName, 0, 0, 0, `error: ${err.message}`);
      taskState.status = "failed";
      taskState.stopReason = `stage ${stageName} crashed: ${err.message}`;
      return taskState;
    }
  }

  // --- Iteration loop ---
  const outputHashes: string[] = [];
  let passed = false;

  outer:
  while (true) {
    // Live config reload
    const liveConfig = await ctx.readLiveConfig();
    if (liveConfig) {
      if (liveConfig.max_iterations !== undefined) currentMaxIterations = liveConfig.max_iterations;
      if (liveConfig.max_cost !== undefined) currentMaxCost = liveConfig.max_cost;
    }

    // Budget checks
    if (taskState.iteration >= currentMaxIterations) {
      taskState.stopReason = `max iterations (${currentMaxIterations})`;
      break;
    }
    if (taskState.costUsd >= currentMaxCost) {
      taskState.stopReason = `cost exceeded ($${taskState.costUsd.toFixed(2)}/$${currentMaxCost})`;
      break;
    }

    // Budget warning notification
    const budgetThreshold = config.notifications?.on_budget_warning;
    if (budgetThreshold && currentMaxCost > 0) {
      const fraction = taskState.costUsd / currentMaxCost;
      // Fire once when crossing threshold (check previous iteration wasn't already past it)
      const prevCost = taskState.iteration > 0
        ? (taskState.history[taskState.history.length - 1]?.costUsd ?? 0)
        : 0;
      const prevFraction = prevCost / currentMaxCost;
      if (fraction >= budgetThreshold && prevFraction < budgetThreshold) {
        await sendNotify(config, "budget_warning",
          `Task ${task.id}: ${Math.round(fraction * 100)}% of budget used ($${taskState.costUsd.toFixed(2)}/$${currentMaxCost})`,
          task.id);
      }
    }

    // Run loop stages
    for (const stageName of workflow.loop) {
      const stageConfig = resolveStage(stageName, config, task);

      if (stageConfig.type === "eval") {
        // Run eval — use stage's own command/parser if defined, else task eval config
        const evalConfig: EvalConfig = stageConfig.command
          ? { command: stageConfig.command, parser: stageConfig.parser as EvalConfig["parser"], timeout: stageConfig.wait_timeout }
          : { ...config.eval, ...task.eval };
        setStage("eval");
        buildLog.write("stage_start", { task: task.id, stage: "eval", iteration: taskState.iteration });
        buildState.tasks[task.id] = taskState;
        if (persist) await persist();
        ctx.display.onStageStart("eval", taskState.iteration);
        const evalStartMs = Date.now();
        const evalResult = await ctx.eval(evalConfig, task.id, templateVars);
        clearStage(0, Date.now() - evalStartMs);
        if (projectDir) writeEvalOutput(projectDir, task.id, evalResult, evalResult.output);
        ctx.display.onStageEnd("eval", taskState.iteration, 0, 0, evalResult.all_passed ? "PASS" : "FAIL");
        ctx.display.onEval(evalResult.all_passed ? "PASS" : "FAIL");

        if (evalResult.all_passed) {
          // Run post-stages as verification gate
          let postPassed = true;
          for (const postStageName of workflow.post ?? []) {
            const postConfig = resolveStage(postStageName, config, task);

            // Command stage in post — run shell command, fail on non-zero exit
            if (postConfig.command) {
              templateVars["orca.iteration"] = String(taskState.iteration);
              templateVars["orca.total_cost"] = taskState.costUsd.toFixed(2);
              const interpolatedCommand = applyVars(postConfig.command, templateVars);
              const interpolatedWaitFor = postConfig.wait_for ? applyVars(postConfig.wait_for, templateVars) : undefined;
              const waitTimeout = postConfig.wait_timeout ?? 120;

              setStage(postStageName);
              buildLog.write("stage_start", { task: task.id, stage: postStageName, iteration: taskState.iteration });
              buildState.tasks[task.id] = taskState;
              if (persist) await persist();
              ctx.display.onStageStart(postStageName, taskState.iteration);

              const cmdResult = await runCommandStage(interpolatedCommand, interpolatedWaitFor, waitTimeout);
              clearStage(0, cmdResult.durationMs);

              if (!cmdResult.success) {
                ctx.display.onStageEnd(postStageName, taskState.iteration, 0, 0, `FAIL: ${cmdResult.output.slice(0, 100)}`);
                postPassed = false;
                break;
              }
              ctx.display.onStageEnd(postStageName, taskState.iteration, 0, 0, "done");
              continue;
            }

            // Agent stage in post — invoke Claude, gate on status: "passed"
            const rawPostPrompt = await ctx.loadPrompt(postStageName, task.id) ?? "";
            const postPrompt = renderPrompt(rawPostPrompt, postStageName);
            setStage(postStageName, postConfig.maxTurns);
            buildLog.write("stage_start", { task: task.id, stage: postStageName, iteration: taskState.iteration });
            buildState.tasks[task.id] = taskState;
            if (persist) await persist();
            ctx.display.onStageStart(postStageName, taskState.iteration);
            try {
              const postResult = await invokeWithRetry(ctx, postStageName, {
                prompt: postPrompt,
                taskId: task.id,
                toolset: postConfig.toolset,
                maxTurns: postConfig.maxTurns,
              }, config);
              taskState.costUsd += postResult.costUsd;
              clearStage(postResult.numTurns, postResult.durationMs);
              if (projectDir) writeStageOutput(projectDir, task.id, postStageName, postResult.output);
              ctx.display.onStageEnd(postStageName, taskState.iteration, postResult.costUsd, 0, "done");

              // Check if post-stage reported failure or returned no output
              // Null output or missing status is treated as failure — post-stages must
              // explicitly return status: "passed" to pass the gate.
              const postStatus = postResult.output?.status;
              if (postStatus !== "passed") {
                const reason = postStatus === "failed"
                  ? `FAILED: ${(postResult.output?.issues as string ?? postResult.output?.summary ?? "no details").toString().slice(0, 100)}`
                  : "FAILED: no structured output returned";
                ctx.display.onStageEnd(postStageName, taskState.iteration, postResult.costUsd, 0, reason);
                postPassed = false;
                break;
              }
            } catch (err: any) {
              clearStage();
              ctx.display.onStageEnd(postStageName, taskState.iteration, 0, 0, `error: ${err.message}`);
              postPassed = false;
              break;
            }
          }

          if (postPassed) {
            passed = true;
            break outer;
          }
          // Post-stage failed — continue the iteration loop
          ctx.display.onEval("POST_FAIL");
          continue outer;
        }
      } else if (stageConfig.type === "command") {
        // Command stage — run shell command without invoking Claude
        templateVars["orca.iteration"] = String(taskState.iteration);
        templateVars["orca.total_cost"] = taskState.costUsd.toFixed(2);

        const interpolatedCommand = applyVars(stageConfig.command!, templateVars);
        const interpolatedWaitFor = stageConfig.wait_for ? applyVars(stageConfig.wait_for, templateVars) : undefined;
        const waitTimeout = stageConfig.wait_timeout ?? 120;

        setStage(stageName);
        buildLog.write("stage_start", { task: task.id, stage: stageName, iteration: taskState.iteration });
        buildState.tasks[task.id] = taskState;
        if (persist) await persist();
        ctx.display.onStageStart(stageName, taskState.iteration);

        const cmdResult = await runCommandStage(interpolatedCommand, interpolatedWaitFor, waitTimeout);
        clearStage(0, cmdResult.durationMs);

        if (!cmdResult.success) {
          ctx.display.onStageEnd(stageName, taskState.iteration, 0, 0, `FAIL: ${cmdResult.output.slice(0, 100)}`);
          if (stageConfig.gate) {
            // Gate failure — restart the loop
            ctx.display.onEval("GATE_FAIL");
            continue outer;
          }
          taskState.status = "failed";
          taskState.stopReason = `command stage ${stageName} failed: ${cmdResult.output.slice(0, 200)}`;
          return taskState;
        }

        ctx.display.onStageEnd(stageName, taskState.iteration, 0, 0, "done");
        continue;

      } else {
        // Agent stage — invoke Claude

        // Git snapshot before this stage if configured
        if (config.git?.enabled && config.git.snapshot_before === stageName) {
          const hash = await ctx.snapshot(`before ${task.id} iter ${taskState.iteration + 1}`);
          if (hash) taskState.snapshots.push(hash);
        }

        const rawLoopPrompt = await ctx.loadPrompt(stageName, task.id) ?? "";
        // If no project-level prompt found and builtin differs, try builtin name
        const effectivePrompt = rawLoopPrompt || (stageConfig.builtin ? (await ctx.loadPrompt(stageConfig.builtin, task.id) ?? "") : "");
        const prompt = renderPrompt(effectivePrompt || `Prompt for ${stageName}`, stageName);
        setStage(stageName, stageConfig.maxTurns);
        buildLog.write("stage_start", { task: task.id, stage: stageName, iteration: taskState.iteration });
        buildState.tasks[task.id] = taskState;
        if (persist) await persist();
        ctx.display.onStageStart(stageName, taskState.iteration);
        let result;
        try {
          result = await invokeWithRetry(ctx, stageName, {
            prompt,
            taskId: task.id,
            toolset: stageConfig.toolset,
            maxTurns: stageConfig.maxTurns,
            model: stageConfig.model,
            scope: stageConfig.scope,
            sessionId: sessionIds[stageName] ?? undefined,
          }, config);
        } catch (err: any) {
          clearStage();
          ctx.display.onStageEnd(stageName, taskState.iteration, 0, 0, `error: ${err.message}`);
          taskState.status = "failed";
          taskState.stopReason = `stage ${stageName} crashed: ${err.message}`;
          return taskState;
        }
        taskState.costUsd += result.costUsd;
        clearStage(result.numTurns, result.durationMs);
        if (result.sessionId) sessionIds[stageName] = result.sessionId;
        if (projectDir) writeStageOutput(projectDir, task.id, stageName, result.output);
        ctx.display.onStageEnd(stageName, taskState.iteration, result.costUsd, 0, "done");

        // Gate check — if this stage requires status: "passed", restart loop on failure
        if (stageConfig.gate) {
          const gateStatus = result.output?.status;
          if (gateStatus !== "passed") {
            const reason = gateStatus === "failed"
              ? `GATE_FAIL: ${(result.output?.issues as string ?? result.output?.summary ?? "no details").toString().slice(0, 100)}`
              : "GATE_FAIL: no status returned";
            ctx.display.onStageEnd(stageName, taskState.iteration, result.costUsd, 0, reason);
            ctx.display.onEval("GATE_FAIL");
            continue outer;
          }
        }

        // Track output hash for stuck detection
        const hash = hashOutput(result.output);
        if (hash) outputHashes.push(hash);

        // Check escalation
        if (stageConfig.escalation && stageConfig.supervisor && result.output) {
          const escalation = extractEscalation(result.output);
          const isStuck = detectStuck(outputHashes, stuckWindow);

          if (escalation || isStuck) {
            ctx.display.onEscalation(
              escalation?.cause ?? "stuck",
              escalation?.diagnosis ?? "Identical outputs detected",
            );

            // Invoke supervisor — inject escalation context as vars
            const rawSupPrompt = await ctx.loadPrompt("supervisor", task.id) ?? "";
            templateVars["orca.escalation_cause"] = escalation?.cause ?? "stuck";
            templateVars["orca.escalation_diagnosis"] = escalation?.diagnosis ?? "Identical outputs detected";
            templateVars["orca.escalation_evidence"] = escalation?.evidence ?? "";
            templateVars["orca.escalation_suggested_fix"] = escalation?.suggestedFix ?? "";
            const supPrompt = renderPrompt(rawSupPrompt, "supervisor");
            let supResult;
            try {
              supResult = await invokeWithRetry(ctx, "supervisor", {
                prompt: supPrompt,
                taskId: task.id,
                toolset: config.supervisor?.toolset ?? "all",
                maxTurns: config.supervisor?.max_turns ?? 40,
              }, config);
            } catch (err: any) {
              // Supervisor crash — treat as escalate_human
              ctx.display.onStageEnd("supervisor", taskState.iteration, 0, 0, `error: ${err.message}`);
              taskState.status = "failed";
              taskState.stopReason = `supervisor crashed: ${err.message}`;
              return taskState;
            }
            taskState.costUsd += supResult.costUsd;

            const decision = parseSupervisorOutput(supResult.output);
            ctx.display.onSupervisorDecision(decision.action, decision.reasoning);

            // Notify on escalation
            await sendNotify(config, "escalation",
              `Escalation on ${task.id}: ${escalation?.cause ?? "stuck"} — ${escalation?.diagnosis ?? "identical outputs"}`,
              task.id);

            if (shouldStop(decision)) {
              // Intervention protocol: pause and wait for human
              const orcaDir = projectDir ? getOrcaDir(projectDir) : null;
              if (orcaDir) {
                await writeIntervention(orcaDir, {
                  timestamp: now(),
                  taskId: task.id,
                  cause: escalation?.cause ?? "stuck",
                  diagnosis: escalation?.diagnosis ?? "Identical outputs detected",
                  evidence: escalation?.evidence,
                  suggestedFix: escalation?.suggestedFix,
                  supervisorReasoning: decision.reasoning,
                });
                await sendNotify(config, "intervention",
                  `Build ${config.name} paused — human intervention needed for ${task.id}`,
                  task.id, decision.reasoning);

                buildState.status = "paused";
                if (persist) await persist();

                const response = await pollForResponse(orcaDir);
                await clearIntervention(orcaDir);

                buildState.status = "running";

                if (response.action === "abort") {
                  taskState.stopReason = `human aborted: ${response.note ?? ""}`;
                  break outer;
                }
                if (response.action === "skip") {
                  taskState.stopReason = `human skipped: ${response.note ?? ""}`;
                  taskState.status = "skipped";
                  break outer;
                }
                // action === "continue" — resume the loop
                taskState.iteration++;
                buildState.tasks[task.id] = taskState;
                if (persist) await persist();
                continue outer;
              }

              // No projectDir — can't write intervention files, just stop
              taskState.stopReason = `escalated: ${decision.escalationMessage ?? decision.reasoning}`;
              break outer;
            }

            if (decision.action === "revert") {
              if (taskState.snapshots.length > 0) {
                await ctx.revert(taskState.snapshots[taskState.snapshots.length - 1]);
                ctx.display.onRevert(taskState.snapshots[taskState.snapshots.length - 1].slice(0, 8));
              }
            }

            if (decision.action === "clear_session") {
              // Clear all stored session IDs so next iteration starts fresh
              for (const key of Object.keys(sessionIds)) {
                sessionIds[key] = null;
              }
              ctx.display.onSessionCleared();
            }

            // Retry actions continue the loop
            if (shouldRetry(decision)) {
              taskState.iteration++;
              buildState.tasks[task.id] = taskState;
              buildState.totalCostUsd += taskState.costUsd;
              if (persist) await persist();
              continue outer;
            }
          }
        }
      }
    }

    taskState.iteration++;
    // Persist state after each iteration so monitors can track progress
    buildState.tasks[task.id] = taskState;
    if (persist) await persist();
  }

  // --- Post-loop ---
  if (passed) {
    // Git commit (post-stages already ran inside the loop)
    if (config.git?.enabled && config.git.commit_after) {
      const message = renderTemplate(
        config.git.commit_message ?? "{name}: {task_id} complete",
        templateVars,
      );
      const hash = await ctx.commit(message);
      if (hash) ctx.display.onCommit(hash.slice(0, 8), message);
    }

    taskState.status = "completed";
  } else {
    taskState.status = "failed";
  }

  return taskState;
}

// ---------------------------------------------------------------------------
// Supervisor output parsing
// ---------------------------------------------------------------------------

interface SupervisorOutput {
  action: string;
  reasoning: string;
  details?: string;
  escalationMessage?: string;
}

function parseSupervisorOutput(output: Record<string, unknown> | null): SupervisorOutput {
  if (!output) return { action: "escalate_human", reasoning: "No supervisor output" };
  return {
    action: (output.action as string) ?? "escalate_human",
    reasoning: (output.reasoning as string) ?? "",
    details: output.details as string | undefined,
    escalationMessage: (output.escalation_message ?? output.escalationMessage) as string | undefined,
  };
}

// ---------------------------------------------------------------------------
// Task state factory
// ---------------------------------------------------------------------------

function makeTaskState(task: ResolvedTask, status: TaskState["status"], stopReason?: string): TaskState {
  return {
    taskId: task.id,
    status,
    currentStage: null,
    stageStartedAt: null,
    stageTurns: null,
    stageMaxTurns: null,
    iteration: 0,
    maxIterations: task.budget.max_iterations ?? 10,
    costUsd: 0,
    maxCost: task.budget.max_cost ?? 50,
    stopReason: stopReason ?? null,
    snapshots: [],
    history: [],
  };
}

