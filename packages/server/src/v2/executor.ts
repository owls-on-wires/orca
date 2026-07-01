/**
 * Serial scheduler / executor — drives the action graph one action at a time.
 */

import { createHash } from "crypto";
import { OrcaDatabase } from "./db";
import type { ActionConfig, EdgeCondition } from "./schema";
import {
  runAction as defaultRunAction,
  type ActionResult,
  type WaitingResult,
  type PredecessorOutput,
  type RunOptions,
} from "./action-runner";
import type { ScopeConfig } from "../config/schema";
import { handleSupervisorResult } from "./supervisor";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type RunActionFn = (
  action: ActionConfig,
  predecessorOutputs: PredecessorOutput[],
  options: RunOptions,
) => Promise<ActionResult | WaitingResult>;

export interface CircuitBreakerBreach {
  reason: "cost" | "size";
  total_cost: number;
  graph_size: number;
  limit: number;
}

export interface ExecutorOptions {
  projectDir: string;
  model?: string;
  scope?: ScopeConfig;
  runActionFn?: RunActionFn;
  /** Global circuit-breaker: halt if total cost across all actions reaches this. */
  maxTotalCost?: number;
  /** Global circuit-breaker: halt if the graph grows to this many actions. */
  maxGraphSize?: number;
  onActionStart?: (action: ActionConfig) => void;
  onActionEnd?: (action: ActionConfig, result: ActionResult) => void;
  onActionWaiting?: (action: ActionConfig) => void;
  onEdgeTraversed?: (from: string, to: string, condition: string) => void;
  onToolUse?: (action: ActionConfig, toolName: string, toolInput: Record<string, unknown>) => void;
  onUnhandledFailure?: (action: ActionConfig, condition: EdgeCondition) => void;
  /** Fired when the global circuit-breaker trips (cost or size). */
  onCircuitBreaker?: (breach: CircuitBreakerBreach) => void;
  onIdle?: () => void;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function hashOutput(output: unknown): string {
  const str = JSON.stringify(output ?? null);
  return createHash("sha256").update(str).digest("hex");
}

function isWaitingResult(r: ActionResult | WaitingResult): r is WaitingResult {
  return "waiting" in r && (r as WaitingResult).waiting === true;
}

// ---------------------------------------------------------------------------
// Executor
// ---------------------------------------------------------------------------

export class Executor {
  private db: OrcaDatabase;
  private options: ExecutorOptions;
  private _paused = false;
  private _idle = true;
  private _halted = false;
  private lastCompletedAction: string | null = null;
  private runActionFn: RunActionFn;

  constructor(db: OrcaDatabase, options: ExecutorOptions) {
    this.db = db;
    this.options = options;
    this.runActionFn = options.runActionFn ?? defaultRunAction;
  }

  pause(): void {
    this._paused = true;
  }

  resume(): void {
    this._paused = false;
  }

  isPaused(): boolean {
    return this._paused;
  }

  isIdle(): boolean {
    return this._idle;
  }

  isHalted(): boolean {
    return this._halted;
  }

