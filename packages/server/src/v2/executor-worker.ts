/**
 * Executor worker — runs the action graph executor in a separate thread.
 *
 * Opens its own SQLite connection (WAL mode allows concurrent access).
 * Communicates with the main server thread via postMessage for SSE
 * broadcast events and pause/resume commands.
 */

import { OrcaDatabase } from "./db";
import { Executor } from "./executor";
import { runAction } from "./action-runner";

declare var self: Worker;

interface WorkerInit {
  type: "init";
  dbPath: string;
}

interface WorkerCommand {
  type: "pause" | "resume" | "kick";
}

let executor: Executor | null = null;
let db: OrcaDatabase | null = null;
let running = false;

async function runLoop() {
  if (running || !executor) return;
  running = true;
  try {
    await executor.run();
  } finally {
    running = false;
    self.postMessage({ type: "executor_state", data: { state: "idle", pending_count: 0 } });
  }
}

self.onmessage = (event: MessageEvent<WorkerInit | WorkerCommand>) => {
  const msg = event.data;

  if (msg.type === "init") {
    db = new OrcaDatabase(msg.dbPath);
    executor = new Executor(db, {
      projectDir: ".",
      runActionFn: runAction,
      onActionStart: (action) => {
        self.postMessage({ type: "action_started", data: { action_id: action.id, type: action.type }, actionId: action.id });
        self.postMessage({ type: "stats_refresh" });
      },
      onActionEnd: (action, result) => {
        self.postMessage({ type: "action_completed", data: { action_id: action.id, condition: result.condition, cost_usd: result.cost_usd }, actionId: action.id });
        self.postMessage({ type: "stats_refresh" });
      },
      onActionWaiting: (action) => {
        self.postMessage({ type: "action_waiting", data: { action_id: action.id }, actionId: action.id });
      },
      onToolUse: (action, toolName, toolInput) => {
        self.postMessage({ type: "tool_use", data: { action_id: action.id, tool_name: toolName, tool_input: toolInput }, actionId: action.id });
      },
      onEdgeTraversed: (from, to, condition) => {
        self.postMessage({ type: "edge_traversed", data: { from, to, condition } });
      },
      onUnhandledFailure: (action, condition) => {
        self.postMessage({ type: "unhandled_failure", data: { action_id: action.id, condition, output: action.output }, actionId: action.id });
        self.postMessage({ type: "stats_refresh" });
      },
      onCircuitBreaker: (breach) => {
        // Escalate a tripped global breaker as an unhandled failure so the
        // primary agent / human is notified over SSE.
        self.postMessage({
          type: "unhandled_failure",
          data: { reason: "circuit_breaker", breach },
        });
        self.postMessage({ type: "stats_refresh" });
      },
      onIdle: () => {
        self.postMessage({ type: "executor_state", data: { state: "idle", pending_count: 0 } });
        self.postMessage({ type: "stats_refresh" });
      },
    });

    // Start the executor loop
    self.postMessage({ type: "executor_state", data: { state: "running" } });
    runLoop();
    return;
  }

  if (msg.type === "pause" && executor) {
    executor.pause();
    self.postMessage({ type: "executor_state", data: { state: "paused" } });
    return;
  }

  if (msg.type === "resume" && executor) {
    executor.resume();
    self.postMessage({ type: "executor_state", data: { state: "running" } });
    runLoop();
    return;
  }

  if (msg.type === "kick" && executor) {
    if (!running) {
      executor.resume();
      self.postMessage({ type: "executor_state", data: { state: "running" } });
      runLoop();
    }
    return;
  }
};
