/**
 * P5 gate — the reified loop actually runs.
 *
 * Builds a build↔test loop through the SAME governed chokepoint the L3 agent
 * uses (`createGraphEditTool` → `applyValidatedDelta`), then runs the real
 * executor over it with a deterministic mock action-runner. Asserts the loop
 * iterates more than once and terminates via the ESCAPE (test finally passes —
 * no `pass` edge leaves the loop) rather than the max-iteration breaker.
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { OrcaDatabase } from "./db";
import { validateGraph } from "./graph-ops";
import { createGraphEditTool, type GraphEdit } from "./l3-agent";
import { Executor } from "./executor";
import { createMockAgent } from "./mock-agent";
import type { ToolContext } from "../harness/types";

const CTX: ToolContext = { cwd: "/tmp" };

const LOOP_EDITS: GraphEdit[] = [
  { op: "add_action", id: "demo.build", type: "agent", prompt: "Write the feature", initial: true, max_iterations: 5 },
  { op: "add_action", id: "demo.test", type: "command", command: "bun test" },
  { op: "add_edge", from: "demo.build", to: "demo.test", condition: "pass" },
  { op: "add_edge", from: "demo.test", to: "demo.build", condition: "fail" },
];

let db: OrcaDatabase;

beforeEach(() => {
  db = new OrcaDatabase(":memory:");
});

afterEach(() => {
  db.close();
});

function buildLoop(edits: GraphEdit[] = LOOP_EDITS) {
  const tool = createGraphEditTool(db, { taskTag: "task:demo" });
  return tool.execute({ edits }, CTX);
}

describe("loop circuit: reify then run", () => {
  test("the executor iterates the loop and terminates via the escape", async () => {
    const applied = await buildLoop();
    expect((applied as { isError?: boolean }).isError).toBeUndefined();
    expect(validateGraph(db.rawDb)).toEqual([]);

    // test fails twice then passes → the loop must iterate build/test 3×.
    const { fn, stats } = createMockAgent({
      sequences: {
        "demo.build": ["pass", "pass", "pass", "pass"],
        "demo.test": ["fail", "fail", "pass"],
      },
      minCost: 0.01,
      maxCost: 0.01,
    });

    let breaker = false;
    const executor = new Executor(db, {
      projectDir: "/tmp",
      runActionFn: fn,
      maxTotalCost: 100, // high — must not trip
      maxGraphSize: 100,
      onCircuitBreaker: () => { breaker = true; },
    });

    await executor.run();

    // Iterated more than once.
    expect(stats.callsByAction["demo.build"]).toBe(3);
    expect(stats.callsByAction["demo.test"]).toBe(3);

    // Terminated via the escape: test's final run passed and completed; the
    // build node never tripped the max-iteration breaker.
    const testA = db.getAction("demo.test")!;
    const build = db.getAction("demo.build")!;
    expect(testA.status).toBe("completed");
    expect(testA.output?.status).toBe("passed");
    expect(build.iteration).toBeLessThan(5);
    expect(build.output?.status).not.toBe("max_iterations");
    expect(breaker).toBe(false);
    expect(executor.isIdle()).toBe(true);
    expect(executor.isHalted()).toBe(false);
  });

  test("an unbounded cycle is rejected — the loop is never built", async () => {
    const badEdits: GraphEdit[] = [
      { op: "add_action", id: "bad.a", type: "agent", prompt: "x", initial: true },
      { op: "add_action", id: "bad.b", type: "agent", prompt: "y" },
      { op: "add_edge", from: "bad.a", to: "bad.b", condition: "pass" },
      { op: "add_edge", from: "bad.b", to: "bad.a", condition: "pass" },
    ];
    const res = (await buildLoop(badEdits)) as { output: string; isError?: boolean };
    expect(res.isError).toBe(true);
    expect(res.output).toContain("Unbounded cycle");
    expect(db.getAction("bad.a")).toBeNull();
    expect(db.getAction("bad.b")).toBeNull();
  });
});