  async run(): Promise<void> {
    this._idle = false;

    while (true) {
      // Global circuit-breaker: cap total cost + graph size. Checked before
      // any work so a breach halts the whole build and escalates, rather than
      // letting a runaway loop or an agent-driven graph explosion continue.
      if (this._halted) {
        this._idle = true;
        return;
      }
      const breach = this.checkCircuitBreaker();
      if (breach) {
        this._halted = true;
        this._idle = true;
        this.options.onCircuitBreaker?.(breach);
        return;
      }

      // Check pause flag
      if (this._paused) {
        this._idle = true;
        return;
      }

      // Step 1: Query for pending actions
      const pending = this.db.getReadyActions();

      // Step 2: If none pending → idle
      if (pending.length === 0) {
        this._idle = true;
        this.options.onIdle?.();
        return;
      }

      // Step 3: Pick one — chain preference
      const action = this.pickAction(pending);

      // Budget check: before running, compute total cost for the task
      if (this.checkBudget(action)) {
        const now = new Date().toISOString();
        this.db.updateAction(action.id, {
          status: "failed",
          output: { status: "cost_exceeded", summary: "Budget exceeded" },
          completed_at: now,
        });
        this.db.appendHistory(action.id, "completed", {
          condition: "cost_exceeded",
          output_hash: hashOutput({ status: "cost_exceeded", summary: "Budget exceeded" }),
        });
        this.followEdges(action, "cost_exceeded");
        continue;
      }

      // Step 4: Set status = running
      this.db.updateAction(action.id, {
        status: "running",
        started_at: new Date().toISOString(),
      });

      const runningAction = this.db.getAction(action.id)!;
      this.options.onActionStart?.(runningAction);

      // Step 5: Collect predecessor outputs
      const predecessorOutputs = this.collectPredecessorOutputs(action.id);

      // Step 6: Call runAction — resolve project config for projectDir, scope, model
      const project = runningAction.project_id
        ? this.db.getProject(runningAction.project_id)
        : null;

      const projectDir = project?.project_dir ?? this.options.projectDir;
      const logDir = projectDir + "/.orca/logs";
      const logPath = logDir + "/" + runningAction.id + ".jsonl";

      // Wall-clock timeout: configurable per action, default 10 minutes
      const wallTimeout = (runningAction.params.wall_timeout as number | undefined) ?? 600;
      const abortController = new AbortController();

      const runOptions: RunOptions = {
        projectDir,
        model: project?.model ?? this.options.model,
        scope: project?.scope as any ?? this.options.scope,
        nix: project?.nix ?? undefined,
        logPath,
        onToolUse: this.options.onToolUse
          ? (name, input) => this.options.onToolUse!(runningAction, name, input)
          : undefined,
        abortController,
      };

      const WALL_TIMEOUT_SENTINEL = Symbol("wall_timeout");
      const timeoutPromise = new Promise<typeof WALL_TIMEOUT_SENTINEL>((resolve) => {
        setTimeout(() => {
          abortController.abort();
          resolve(WALL_TIMEOUT_SENTINEL);
        }, wallTimeout * 1000);
      });

      const raceResult = await Promise.race([
        this.runActionFn(runningAction, predecessorOutputs, runOptions)
          .catch(() => WALL_TIMEOUT_SENTINEL), // if abort causes rejection, treat as timeout
        timeoutPromise,
      ]);

      if (raceResult === WALL_TIMEOUT_SENTINEL) {
        // Wall-clock timeout — classify as timeout condition
        const now = new Date().toISOString();
        this.db.updateAction(action.id, {
          status: "failed",
          output: { status: "timeout", summary: `Exceeded wall timeout (${wallTimeout}s)` },
          completed_at: now,
        });
        this.db.appendHistory(action.id, "completed", {
          condition: "timeout",
          output_hash: hashOutput({ status: "timeout" }),
        });
        this.options.onActionEnd?.(this.db.getAction(action.id)!, {
          condition: "timeout",
          output: { status: "timeout", summary: `Exceeded wall timeout (${wallTimeout}s)` },
          cost_usd: 0,
          duration_ms: wallTimeout * 1000,
          num_turns: 0,
        });
        this.lastCompletedAction = action.id;
        this.followEdges(action, "timeout");
        continue;
      }

      const result = raceResult as ActionResult | WaitingResult;

      // Step 7: WaitingResult
      if (isWaitingResult(result)) {
        this.db.updateAction(action.id, {
          status: "waiting",
          output: result.output,
        });
        this.options.onActionWaiting?.(this.db.getAction(action.id)!);
        continue;
      }

      // Step 8: ActionResult
      const actionResult = result as ActionResult;
      let condition = actionResult.condition;

      // Step 8a: Update action
      const finalStatus = condition === "pass" ? "completed" : "failed";
      this.db.updateAction(action.id, {
        status: finalStatus,
        output: actionResult.output,
        cost_usd: (runningAction.cost_usd ?? 0) + actionResult.cost_usd,
        completed_at: new Date().toISOString(),
      });

      // Step 8b: Append to history
      this.db.appendHistory(action.id, "completed", {
        condition,
        output: actionResult.output,
        cost_usd: actionResult.cost_usd,
        output_hash: hashOutput(actionResult.output),
      });

      // Supervisor handling: if action is tagged type:supervisor and passed
      if (condition === "pass" && action.tags.some((t) => t === "type:supervisor")) {
        const completedAction = this.db.getAction(action.id)!;
        if (completedAction.output) {
          try {
            handleSupervisorResult(this.db, completedAction.output, completedAction.id);
          } catch {
            // Supervisor errors should not crash the executor
          }
        }
      }

      // Stuck detection
      condition = this.checkStuck(action.id, condition);

      // Step 8c: Call onActionEnd
      this.options.onActionEnd?.(this.db.getAction(action.id)!, actionResult);

      // Track last completed for chain preference
      this.lastCompletedAction = action.id;

      // Step 8d-f: Route via edges
      this.followEdges(action, condition);
    }
  }

