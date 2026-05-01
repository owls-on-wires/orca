/**
 * TUI display — live terminal dashboard using raw ANSI.
 *
 * Renders a compact dashboard that updates in-place:
 * - Header with build name and task progress
 * - Budget/iteration progress bars
 * - Current stage indicator
 * - Color-coded live log
 *
 * No external dependencies — pure ANSI escape codes.
 */

import type { Display } from "./types";

// ---------------------------------------------------------------------------
// ANSI helpers
// ---------------------------------------------------------------------------

const ESC = "\x1b";
const RESET = `${ESC}[0m`;
const BOLD = `${ESC}[1m`;
const DIM = `${ESC}[2m`;

const FG = {
  red: `${ESC}[31m`,
  green: `${ESC}[32m`,
  yellow: `${ESC}[33m`,
  blue: `${ESC}[34m`,
  magenta: `${ESC}[35m`,
  cyan: `${ESC}[36m`,
  white: `${ESC}[37m`,
} as const;

function bar(fraction: number, width: number): string {
  const filled = Math.round(fraction * width);
  return `${FG.cyan}${"█".repeat(filled)}${DIM}${"░".repeat(width - filled)}${RESET}`;
}

function formatDuration(seconds: number): string {
  if (seconds < 60) return `${Math.round(seconds)}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ${Math.round(seconds % 60)}s`;
  return `${Math.floor(seconds / 3600)}h ${Math.floor((seconds % 3600) / 60)}m`;
}

function colorLine(line: string): string {
  if (line.startsWith("[stage]")) return `${FG.cyan}${line}${RESET}`;
  if (line.startsWith("[tool]")) return `${DIM}${line}${RESET}`;
  if (line.startsWith("[eval]")) return `${FG.blue}${line}${RESET}`;
  if (line.startsWith("[task] x") || line.startsWith("[FAIL]")) return `${FG.red}${line}${RESET}`;
  if (line.startsWith("[task] +") || line.startsWith("[PASS]")) return `${FG.green}${line}${RESET}`;
  if (line.startsWith("[escalation]")) return `${BOLD}${FG.yellow}${line}${RESET}`;
  if (line.startsWith("[supervisor]")) return `${FG.magenta}${line}${RESET}`;
  if (line.startsWith("[session]")) return `${DIM}${FG.cyan}${line}${RESET}`;
  if (line.startsWith("[git]")) return `${DIM}${FG.green}${line}${RESET}`;
  if (line.startsWith("[scope]")) return `${BOLD}${FG.red}${line}${RESET}`;
  if (line.startsWith("[config]")) return `${FG.yellow}${line}${RESET}`;
  if (line.startsWith("[!!]")) return `${BOLD}${FG.red}${line}${RESET}`;
  return `${DIM}${line}${RESET}`;
}

// ---------------------------------------------------------------------------
// TuiDisplay
// ---------------------------------------------------------------------------

const MAX_LOG_LINES = 15;

export class TuiDisplay implements Display {
  private name = "";
  private taskCount = 0;
  private currentTaskId = "";
  private currentTaskTitle = "";
  private currentTaskIndex = 0;

  private iteration = 0;
  private maxIterations = 0;
  private cost = 0;
  private maxCost = 0;

  private currentStage: string | null = null;
  private currentStageStart = 0;
  private prevStage: string | null = null;
  private prevStageSummary = "";

  private logLines: string[] = [];
  private startTime = Date.now();
  private refreshTimer: ReturnType<typeof setInterval> | null = null;

  private appendLog(line: string) {
    this.logLines.push(line);
    if (this.logLines.length > MAX_LOG_LINES * 2) {
      this.logLines = this.logLines.slice(-MAX_LOG_LINES);
    }
  }

  private render() {
    const cols = process.stdout.columns || 80;
    const elapsed = (Date.now() - this.startTime) / 1000;
    const lines: string[] = [];

    // Header
    const header = ` ${this.name.toUpperCase()}  task ${this.currentTaskIndex}/${this.taskCount}`;
    lines.push(`${BOLD}${FG.cyan}${"─".repeat(cols)}${RESET}`);
    lines.push(`${BOLD}${FG.cyan}${header}${RESET}`);
    lines.push(`${BOLD}${FG.cyan}${"─".repeat(cols)}${RESET}`);

    // Budget bars
    const barWidth = Math.max(10, Math.min(30, cols - 20));
    const budgetFrac = this.maxCost > 0 ? this.cost / this.maxCost : 0;
    const iterFrac = this.maxIterations > 0 ? this.iteration / this.maxIterations : 0;
    lines.push(`  Budget:  ${bar(budgetFrac, barWidth)}  $${this.cost.toFixed(2)}/$${this.maxCost.toFixed(0)}`);
    lines.push(`  Iters:   ${bar(iterFrac, barWidth)}  ${this.iteration}/${this.maxIterations}`);
    lines.push(`  Elapsed: ${formatDuration(elapsed)}`);
    lines.push("");

    // Current stage
    if (this.currentStage) {
      const stageElapsed = (Date.now() - this.currentStageStart) / 1000;
      lines.push(`  ${FG.yellow}◉${RESET} ${BOLD}Running:${RESET} ${this.currentStage}  ${DIM}[${formatDuration(stageElapsed)}]${RESET}`);
    } else {
      lines.push(`  ${DIM}○ Idle${RESET}`);
    }
    if (this.prevStage) {
      lines.push(`  ${FG.green}✓${RESET} ${DIM}Previous: ${this.prevStage} — ${this.prevStageSummary}${RESET}`);
    }
    lines.push("");

    // Log
    const tail = this.logLines.slice(-MAX_LOG_LINES);
    for (const line of tail) {
      lines.push(`  ${colorLine(line)}`);
    }
    if (tail.length === 0) {
      lines.push(`  ${DIM}Waiting for output...${RESET}`);
    }

    // Render — move to top and overwrite
    process.stdout.write(`${ESC}[H${ESC}[J`);
    process.stdout.write(lines.join("\n") + "\n");
  }

