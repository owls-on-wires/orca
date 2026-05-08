/**
 * Simple print-based display. No dependencies.
 */

import type { Display } from "./types";

export class PrintDisplay implements Display {
  onBuildStart(name: string, taskCount: number) {
    console.log(`\n${name} — ${taskCount} tasks`);
  }

  onBuildEnd(tasksCompleted: number, totalCost: number, elapsed: number) {
    console.log(`\nComplete: ${tasksCompleted} tasks, $${totalCost.toFixed(2)}, ${formatDuration(elapsed)}`);
  }

  onTaskStart(taskId: string, title: string, index: number, total: number) {
    console.log(`\n${"=".repeat(60)}`);
    console.log(`  TASK ${index}/${total}: ${title} (${taskId})`);
    console.log(`${"=".repeat(60)}`);
  }

  onTaskEnd(taskId: string, passed: boolean, cost: number, elapsed: number) {
    const status = passed ? "PASSED" : "FAILED";
    console.log(`  ${taskId}: ${status} ($${cost.toFixed(2)}, ${formatDuration(elapsed)})`);
  }

  onIteration(iteration: number, maxIterations: number, cost: number, maxCost: number) {
    console.log(`\n  Iteration ${iteration}/${maxIterations} ($${cost.toFixed(2)}/$${maxCost.toFixed(0)})`);
  }

  onStageStart(label: string, _iteration: number) {
    process.stdout.write(`    [${label}] running...`);
  }

  onStageEnd(label: string, _iteration: number, cost: number, duration: number, summary: string) {
    console.log(`\r    [${label}] done ($${cost.toFixed(2)}, ${formatDuration(duration)}) — ${summary}`);
  }

  onText(_text: string) {}
  onToolUse(_toolName: string, _toolInput: Record<string, unknown>) {}

  onEval(summary: string) { console.log(`    [eval] ${summary}`); }
  onEscalation(cause: string, diagnosis: string) { console.log(`    [escalation] ${cause}: ${diagnosis.slice(0, 120)}`); }
  onSupervisorDecision(action: string, reasoning: string) { console.log(`    [supervisor] ${action}: ${reasoning.slice(0, 120)}`); }
  onSessionCleared() { console.log(`    [session] cleared`); }

  onSnapshot(shortHash: string, message: string) { console.log(`    [git] snapshot ${shortHash}: ${message}`); }
  onRevert(shortHash: string) { console.log(`    [git] reverted to ${shortHash}`); }
  onCommit(shortHash: string, message: string) { console.log(`    [git] commit ${shortHash}: ${message}`); }

  onScopeViolation(toolName: string, filePath: string, scopeType: string) {
    console.log(`    [scope] VIOLATION: ${toolName}(${filePath}) — ${scopeType} not allowed`);
  }

  onConfigReloaded(changes: Record<string, [unknown, unknown]>) {
    const parts = Object.entries(changes).map(([k, [o, n]]) => `${k}: ${o}→${n}`);
    console.log(`    [config] reloaded: ${parts.join(", ")}`);
  }

  onIntervention(taskId: string, cause: string, message: string) {
    console.log(`\n  !! INTERVENTION NEEDED: ${taskId} — ${cause}`);
    console.log(`     ${message}`);
  }
}

function formatDuration(seconds: number): string {
  if (seconds < 60) return `${Math.round(seconds)}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ${Math.round(seconds % 60)}s`;
  return `${Math.floor(seconds / 3600)}h ${Math.floor((seconds % 3600) / 60)}m`;
}