  /**
   * Complete a waiting action with the given output and follow edges.
   * Called by the server when POST /actions/:id/respond is received.
   */
  completeWaitingAction(actionId: string, output: { status: string; summary: string; [key: string]: unknown }): EdgeCondition {
    const action = this.db.getAction(actionId);
    if (!action) throw new Error(`Action not found: ${actionId}`);
    if (action.status !== "waiting") throw new Error(`Action is not waiting: ${actionId}`);

    // Map response status to edge condition
    const condition: EdgeCondition = output.status === "passed" || output.status === "approved" ? "pass" : "fail";

    this.db.updateAction(actionId, {
      status: condition === "pass" ? "completed" : "failed",
      output,
      completed_at: new Date().toISOString(),
    });

    this.db.appendHistory(actionId, "completed", {
      condition,
      output,
    });

    this.followEdges(action, condition);

    return condition;
  }

  // ── Private helpers ──

  private pickAction(pending: ActionConfig[]): ActionConfig {
    if (this.lastCompletedAction) {
      const edges = this.db.getEdgesFrom(this.lastCompletedAction);
      for (const edge of edges) {
        const successor = pending.find((a) => a.id === edge.to_action);
        if (successor) return successor;
      }
    }
    pending.sort((a, b) => a.created_at.localeCompare(b.created_at));
    return pending[0];
  }

  private collectPredecessorOutputs(actionId: string): PredecessorOutput[] {
    const incomingEdges = this.db.getEdgesTo(actionId);
    const outputs: PredecessorOutput[] = [];
    const seen = new Set<string>();

    for (const edge of incomingEdges) {
      if (seen.has(edge.from_action)) continue;
      seen.add(edge.from_action);
      const fromAction = this.db.getAction(edge.from_action);
      if (fromAction?.output) {
        outputs.push({ actionId: edge.from_action, output: fromAction.output });
      }
    }

    return outputs;
  }

  /**
   * Global circuit-breaker. Returns a breach descriptor when the whole-graph
   * cost or size cap is reached, otherwise null. Distinct from `checkBudget`,
   * which is a per-task cap; this is the last line of defense against a
   * runaway build (cost) or an agent that explodes the circuit (size).
   */
  private checkCircuitBreaker(): CircuitBreakerBreach | null {
    const { maxTotalCost, maxGraphSize } = this.options;
    if (maxTotalCost === undefined && maxGraphSize === undefined) return null;

    const raw = this.db.rawDb;
    const totalCost =
      (
        raw
          .query("SELECT COALESCE(SUM(cost_usd), 0) AS c FROM actions")
          .get() as { c: number }
      ).c;
    const graphSize =
      (raw.query("SELECT COUNT(*) AS n FROM actions").get() as { n: number }).n;

    if (maxTotalCost !== undefined && totalCost >= maxTotalCost) {
      return { reason: "cost", total_cost: totalCost, graph_size: graphSize, limit: maxTotalCost };
    }
    if (maxGraphSize !== undefined && graphSize >= maxGraphSize) {
      return { reason: "size", total_cost: totalCost, graph_size: graphSize, limit: maxGraphSize };
    }
    return null;
  }

