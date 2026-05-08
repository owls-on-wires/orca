/**
 * Display event interface.
 * Implemented by TUI and print backends.
 */

export interface Display {
  onBuildStart(name: string, taskCount: number): void;
  onBuildEnd(tasksCompleted: number, totalCost: number, elapsed: number): void;

  onTaskStart(taskId: string, title: string, index: number, total: number): void;
  onTaskEnd(taskId: string, passed: boolean, cost: number, elapsed: number): void;

  onIteration(iteration: number, maxIterations: number, cost: number, maxCost: number): void;
  onStageStart(label: string, iteration: number): void;
  onStageEnd(label: string, iteration: number, cost: number, duration: number, summary: string): void;

  onText(text: string): void;
  onToolUse(toolName: string, toolInput: Record<string, unknown>): void;

  onEval(summary: string): void;
  onEscalation(cause: string, diagnosis: string): void;
  onSupervisorDecision(action: string, reasoning: string): void;
  onSessionCleared(): void;

  onSnapshot(shortHash: string, message: string): void;
  onRevert(shortHash: string): void;
  onCommit(shortHash: string, message: string): void;

  onScopeViolation(toolName: string, filePath: string, scopeType: string): void;
  onConfigReloaded(changes: Record<string, [unknown, unknown]>): void;

  onIntervention(taskId: string, cause: string, message: string): void;
}
