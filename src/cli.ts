#!/usr/bin/env bun
/**
 * Orca CLI — declarative build orchestrator for Claude Code agents.
 */

import { VERSION } from "./version";

import { existsSync, readFileSync, readdirSync, writeFileSync, mkdirSync, unlinkSync, openSync } from "fs";
import { resolve, join, dirname } from "path";
import * as yaml from "js-yaml";
import { validateConfig, loadTasks } from "./config/loader";
import { validateDependencies, filterTasks } from "./config/tasks";
import { getOrcaDir, saveState } from "./state";
import type { OrcaConfig } from "./config/schema";
import type { BuildState } from "./state";
import { runBuild } from "./engine/loop";
import { createBuildContext } from "./engine/context";
import { PrintDisplay } from "./display/print";
import { TuiDisplay } from "./display/tui";

// ---------------------------------------------------------------------------
// Embedded templates (compiled into binary, no filesystem dependency)
// ---------------------------------------------------------------------------

import tplGeneric from "../templates/generic.yaml";
import tplMetricOptimizer from "../templates/metric-optimizer.yaml";
import tplRustLibrary from "../templates/rust-library.yaml";
import tplRustMaintainer from "../templates/rust-maintainer.yaml";

const TEMPLATES: Record<string, string> = {
  "generic": tplGeneric,
  "metric-optimizer": tplMetricOptimizer,
  "rust-library": tplRustLibrary,
  "rust-maintainer": tplRustMaintainer,
};

// ---------------------------------------------------------------------------
// Command: help
// ---------------------------------------------------------------------------