  private checkBudget(action: ActionConfig): boolean {
    const taskTag = action.tags.find((t) => t.startsWith("task:"));
    if (!taskTag) return false;

    const maxCost = action.params.max_cost as number | undefined;
    if (maxCost === undefined) return false;

    // Sum cost_usd for all actions sharing this task tag
    const allTagged = this.db.listActions({ tag: taskTag });
    let totalCost = 0;
    for (const a of allTagged) {
      totalCost += a.cost_usd;
    }

    return totalCost >= maxCost;
  }

  private checkStuck(actionId: string, currentCondition: EdgeCondition): EdgeCondition {
    const stuckThreshold = 3;
    // Get recent history entries of type "completed" for this action
    const history = this.db.getHistory(actionId);
    const completions = history.filter((h) => h.event_type === "completed");

    if (completions.length < stuckThreshold) return currentCondition;

    // Take the most recent N completions (history is DESC order)
    const recent = completions.slice(0, stuckThreshold);
    const hashes = recent
      .map((h) => {
        const data = h.data as Record<string, unknown> | null;
        return data?.output_hash as string | undefined;
      })
      .filter((h): h is string => h !== undefined);

    if (hashes.length < stuckThreshold) return currentCondition;

    const allSame = hashes.every((h) => h === hashes[0]);
    if (allSame) {
      const stuckEdges = this.db.getEdgesByCondition(actionId, "stuck");
      if (stuckEdges.length > 0) {
        this.db.updateAction(actionId, {
          status: "failed",
          output: {
            status: "stuck",
            summary: `Action stuck: last ${stuckThreshold} outputs identical`,
          },
        });
        return "stuck";
      }
    }

    return currentCondition;
  }

  private followEdges(action: ActionConfig, condition: EdgeCondition): void {
    const matchingEdges = this.db.getEdgesByCondition(action.id, condition);

    // Global fallback: if no matching edges for a non-pass condition,
    // look for a supervisor action to escalate to.
    if (matchingEdges.length === 0 && condition !== "pass") {
      this.escalateToSupervisor(action, condition);
    }

    for (const edge of matchingEdges) {
      const target = this.db.getAction(edge.to_action);
      if (!target) continue;

      if (target.status === "inactive" || target.status === "completed" || target.status === "failed") {
        // Join semantics for inactive targets: ALL incoming edges must be
        // satisfied before activation. This handles diamond dependencies
        // (A→B, A→C, B→D, C→D — D waits for both B and C).
        //
        // Retry semantics for completed/failed targets: activate immediately
        // on any matching edge. This handles retry loops
        // (eval[fail]→develop — develop re-runs on any single failure).
        if (target.status === "inactive" && !this.allIncomingEdgesSatisfied(target.id)) {
          // Not all deps met yet — don't activate, just record the traversal
          this.options.onEdgeTraversed?.(action.id, edge.to_action, condition);
          continue;
        }

        const newIteration =
          target.status === "completed" || target.status === "failed"
            ? target.iteration + 1
            : target.iteration;

        // Check max_iterations (default: 10 to prevent infinite loops)
        const maxIterations = (target.params.max_iterations as number | undefined) ?? 10;
        if (newIteration >= maxIterations) {
          // Exceeded — follow cost_exceeded or stuck edges from the target
          const overrideEdges = [
            ...this.db.getEdgesByCondition(target.id, "cost_exceeded"),
            ...this.db.getEdgesByCondition(target.id, "stuck"),
          ];

          this.db.updateAction(target.id, {
            status: "failed",
            iteration: newIteration,
            output: {
              status: "max_iterations",
              summary: `Exceeded max iterations (${maxIterations})`,
            },
          });

          for (const oe of overrideEdges) {
            const oeTarget = this.db.getAction(oe.to_action);
            if (oeTarget && (oeTarget.status === "inactive" || oeTarget.status === "completed" || oeTarget.status === "failed")) {
              this.db.updateAction(oeTarget.id, {
                status: "pending",
                iteration: oeTarget.status === "completed" || oeTarget.status === "failed"
                  ? oeTarget.iteration + 1
                  : oeTarget.iteration,
              });
            }
            this.options.onEdgeTraversed?.(target.id, oe.to_action, oe.condition);
          }

          this.options.onEdgeTraversed?.(action.id, edge.to_action, condition);
          continue;
        }

        // Activate target: set to pending
        this.db.updateAction(target.id, {
          status: "pending",
          iteration: newIteration,
          output: null,
          started_at: null,
          completed_at: null,
        });
      }

      this.options.onEdgeTraversed?.(action.id, edge.to_action, condition);
    }
  }

