/**
 * Mock agent for integration testing.
 *
 * Simulates realistic agent behavior: variable latency, configurable
 * outcomes, stuck patterns, timeout simulation, cost accumulation.
 * Plugs into the executor via the RunActionFn interface.
 */

import type { ActionConfig, ActionOutput, EdgeCondition } from "./schema";
import type { ActionResult, WaitingResult, PredecessorOutput, RunOptions } from "./action-runner";
import type { RunActionFn } from "./executor";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface MockAgentBehavior {
  /** Minimum response time in ms (default 10) */
  minLatencyMs?: number;
  /** Maximum response time in ms (default 50) */
  maxLatencyMs?: number;

  // Outcome probabilities (normalized, default: pass=0.7, fail=0.2, rest split)
  passRate?: number;
  failRate?: number;
  maxTurnsRate?: number;
  errorRate?: number;
  timeoutRate?: number;

  /** After N calls to the same action ID, return identical output (triggers stuck detection) */
  stuckAfterN?: number;

  /** Cost range per call */
  minCost?: number;
  maxCost?: number;

  /** Turns range per call */
  minTurns?: number;
  maxTurns?: number;

  /**
   * Deterministic sequence of conditions. Overrides random selection.
   * Index is per-action-ID call count (first call to "auth.develop" uses index 0, etc.)
   * Use "*" key for a global default sequence.
   */
  sequences?: Record<string, EdgeCondition[]>;

  /** Global sequence (shorthand: applies to all action IDs) */
  sequence?: EdgeCondition[];

  /**
   * Probability of returning a WaitingResult (simulates wait_for_response).
   * Only applies to command actions with wait_for_response in params.
   * Default: respects the action's params.
   */
  forceWaiting?: boolean;

  /**
   * Probability of never resolving (for timeout testing).
   * The promise hangs forever — the caller must handle timeout externally.
   */
  hangProbability?: number;

  /** Custom output generator. If provided, overrides default output generation. */
  outputFn?: (action: ActionConfig, callCount: number, condition: EdgeCondition) => ActionOutput;
}

