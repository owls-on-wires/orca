/**
 * Monitor — standalone read-only process that tails a build.
 *
 * Watches .orca/state.json and renders a dashboard.
 * Run via: orca monitor project.orca.yaml
 *
 * Separate from TuiDisplay — this reads from disk instead of
 * receiving events in-process.
 */

import { existsSync, readFileSync, watch, readdirSync, unlinkSync } from "fs";
import { join, resolve, dirname } from "path";
import * as yaml from "js-yaml";
import type { BuildState, TaskState } from "../state";
import { getOrcaDir } from "../state";

// ANSI helpers
const ESC = "\x1b";
const RESET = `${ESC}[0m`;
const BOLD = `${ESC}[1m`;
const DIM = `${ESC}[2m`;
const FG = {
  red: `${ESC}[31m`,
  green: `${ESC}[32m`,
  yellow: `${ESC}[33m`,
  cyan: `${ESC}[36m`,
} as const;

function bar(fraction: number, width: number): string {
  const filled = Math.round(Math.min(1, fraction) * width);
  return `${FG.cyan}${"█".repeat(filled)}${DIM}${"░".repeat(width - filled)}${RESET}`;
}

function formatDuration(seconds: number): string {
  if (seconds < 60) return `${Math.round(seconds)}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ${Math.round(seconds % 60)}s`;
  return `${Math.floor(seconds / 3600)}h ${Math.floor((seconds % 3600) / 60)}m`;
}

function renderState(state: BuildState) {
  const cols = process.stdout.columns || 80;
  const lines: string[] = [];

  // Header
  const status = state.status as string;
  const statusColor = status === "completed" ? FG.green
    : status === "failed" || status === "crashed" ? FG.red
    : status === "paused" ? FG.yellow
    : FG.cyan;
  lines.push(`${BOLD}${FG.cyan}${"─".repeat(cols)}${RESET}`);
  lines.push(`${BOLD}${FG.cyan}  ${state.name.toUpperCase()}${RESET}  ${statusColor}${status}${RESET}`);
  lines.push(`${BOLD}${FG.cyan}${"─".repeat(cols)}${RESET}`);

  // Summary
  const completed = state.tasksCompleted?.length ?? 0;
  const failed = state.tasksFailed?.length ?? 0;
  const total = Object.keys(state.tasks ?? {}).length || (completed + failed);
  lines.push(`  Tasks: ${completed} completed, ${failed} failed, ${total} total`);
  lines.push(`  Cost:  $${(state.totalCostUsd ?? 0).toFixed(2)}`);

  if (state.startedAt) {
    const elapsed = (Date.now() - new Date(state.startedAt).getTime()) / 1000;
    lines.push(`  Elapsed: ${formatDuration(elapsed)}`);
  }
  lines.push("");

  // Per-task status
  const taskEntries = Object.values(state.tasks ?? {}) as TaskState[];
  if (taskEntries.length > 0) {
    lines.push(`  ${BOLD}Tasks:${RESET}`);
    for (const task of taskEntries) {
      const icon = task.status === "completed" ? `${FG.green}✓`
        : task.status === "failed" ? `${FG.red}✗`
        : task.status === "running" ? `${FG.yellow}◉`
        : task.status === "skipped" ? `${DIM}⊘`
        : `${DIM}○`;
      const iterInfo = task.status === "running" || task.status === "failed"
        ? ` iter ${task.iteration}/${task.maxIterations}`
        : "";
      const costInfo = task.costUsd > 0 ? ` $${task.costUsd.toFixed(2)}` : "";
      const reason = task.stopReason ? ` — ${task.stopReason}` : "";
      lines.push(`  ${icon}${RESET} ${task.taskId}${iterInfo}${costInfo}${reason}`);
    }
    lines.push("");
  }

  // Current task
  if (state.currentTaskId) {
    const current = state.tasks?.[state.currentTaskId];
    if (current) {
      const barWidth = Math.max(10, Math.min(30, cols - 20));
      const iterFrac = current.maxIterations > 0 ? current.iteration / current.maxIterations : 0;
      const costFrac = current.maxCost > 0 ? current.costUsd / current.maxCost : 0;
      lines.push(`  ${BOLD}Current: ${state.currentTaskId}${RESET}`);
      lines.push(`    Iters:  ${bar(iterFrac, barWidth)}  ${current.iteration}/${current.maxIterations}`);
      lines.push(`    Budget: ${bar(costFrac, barWidth)}  $${current.costUsd.toFixed(2)}/$${current.maxCost.toFixed(0)}`);
    }
  }

  // Check for intervention
  // (caller checks the file and passes flag)

  // Render
  process.stdout.write(`${ESC}[H${ESC}[J`);
  process.stdout.write(lines.join("\n") + "\n");
}