function printUsage() {
  console.log(`
orca v${VERSION} — declarative build orchestrator for Claude Code agents

Commands:
  run <config>       Run a build (resumes from prior state if available)
  monitor <config>   Watch a running build (web UI)
  serve              Start HTTP server for managing builds via REST + SSE
  status <config>    Show build status
  abort <config>     Stop a running build
  init               Scaffold a new project.orca.yaml
  validate <config>  Validate config without running

Serve options:
  --port <port>      HTTP port (default: 7070)
  --data-dir <dir>   Directory for cloned repos and build state

Run options:
  --fresh            Ignore prior state, start all tasks from scratch
  --detach           Run in background (detached process)
  --monitor          Start web monitor alongside the build
  --task <id>        Run a single task
  --from <id>        Run all tasks starting from this one
  --tag <tag>        Filter tasks by tag
  --skip-tag <tag>   Exclude tasks with tag

Other options:
  --json             Machine-readable output (for status)
  --template <name>  Template for init (rust-library, rust-maintainer, metric-optimizer, generic)

Aliases:
  build              Same as 'run --fresh'
  resume             Same as 'run'
`);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Check if a PID is alive. */
function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * If state says "running" but the detached process is dead, return "crashed".
 * No PID file + running state = crashed or aborted.
 * Also cleans up stale build.pid files.
 */
function resolveStatus(status: string, orcaDir: string): string {
  if (status !== "running") return status;
  const pidPath = join(orcaDir, "build.pid");
  if (!existsSync(pidPath)) return "crashed";
  const pid = parseInt(readFileSync(pidPath, "utf8").trim(), 10);
  if (isNaN(pid)) return status;
  if (!isProcessAlive(pid)) {
    try { unlinkSync(pidPath); } catch {}
    return "crashed";
  }
  return status;
}

/** Load and validate an orca config file. Returns [config, projectDir] or throws. */
function loadConfig(configPath: string): [OrcaConfig, string] {
  if (!existsSync(configPath)) {
    throw new Error(`File not found: ${configPath}`);
  }

  let raw: string;
  try {
    raw = readFileSync(configPath, "utf8");
  } catch (e: any) {
    throw new Error(`Cannot read file: ${e.message}`);
  }

  let data: unknown;
  try {
    data = yaml.load(raw);
  } catch (e: any) {
    throw new Error(`Invalid YAML: ${e.message}`);
  }

  if (!validateConfig(data)) {
    throw new Error("Invalid config.");
  }

  const config = data as OrcaConfig;
  const projectDir = resolve(dirname(configPath), config.project_dir ?? ".");
  return [config, projectDir];
}

/** Find the latest run state for a build, if any. */
function findLatestState(orcaDir: string, buildName: string): BuildState | null {
  const runsDir = join(orcaDir, "runs", buildName);
  if (!existsSync(runsDir)) return null;

  const runDirs = readdirSync(runsDir).sort();
  if (runDirs.length === 0) return null;

  const latestRunDir = join(runsDir, runDirs[runDirs.length - 1]);
  const statePath = join(latestRunDir, "state.json");
  if (!existsSync(statePath)) return null;

  try {
    return JSON.parse(readFileSync(statePath, "utf8")) as BuildState;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Command: validate
// ---------------------------------------------------------------------------

function cmdValidate(configPath: string): number {
  try {
    const [config] = loadConfig(configPath);

    if (config.tasks.list) {
      for (const task of config.tasks.list) {
        if (!task.id) {
          console.error("Task missing 'id' field");
          return 1;
        }
      }
    }

    console.log(`Valid: ${config.name} (${config.tasks.list?.length ?? "external"} tasks)`);
    return 0;
  } catch (e: any) {
    console.error(e.message);
    return 1;
  }
}

// ---------------------------------------------------------------------------
// Command: init
// ---------------------------------------------------------------------------

function cmdInit(args: string[]): number {
  let templateName = "generic";
  const templateIdx = args.indexOf("--template");
  if (templateIdx !== -1 && args[templateIdx + 1]) {
    templateName = args[templateIdx + 1];
  }

  const content = TEMPLATES[templateName];
  if (!content) {
    console.error(`Unknown template: ${templateName}`);
    console.error(`Available: ${Object.keys(TEMPLATES).join(", ")}`);
    return 1;
  }

  const outPath = resolve("project.orca.yaml");

  if (existsSync(outPath)) {
    console.error(`project.orca.yaml already exists. Remove it first.`);
    return 1;
  }

  writeFileSync(outPath, content);
  console.log(`Created project.orca.yaml from template: ${templateName}`);

  const stagesDir = resolve("stages");
  if (!existsSync(stagesDir)) {
    mkdirSync(stagesDir, { recursive: true });
    console.log("Created stages/ directory");
  }

  return 0;
}

// ---------------------------------------------------------------------------
// Command: status
// ---------------------------------------------------------------------------

function cmdStatus(configPath: string, jsonOutput: boolean): number {
  let config: OrcaConfig;
  let projectDir: string;
  try {
    [config, projectDir] = loadConfig(configPath);
  } catch (e: any) {
    console.error(e.message);
    return 1;
  }

  const orcaDir = getOrcaDir(projectDir);
  const prevState = findLatestState(orcaDir, config.name);

  if (!prevState) {
    if (jsonOutput) {
      console.log(JSON.stringify({ status: "no builds", name: config.name }));
    } else {
      console.log(`${config.name}: no builds yet`);
    }
    return 0;
  }

  const status = resolveStatus(prevState.status, orcaDir);

  if (jsonOutput) {
    console.log(JSON.stringify({ ...prevState, status }, null, 2));
  } else {
    console.log(`${prevState.name}: ${status}`);
    console.log(`  Tasks: ${prevState.tasksCompleted?.length ?? 0} completed, ${prevState.tasksFailed?.length ?? 0} failed`);
    console.log(`  Cost: $${(prevState.totalCostUsd ?? 0).toFixed(2)}`);
    if (status === "crashed") {
      console.log(`  Build process died unexpectedly. Check .orca/build.log for details.`);
    } else if (prevState.currentTaskId) {
      const currentTask = prevState.tasks?.[prevState.currentTaskId];
      const stageInfo = currentTask?.currentStage ? ` (${currentTask.currentStage})` : "";
      console.log(`  Current: ${prevState.currentTaskId}${stageInfo}`);
    }
  }

  return 0;
}

// ---------------------------------------------------------------------------
// Command: run (unified build/resume)
// ---------------------------------------------------------------------------

async function cmdRun(configPath: string, args: string[]): Promise<number> {
  const hasMonitor = args.includes("--monitor");
  const hasDetach = args.includes("--detach");
  const hasFresh = args.includes("--fresh");

  if (hasMonitor && hasDetach) {
    console.error("Error: --monitor and --detach are incompatible. The monitor requires a foreground process.");
    return 1;
  }

  // Strip consumed flags before other parsing
  args = args.filter(a => a !== "--monitor" && a !== "--fresh");

  let config: OrcaConfig;
  let projectDir: string;
  try {
    [config, projectDir] = loadConfig(configPath);
  } catch (e: any) {
    console.error(e.message);
    return 1;
  }

  // Handle --detach: re-exec as a detached child process
  if (hasDetach) {
    const orcaDir = getOrcaDir(projectDir);
    mkdirSync(orcaDir, { recursive: true });
    const logPath = join(orcaDir, "build.log");

    const childArgs = process.argv.slice(2).filter(a => a !== "--detach");
    const logFd = openSync(logPath, "w");
    const proc = Bun.spawn(["orca", ...childArgs], {
      stdin: "ignore",
      stdout: logFd,
      stderr: logFd,
      env: { ...process.env, ORCA_DETACHED: "1" },
    });
    proc.unref();

    writeFileSync(join(orcaDir, "build.pid"), String(proc.pid));

    console.log(`\norca: build detached (PID ${proc.pid})`);
    console.log(`  Log:    ${logPath}`);
    console.log(`  Status: orca status ${configPath}\n`);
    return 0;
  }

  // Load tasks
  let tasks;
  try {
    tasks = await loadTasks(config, configPath);
  } catch (e: any) {
    console.error(`Error loading tasks: ${e.message}`);
    return 1;
  }

  const depErrors = validateDependencies(tasks);
  if (depErrors.length > 0) {
    for (const err of depErrors) console.error(`  ${err}`);
    return 1;
  }

  // Check for prior state (unless --fresh)
  let priorState: BuildState | null = null;
  if (!hasFresh) {
    const orcaDir = getOrcaDir(projectDir);
    priorState = findLatestState(orcaDir, config.name);
    if (priorState && priorState.tasksCompleted.length > 0) {
      const completedSet = new Set(priorState.tasksCompleted);
      const totalBefore = tasks.length;
      tasks = tasks.filter(t => !completedSet.has(t.id));

      if (tasks.length < totalBefore) {
        console.log(`\norca: resuming — ${priorState.tasksCompleted.length} tasks already completed, ${tasks.length} remaining`);
      }
    }
  }

  // Apply filters: --task, --from, --tag, --skip-tag
  const taskIdFilter = args.find((_, i, a) => a[i - 1] === "--task");
  if (taskIdFilter) {
    tasks = tasks.filter(t => t.id === taskIdFilter);
    if (tasks.length === 0) {
      console.error(`Unknown task: ${taskIdFilter}`);
      return 1;
    }
  }

  const fromFilter = args.find((_, i, a) => a[i - 1] === "--from");
  if (fromFilter) {
    // Find the task in the full list (including those filtered by prior state)
    const allTasks = await loadTasks(config, configPath);
    const idx = allTasks.findIndex(t => t.id === fromFilter);
    if (idx === -1) {
      console.error(`Unknown task: ${fromFilter}`);
      return 1;
    }
    // Keep only tasks at or after this position that aren't already completed
    const fromIds = new Set(allTasks.slice(idx).map(t => t.id));
    tasks = tasks.filter(t => fromIds.has(t.id));
  }

  const tagFilter = args.filter((_, i, a) => a[i - 1] === "--tag");
  const skipTagFilter = args.filter((_, i, a) => a[i - 1] === "--skip-tag");
  if (tagFilter.length > 0 || skipTagFilter.length > 0) {
    tasks = filterTasks(
      tasks,
      tagFilter.length > 0 ? tagFilter : undefined,
      skipTagFilter.length > 0 ? skipTagFilter : undefined,
    );
  }

  if (tasks.length === 0) {
    console.log("No tasks to run.");
    return 0;
  }

  // Ensure .orca is in .gitignore
  const gitignorePath = join(projectDir, ".gitignore");
  try {
    if (existsSync(gitignorePath)) {
      const content = readFileSync(gitignorePath, "utf8");
      if (!content.split("\n").some(line => line.trim() === ".orca" || line.trim() === ".orca/")) {
        writeFileSync(gitignorePath, content.trimEnd() + "\n.orca/\n");
      }
    } else {
      writeFileSync(gitignorePath, ".orca/\n");
    }
  } catch {}

  // Build context
  const isTTY = process.stdout.isTTY;
  const display = isTTY ? new TuiDisplay() : new PrintDisplay();
  const ctx = createBuildContext({
    config,
    configPath: resolve(configPath),
    display,
  });

  // Start web monitor if --monitor
  if (hasMonitor) {
    const { startWebMonitor } = await import("./display/web");
    startWebMonitor(resolve(configPath));
  }

  // Run the build
  console.log(`\norca run: ${config.name} — ${tasks.length} tasks\n`);

  const state = await runBuild(
    { config, tasks, configPath: resolve(configPath), projectDir, priorState: priorState ?? undefined },
    ctx,
  );

  // Cleanup PID file if detached child
  if (process.env.ORCA_DETACHED) {
    const pidPath = join(getOrcaDir(projectDir), "build.pid");
    try { unlinkSync(pidPath); } catch {}
  }

  return state.status === "completed" ? 0 : 1;
}

// ---------------------------------------------------------------------------
// Command: abort
// ---------------------------------------------------------------------------

async function cmdAbort(configPath: string): Promise<number> {
  let config: OrcaConfig;
  let projectDir: string;
  try {
    [config, projectDir] = loadConfig(configPath);
  } catch (e: any) {
    console.error(e.message);
    return 1;
  }

  const orcaDir = getOrcaDir(projectDir);
  const pidPath = join(orcaDir, "build.pid");

  if (!existsSync(pidPath)) {
    console.error("No running build found (no .orca/build.pid)");
    return 1;
  }

  const pid = parseInt(readFileSync(pidPath, "utf8").trim(), 10);
  if (isNaN(pid)) {
    console.error("Invalid PID file");
    try { unlinkSync(pidPath); } catch {}
    return 1;
  }

  // Send SIGTERM
  try {
    process.kill(pid, "SIGTERM");
    console.log(`Sent SIGTERM to PID ${pid}`);
  } catch (e: any) {
    if (e.code === "ESRCH") {
      console.log(`Process ${pid} not running — cleaning up`);
      try { unlinkSync(pidPath); } catch {}
      const prevState = findLatestState(orcaDir, config.name);
      if (prevState && prevState.status === "running") {
        prevState.status = "failed";
        prevState.updatedAt = new Date().toISOString();
        const runsDir = join(orcaDir, "runs", config.name);
        const runDirs = readdirSync(runsDir).sort();
        if (runDirs.length > 0) {
          await saveState(join(runsDir, runDirs[runDirs.length - 1]), prevState);
        }
      }
      return 0;
    }
    console.error(`Failed to kill process: ${e.message}`);
    return 1;
  }

  // Wait up to 5 seconds for graceful shutdown
  for (let i = 0; i < 10; i++) {
    await Bun.sleep(500);
    try {
      process.kill(pid, 0);
    } catch {
      console.log("Build stopped");
      try { unlinkSync(pidPath); } catch {}
      return 0;
    }
  }

  // Force kill
  try {
    process.kill(pid, "SIGKILL");
    console.log(`Sent SIGKILL to PID ${pid}`);
  } catch {}
  try { unlinkSync(pidPath); } catch {}

  // Update state to failed
  const prevState = findLatestState(orcaDir, config.name);
  if (prevState && prevState.status === "running") {
    prevState.status = "failed";
    prevState.updatedAt = new Date().toISOString();
    const runsDir = join(orcaDir, "runs", config.name);
    const runDirs = readdirSync(runsDir).sort();
    if (runDirs.length > 0) {
      await saveState(join(runsDir, runDirs[runDirs.length - 1]), prevState);
    }
  }

  console.log("Build aborted");
  return 0;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const args = process.argv.slice(2);
  const command = args[0];

  if (!command || command === "--help" || command === "-h") {
    printUsage();
    process.exit(0);
  }

  if (command === "--version" || command === "-v") {
    console.log(`orca v${VERSION}`);
    process.exit(0);
  }

  let exitCode = 0;

  switch (command) {
    case "validate":
      if (!args[1]) {
        console.error("Usage: orca validate <config-file>");
        process.exit(1);
      }
      exitCode = cmdValidate(resolve(args[1]));
      break;

    case "init":
      exitCode = cmdInit(args.slice(1));
      break;

    case "status":
      if (!args[1]) {
        console.error("Usage: orca status <config-file>");
        process.exit(1);
      }
      exitCode = cmdStatus(resolve(args[1]), args.includes("--json"));
      break;

    case "run":
    case "resume":
      if (!args[1]) {
        console.error("Usage: orca run <config-file>");
        process.exit(1);
      }
      exitCode = await cmdRun(resolve(args[1]), args.slice(2));
      break;

    case "build":
      // Alias: build = run --fresh
      if (!args[1]) {
        console.error("Usage: orca build <config-file>");
        process.exit(1);
      }
      exitCode = await cmdRun(resolve(args[1]), ["--fresh", ...args.slice(2)]);
      break;

    case "monitor":
      if (!args[1]) {
        console.error("Usage: orca monitor <config-file>");
        process.exit(1);
      }
      const { startWebMonitor } = await import("./display/web");
      await startWebMonitor(resolve(args[1]));
      break;

    case "abort":
      if (!args[1]) {
        console.error("Usage: orca abort <config-file>");
        process.exit(1);
      }
      exitCode = await cmdAbort(resolve(args[1]));
      break;

    case "serve": {
      const { startServer } = await import("./server");
      const portIdx = args.indexOf("--port");
      const port = portIdx !== -1 && args[portIdx + 1] ? parseInt(args[portIdx + 1], 10) : 7070;
      const dataDirIdx = args.indexOf("--data-dir");
      const isRoot = process.getuid?.() === 0;
      const dataDir = dataDirIdx !== -1 && args[dataDirIdx + 1]
        ? resolve(args[dataDirIdx + 1])
        : isRoot ? "/data" : resolve("data");
      startServer({ port, dataDir });
      // Block until signal
      await new Promise<void>(() => {});
      break;
    }

    default:
      console.error(`Unknown command: ${command}`);
      printUsage();
      exitCode = 1;
      break;
  }

  process.exit(exitCode);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
