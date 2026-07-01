/**
 * P4 Governance — global circuit-breaker.
 *
 * The executor caps total cost AND total graph size across the whole build.
 * On a breach it HALTS (stops scheduling further work) and escalates via the
 * `onCircuitBreaker` hook (wired to an SSE `unhandled_failure` in the worker).
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { OrcaDatabase } from "./db";
import { Executor, type CircuitBreakerBreach, type ExecutorOptions, type RunActionFn } from "./executor";
import { createAction, type ActionResult } from "./schema";

let db: OrcaDatabase;

beforeEach(() => {
  db = new OrcaDatabase(":memory:");
});

afterEach(() => {
  db.close();
});

function passResult(cost = 0): ActionResult {
  return {
    condition: "pass",
    output: { status: "passed", summary: "ok" },
    cost_usd: cost,
    duration_ms: 10,
    num_turns: 1,
  };
}

function options(
  runActionFn: RunActionFn,
  overrides: Partial<ExecutorOptions>,
  breaches: CircuitBreakerBreach[],
): ExecutorOptions {
  return {
    projectDir: "/tmp",
    runActionFn,
    onCircuitBreaker: (b) => breaches.push(b),
    ...overrides,
  };
}

describe("global circuit-breaker — cost", () => {
  test("halts and escalates when total cost reaches the cap", async () => {
    for (const id of ["a", "b", "c", "d", "e"]) {
      db.insertAction(createAction({ id, status: "pending" }));
    }

    const run: RunActionFn = async () => passResult(0.6);
    const breaches: CircuitBreakerBreach[] = [];
    const executor = new Executor(db, options(run, { maxTotalCost: 1.0 }, breaches));

    await executor.run();

    // Breaker tripped on cost.
    expect(breaches).toHaveLength(1);
    expect(breaches[0].reason).toBe("cost");
    expect(breaches[0].total_cost).toBeGreaterThanOrEqual(1.0);
    expect(executor.isHalted()).toBe(true);

    // It HALTED — not every action ran (some remain pending).
    const pending = db.listActions({ status: "pending" });
    expect(pending.length).toBeGreaterThan(0);
  });

  test("does not trip when cost stays under the cap", async () => {
    db.insertAction(createAction({ id: "a", status: "pending" }));
    const run: RunActionFn = async () => passResult(0.1);
    const breaches: CircuitBreakerBreach[] = [];
    const executor = new Executor(db, options(run, { maxTotalCost: 100 }, breaches));

    await executor.run();

    expect(breaches).toHaveLength(0);
    expect(executor.isHalted()).toBe(false);
    expect(db.getAction("a")!.status).toBe("completed");
  });
});

describe("global circuit-breaker — size", () => {
  test("halts and escalates when the graph exceeds the size cap", async () => {
    for (const id of ["a", "b", "c", "d", "e"]) {
      db.insertAction(createAction({ id, status: "pending" }));
    }

    const run: RunActionFn = async () => passResult(0);
    const breaches: CircuitBreakerBreach[] = [];
    const executor = new Executor(db, options(run, { maxGraphSize: 3 }, breaches));

    await executor.run();

    expect(breaches).toHaveLength(1);
    expect(breaches[0].reason).toBe("size");
    expect(breaches[0].graph_size).toBeGreaterThanOrEqual(3);
    expect(executor.isHalted()).toBe(true);

    // Halted immediately — nothing ran, all still pending.
    expect(db.listActions({ status: "pending" })).toHaveLength(5);
  });

  test("does not trip when the graph is under the size cap", async () => {
    db.insertAction(createAction({ id: "a", status: "pending" }));
    const run: RunActionFn = async () => passResult(0);
    const breaches: CircuitBreakerBreach[] = [];
    const executor = new Executor(db, options(run, { maxGraphSize: 10 }, breaches));

    await executor.run();

    expect(breaches).toHaveLength(0);
    expect(executor.isHalted()).toBe(false);
  });
});

describe("global circuit-breaker — halted stays halted", () => {
  test("a halted executor does not resume work on re-run", async () => {
    for (const id of ["a", "b", "c", "d"]) {
      db.insertAction(createAction({ id, status: "pending" }));
    }

    let calls = 0;
    const run: RunActionFn = async () => {
      calls++;
      return passResult(0);
    };
    const breaches: CircuitBreakerBreach[] = [];
    const executor = new Executor(db, options(run, { maxGraphSize: 2 }, breaches));

    await executor.run();
    const callsAfterFirst = calls;
    await executor.run(); // second attempt

    expect(executor.isHalted()).toBe(true);
    expect(calls).toBe(callsAfterFirst); // no additional work performed
  });
});