export function startMonitor(configPath: string): Promise<void> {
  // Load config to find project dir and build name
  if (!existsSync(configPath)) {
    console.error(`File not found: ${configPath}`);
    process.exit(1);
  }

  const raw = readFileSync(configPath, "utf8");
  const config = yaml.load(raw) as { name: string; project_dir?: string };
  const projectDir = resolve(dirname(configPath), config.project_dir ?? ".");
  const orcaDir = getOrcaDir(projectDir);
  const runsDir = join(orcaDir, "runs", config.name);

  if (!existsSync(runsDir)) {
    console.log(`No builds found for ${config.name}`);
    console.log(`Watching ${runsDir} for new builds...`);
  }

  // Enter alternate screen
  process.stdout.write(`${ESC}[?1049h${ESC}[H`);

  // Return a promise that resolves on SIGINT/SIGTERM so the caller blocks
  return new Promise<void>((resolve) => {
    const cleanup = () => {
      process.stdout.write(`${ESC}[?1049l`);
      resolve();
    };
    process.on("SIGINT", cleanup);
    process.on("SIGTERM", cleanup);

    // Find and watch the latest run directory
    let lastState: BuildState | null = null;

    function refresh() {
      if (!existsSync(runsDir)) return;

      const runDirs = readdirSync(runsDir).sort();
      if (runDirs.length === 0) return;

      const latestDir = join(runsDir, runDirs[runDirs.length - 1]);
      const statePath = join(latestDir, "state.json");

      if (!existsSync(statePath)) return;

      try {
        const state = JSON.parse(readFileSync(statePath, "utf8")) as BuildState;

        // Detect crashed/aborted detached process
        if (state.status === "running") {
          const pidPath = join(orcaDir, "build.pid");
          if (!existsSync(pidPath)) {
            (state as any).status = "crashed";
          } else {
            const pid = parseInt(readFileSync(pidPath, "utf8").trim(), 10);
            if (!isNaN(pid)) {
              try { process.kill(pid, 0); } catch {
                (state as any).status = "crashed";
                try { unlinkSync(pidPath); } catch {}
              }
            }
          }
        }

        lastState = state;
        renderState(state);

        // Check for intervention
        const interventionPath = join(orcaDir, "intervention.json");
        if (existsSync(interventionPath)) {
          const req = JSON.parse(readFileSync(interventionPath, "utf8"));
          console.log("");
          console.log(`  ${BOLD}${FG.red}!! INTERVENTION NEEDED${RESET}`);
          console.log(`  ${FG.yellow}Task: ${req.taskId} — ${req.cause}${RESET}`);
          console.log(`  ${req.diagnosis}`);
        }
      } catch {
        // File being written — retry next cycle
      }
    }

    // Initial render
    refresh();

    // Watch for changes
    try {
      if (existsSync(runsDir)) {
        watch(runsDir, { recursive: true }, () => refresh());
      }
    } catch {
      // fs.watch not available — fall back to polling
    }

    // Poll as backup (fs.watch can be unreliable)
    setInterval(refresh, 2000);
  });
}