export interface MockAgentStats {
  totalCalls: number;
  callsByAction: Record<string, number>;
  callsByCondition: Record<string, number>;
  totalCost: number;
  callLog: Array<{
    actionId: string;
    condition: EdgeCondition;
    cost: number;
    latencyMs: number;
    callIndex: number;
  }>;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function randomBetween(min: number, max: number): number {
  return min + Math.random() * (max - min);
}

function weightedRandom(behavior: MockAgentBehavior): EdgeCondition {
  const pass = behavior.passRate ?? 0.7;
  const fail = behavior.failRate ?? 0.2;
  const maxTurns = behavior.maxTurnsRate ?? 0.04;
  const error = behavior.errorRate ?? 0.03;
  const timeout = behavior.timeoutRate ?? 0.03;

  const total = pass + fail + maxTurns + error + timeout;
  const r = Math.random() * total;

  let cumulative = 0;
  cumulative += pass;
  if (r < cumulative) return "pass";
  cumulative += fail;
  if (r < cumulative) return "fail";
  cumulative += maxTurns;
  if (r < cumulative) return "max_turns";
  cumulative += error;
  if (r < cumulative) return "error";
  return "timeout";
}

const SUMMARIES = [
  "Implemented the requested feature",
  "Updated component logic and tests",
  "Fixed the failing assertion",
  "Refactored module for clarity",
  "Added error handling",
  "Corrected the API response format",
  "Applied the suggested fix from QA",
  "Resolved the timeout issue",
];

function randomSummary(): string {
  return SUMMARIES[Math.floor(Math.random() * SUMMARIES.length)];
}

function conditionToStatus(condition: EdgeCondition): string {
  switch (condition) {
    case "pass": return "passed";
    case "fail": return "failed";
    case "max_turns": return "max_turns_exceeded";
    case "timeout": return "timed_out";
    case "cost_exceeded": return "cost_exceeded";
    case "stuck": return "stuck";
    case "error": return "error";
    default: return "unknown";
  }
}

// ---------------------------------------------------------------------------
// Mock agent factory
// ---------------------------------------------------------------------------

export function createMockAgent(behavior: MockAgentBehavior = {}): {
  fn: RunActionFn;
  stats: MockAgentStats;
} {
  const callCounts: Record<string, number> = {};
  const stuckOutputs: Record<string, ActionOutput> = {};

  const stats: MockAgentStats = {
    totalCalls: 0,
    callsByAction: {},
    callsByCondition: {},
    totalCost: 0,
    callLog: [],
  };

  const fn: RunActionFn = async (
    action: ActionConfig,
    predecessorOutputs: PredecessorOutput[],
    options: RunOptions,
  ): Promise<ActionResult | WaitingResult> => {
    const actionId = action.id;

    // Track per-action call count
    callCounts[actionId] = (callCounts[actionId] ?? 0) + 1;
    const callIndex = callCounts[actionId];

    stats.totalCalls++;
    stats.callsByAction[actionId] = (stats.callsByAction[actionId] ?? 0) + 1;

    // Simulate latency
    const minLat = behavior.minLatencyMs ?? 10;
    const maxLat = behavior.maxLatencyMs ?? 50;
    const latency = Math.round(randomBetween(minLat, maxLat));
    await Bun.sleep(latency);

    // Hang simulation (for timeout testing)
    if (behavior.hangProbability !== undefined && Math.random() < behavior.hangProbability) {
      // Never resolves — caller must timeout externally
      await new Promise<void>(() => {});
    }

    // Check for wait_for_response (human action simulation)
    if (behavior.forceWaiting || (action.type === "command" && action.params.wait_for_response)) {
      return {
        waiting: true,
        output: {
          status: "waiting",
          summary: `Notification sent for ${actionId}`,
          notes: `Waiting for human response on action ${actionId}`,
        },
      };
    }

    // Determine condition
    let condition: EdgeCondition;

    // Check for per-action sequence first, then global sequence, then random
    const actionSequence = behavior.sequences?.[actionId];
    const globalSequence = behavior.sequence ?? behavior.sequences?.["*"];

    if (actionSequence && callIndex <= actionSequence.length) {
      condition = actionSequence[callIndex - 1];
    } else if (globalSequence && stats.totalCalls <= globalSequence.length) {
      condition = globalSequence[stats.totalCalls - 1];
    } else {
      condition = weightedRandom(behavior);
    }

    // Cost
    const minCost = behavior.minCost ?? 0.1;
    const maxCost = behavior.maxCost ?? 1.0;
    const cost = Math.round(randomBetween(minCost, maxCost) * 100) / 100;

    // Turns
    const minTurns = behavior.minTurns ?? 5;
    const maxTurns = behavior.maxTurns ?? 50;
    const turns = Math.round(randomBetween(minTurns, maxTurns));

    // Build output
    let output: ActionOutput;

    if (behavior.outputFn) {
      output = behavior.outputFn(action, callIndex, condition);
    } else if (behavior.stuckAfterN !== undefined && callIndex > behavior.stuckAfterN) {
      // Stuck simulation: return identical output after N calls
      if (!stuckOutputs[actionId]) {
        stuckOutputs[actionId] = {
          status: conditionToStatus(condition),
          summary: `Stuck output for ${actionId}`,
          notes: "This output is identical every time",
        };
      }
      output = stuckOutputs[actionId];
    } else {
      output = {
        status: conditionToStatus(condition),
        summary: `[${actionId} call #${callIndex}] ${randomSummary()}`,
        notes: predecessorOutputs.length > 0
          ? `Read ${predecessorOutputs.length} predecessor output(s)`
          : undefined,
      };

      // Add failure details for fail conditions
      if (condition === "fail") {
        output.issues = `Simulated failure on call #${callIndex}`;
      }
    }

    // Record stats
    stats.callsByCondition[condition] = (stats.callsByCondition[condition] ?? 0) + 1;
    stats.totalCost += cost;
    stats.callLog.push({ actionId, condition, cost, latencyMs: latency, callIndex });

    return {
      condition,
      output,
      cost_usd: cost,
      duration_ms: latency,
      num_turns: turns,
    };
  };

  return { fn, stats };
}

// ---------------------------------------------------------------------------
// Convenience presets
// ---------------------------------------------------------------------------

/** Always passes on first try. */
export function alwaysPass(): { fn: RunActionFn; stats: MockAgentStats } {
  return createMockAgent({ passRate: 1.0, failRate: 0, maxTurnsRate: 0, errorRate: 0, timeoutRate: 0 });
}

/** Fails N times then passes. */
export function failThenPass(failCount: number): { fn: RunActionFn; stats: MockAgentStats } {
  const seq: EdgeCondition[] = [];
  for (let i = 0; i < failCount; i++) seq.push("fail");
  seq.push("pass");
  return createMockAgent({ sequence: seq });
}

/** Produces identical output after N calls (triggers stuck detection). */
export function getsStuck(afterN: number): { fn: RunActionFn; stats: MockAgentStats } {
  return createMockAgent({ stuckAfterN: afterN, passRate: 0.5, failRate: 0.5 });
}

/** Returns max_turns condition (simulates agent hitting turn limit). */
export function hitsMaxTurns(): { fn: RunActionFn; stats: MockAgentStats } {
  return createMockAgent({ maxTurnsRate: 1.0, passRate: 0, failRate: 0, errorRate: 0, timeoutRate: 0 });
}

/** Expensive agent — accumulates cost quickly. */
export function expensive(costPerCall: number): { fn: RunActionFn; stats: MockAgentStats } {
  return createMockAgent({ minCost: costPerCall, maxCost: costPerCall, passRate: 1.0, failRate: 0 });
}