  private startRefresh() {
    if (this.refreshTimer) return;
    // Enter alternate screen buffer
    process.stdout.write(`${ESC}[?1049h${ESC}[H`);
    this.refreshTimer = setInterval(() => this.render(), 500);
  }

  private stopRefresh() {
    if (this.refreshTimer) {
      clearInterval(this.refreshTimer);
      this.refreshTimer = null;
    }
    // Leave alternate screen buffer
    process.stdout.write(`${ESC}[?1049l`);
  }

  // --- Events ---

  onBuildStart(name: string, taskCount: number) {
    this.name = name;
    this.taskCount = taskCount;
    this.startTime = Date.now();
    this.startRefresh();
  }

  onBuildEnd(tasksCompleted: number, totalCost: number, elapsed: number) {
    this.stopRefresh();
    // Print final summary to normal screen
    console.log("");
    console.log(`${BOLD}${FG.cyan}${"─".repeat(40)}${RESET}`);
    console.log(`${BOLD}  ${this.name.toUpperCase()} COMPLETE${RESET}`);
    console.log(`${BOLD}${FG.cyan}${"─".repeat(40)}${RESET}`);
    console.log(`  Tasks:   ${tasksCompleted}/${this.taskCount}`);
    console.log(`  Cost:    $${totalCost.toFixed(2)}`);
    console.log(`  Elapsed: ${formatDuration(elapsed || (Date.now() - this.startTime) / 1000)}`);
    console.log("");
  }

  onTaskStart(taskId: string, title: string, index: number, total: number) {
    this.currentTaskId = taskId;
    this.currentTaskTitle = title;
    this.currentTaskIndex = index;
    this.taskCount = total;
    this.appendLog(`[task] ▶ ${title} (${taskId})`);
  }

  onTaskEnd(taskId: string, passed: boolean, cost: number, _elapsed: number) {
    const status = passed ? `${FG.green}+` : `${FG.red}x`;
    this.appendLog(`[task] ${status} ${taskId}${RESET} ($${cost.toFixed(2)})`);
  }

  onIteration(iteration: number, maxIterations: number, cost: number, maxCost: number) {
    this.iteration = iteration;
    this.maxIterations = maxIterations;
    this.cost = cost;
    this.maxCost = maxCost;
  }

  onStageStart(label: string, _iteration: number) {
    this.currentStage = label;
    this.currentStageStart = Date.now();
    this.appendLog(`[stage] ${label} started`);
  }

  onStageEnd(label: string, _iteration: number, cost: number, _duration: number, summary: string) {
    this.prevStage = label;
    this.prevStageSummary = summary;
    this.currentStage = null;
    this.cost += cost;
    this.appendLog(`[stage] ${label} done ($${cost.toFixed(2)})`);
  }

  onText(text: string) {
    for (const line of text.split("\n")) {
      const trimmed = line.trim();
      if (trimmed) this.appendLog(trimmed);
    }
  }

  onToolUse(toolName: string, toolInput: Record<string, unknown>) {
    const target = (toolInput.file_path ?? toolInput.pattern ?? toolInput.command ?? "") as string;
    this.appendLog(`[tool] ${toolName}(${target.slice(0, 60)})`);
  }

  onEval(summary: string) {
    this.appendLog(`[eval] ${summary}`);
  }

  onEscalation(cause: string, diagnosis: string) {
    this.appendLog(`[escalation] ${cause}: ${diagnosis.slice(0, 80)}`);
  }

  onSupervisorDecision(action: string, reasoning: string) {
    this.appendLog(`[supervisor] ${action}: ${reasoning.slice(0, 60)}`);
  }

  onSessionCleared() {
    this.appendLog("[session] cleared");
  }

  onSnapshot(shortHash: string, message: string) {
    this.appendLog(`[git] snapshot ${shortHash}: ${message}`);
  }

  onRevert(shortHash: string) {
    this.appendLog(`[git] reverted to ${shortHash}`);
  }

  onCommit(shortHash: string, message: string) {
    this.appendLog(`[git] commit ${shortHash}: ${message}`);
  }

  onScopeViolation(toolName: string, filePath: string, scopeType: string) {
    this.appendLog(`[scope] VIOLATION ${toolName}(${filePath}) — ${scopeType}`);
  }

  onConfigReloaded(changes: Record<string, [unknown, unknown]>) {
    const parts = Object.entries(changes).map(([k, [o, n]]) => `${k}: ${o}→${n}`);
    this.appendLog(`[config] reloaded: ${parts.join(", ")}`);
  }

  onIntervention(taskId: string, cause: string, message: string) {
    this.appendLog(`[!!] INTERVENTION: ${taskId} — ${cause}`);
    this.appendLog(`[!!] ${message}`);
  }
}