  /**
   * Escalate an unhandled failure to a supervisor action.
   * Looks for an action tagged "type:supervisor" in the same project.
   * If found, activates it with context about the failure.
   * If not found, fires the onUnhandledFailure callback.
   */
  private escalateToSupervisor(failedAction: ActionConfig, condition: EdgeCondition): void {
    // Re-read the action to get the latest output (set by the executor before followEdges)
    const freshAction = this.db.getAction(failedAction.id) ?? failedAction;

    // Find a supervisor action in the same project
    const projectTag = freshAction.project_id ? `project:${freshAction.project_id}` : null;
    const allActions = projectTag
      ? this.db.listActions({ tag: projectTag })
      : this.db.listActions();

    const supervisor = allActions.find(
      (a) => a.tags.includes("type:supervisor") && a.id !== freshAction.id,
    );

    if (supervisor) {
      // Inject failure context into supervisor params
      const updatedParams = {
        ...supervisor.params,
        failed_action: freshAction.id,
        failed_condition: condition,
        failed_output: freshAction.output,
      };
      this.db.updateAction(supervisor.id, {
        status: "pending",
        params: updatedParams,
        iteration: supervisor.status === "completed" || supervisor.status === "failed"
          ? supervisor.iteration + 1
          : supervisor.iteration,
      });
      this.db.appendHistory(failedAction.id, "escalated", {
        supervisor_id: supervisor.id,
        condition,
      });
    }

    // Always fire the callback (even if supervisor was found) so the server
    // can broadcast an SSE event
    this.options.onUnhandledFailure?.(failedAction, condition);
  }

  /**
   * Check whether all incoming edges to an inactive action have been satisfied.
   *
   * An incoming edge blocks activation unless:
   * - Its source is in a terminal state (completed, failed, skipped), OR
   * - The edge is a retry/back-edge (source is downstream of the target,
   *   meaning it hasn't run yet and is part of a loop, not a dependency)
   *
   * Back-edge detection: if the source is inactive AND the edge condition
   * is "fail" (retry loops), it's a back-edge and doesn't block.
   * All other inactive sources are upstream dependencies and DO block.
   */
  private allIncomingEdgesSatisfied(actionId: string): boolean {
    const incoming = this.db.getEdgesTo(actionId);
    if (incoming.length === 0) return true;

    const TERMINAL = new Set(["completed", "failed", "skipped"]);

    for (const edge of incoming) {
      // Self-loops never block
      if (edge.from_action === actionId) continue;

      const src = this.db.getAction(edge.from_action);
      if (!src) return false;

      if (TERMINAL.has(src.status)) continue;

      // Inactive source with non-pass condition = retry back-edge, don't block.
      // Only pass edges from inactive sources block (forward dependencies).
      if (src.status === "inactive" && edge.condition !== "pass") continue;

      // Everything else blocks (inactive deps, pending, running, waiting)
      return false;
    }

    return true;
  }
}
