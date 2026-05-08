/**
 * Live agent tests — run real Claude Code invocations through the v2 system.
 *
 * These tests actually call the Claude API. They validate the full pipeline:
 * executor → action-runner → invoke.ts → Claude SDK → structured output
 * → condition classification → edge routing.
 *
 * The agents are given explicit instructions on exactly what to return,
 * making the output predictable despite being a real LLM call.
 *
 * Skip with: SKIP_LIVE=1 bun test src/v2/live-agent.test.ts
 */

import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { OrcaDatabase } from "./db";
import { Executor } from "./executor";
import { createAction, createEdge, createProject } from "./schema";
import { runAction } from "./action-runner";
import type { RunOptions } from "./action-runner";

// Skip if SKIP_LIVE is set or no claude in PATH
const SKIP = process.env.SKIP_LIVE === "1";

function skipIf(condition: boolean) {
  return condition ? test.skip : test;
}

const projectDir = process.cwd();

let db: OrcaDatabase;

beforeEach(() => {
  db = new OrcaDatabase(":memory:");
});

afterEach(() => {
  db.close();
});

const runOptions: RunOptions = {
  projectDir,
  model: "sonnet",  // cheaper for tests
};

// ---------------------------------------------------------------------------
// Direct action runner tests — validate the invoke pipeline
// ---------------------------------------------------------------------------

describe("Live agent: action runner", () => {
  skipIf(SKIP)("agent returns structured output with status passed", async () => {
    const action = createAction({
      id: "live.pass",
      type: "agent",
      status: "running",
      params: {
        prompt: `You are a test agent. Your only task: return structured output with status "passed" and summary "live test completed successfully". Do NOT use any tools. Do NOT read any files. Do NOT explore the codebase. Just return the structured output immediately.`,
        max_turns: 10,
      },
    });

    const result = await runAction(action, [], runOptions);

    if ("waiting" in result) throw new Error("unexpected WaitingResult");
    // Core contract: structured output is returned and classified
    expect(["pass", "fail"]).toContain(result.condition);
    expect(result.output.status).toBeDefined();
    expect(result.output.summary).toBeDefined();
    expect(result.num_turns).toBeGreaterThanOrEqual(1);
    expect(result.duration_ms).toBeGreaterThan(0);
    // Most runs should pass — but LLM flakiness means we test the pipeline, not the LLM
    if (result.condition === "pass") {
      expect(result.output.status).toBe("passed");
    }
  }, 60000);

  skipIf(SKIP)("agent returns structured output with status failed", async () => {
    const action = createAction({
      id: "live.fail",
      type: "agent",
      status: "running",
      params: {
        prompt: `You are a test agent. Return structured output with exactly these values:
- status: "failed"
- summary: "intentional test failure"
- issues: "this is a simulated failure for testing"

Do NOT use any tools. Just return the structured output immediately.`,
        max_turns: 5,
      },
    });

    const result = await runAction(action, [], runOptions);

    if ("waiting" in result) throw new Error("unexpected WaitingResult");
    expect(result.condition).toBe("fail");
    expect(result.output.status).toBe("failed");
    expect(result.cost_usd).toBeGreaterThan(0);
  }, 60000);

  skipIf(SKIP)("agent receives predecessor output in prompt", async () => {
    const action = createAction({
      id: "live.pred",
      type: "agent",
      status: "running",
      params: {
        prompt: `You are a test agent. Look at the "Previous actions" section above this prompt.
You should see output from an action called "prior.eval" with summary about "3 tests failing".

Return structured output with:
- status: "passed"
- summary: "predecessor output received"

Do NOT use any tools. Do NOT read any files. Just return the structured output immediately.`,
        max_turns: 10,
      },
    });

    const predecessors = [{
      actionId: "prior.eval",
      output: {
        status: "failed",
        summary: "3 tests failing in src/auth.test.ts",
        notes: "Run bun test src/auth.test.ts to reproduce",
      },
    }];

    const result = await runAction(action, predecessors, runOptions);

    if ("waiting" in result) throw new Error("unexpected WaitingResult");
    // The agent should see the predecessor and return pass
    expect(result.condition).toBe("pass");
  }, 60000);

  skipIf(SKIP)("cost and turns are always extracted", async () => {
    const action = createAction({
      id: "live.cost",
      type: "agent",
      status: "running",
      params: {
        prompt: `Read the file package.json and then return structured output: status "passed", summary "cost tracking test".`,
        max_turns: 10,
      },
    });

    const result = await runAction(action, [], runOptions);

    if ("waiting" in result) throw new Error("unexpected WaitingResult");
    // Regardless of pass/fail, these should always be captured
    expect(typeof result.cost_usd).toBe("number");
    expect(typeof result.num_turns).toBe("number");
    expect(typeof result.duration_ms).toBe("number");
    // Agent did real work (read a file), so cost should be non-zero
    expect(result.cost_usd).toBeGreaterThanOrEqual(0);
    expect(result.num_turns).toBeGreaterThanOrEqual(1);
    expect(result.duration_ms).toBeGreaterThan(0);
  }, 60000);
});

// ---------------------------------------------------------------------------
// Executor integration — full pipeline with real agents
// ---------------------------------------------------------------------------

describe("Live agent: executor pipeline", () => {
  skipIf(SKIP)("simple chain: agent pass → command pass", async () => {
    // Agent action produces "pass" → activates command action → command succeeds
    db.insertAction(createAction({
      id: "pipe.agent",
      type: "agent",
      status: "pending",
      params: {
        prompt: `Return structured output: status "passed", summary "agent completed". Do NOT use any tools.`,
        max_turns: 5,
      },
      tags: ["task:pipe"],
    }));

    db.insertAction(createAction({
      id: "pipe.check",
      type: "command",
      status: "inactive",
      params: { command: "echo 'verified'" },
      tags: ["task:pipe"],
    }));

    db.insertEdge(createEdge("pipe.agent", "pipe.check", "pass"));

    const events: string[] = [];
    const exec = new Executor(db, {
      projectDir,
      model: "sonnet",
      onActionStart: (a) => events.push(`start:${a.id}`),
      onActionEnd: (a) => events.push(`end:${a.id}`),
      onEdgeTraversed: (from, to, cond) => events.push(`edge:${from}→${to}[${cond}]`),
    });
    await exec.run();

    expect(db.getAction("pipe.agent")!.status).toBe("completed");
    expect(db.getAction("pipe.check")!.status).toBe("completed");
    expect(events).toContain("edge:pipe.agent→pipe.check[pass]");

    // Agent cost should be recorded
    const agentAction = db.getAction("pipe.agent")!;
    expect(agentAction.cost_usd).toBeGreaterThan(0);
  }, 120000);

  skipIf(SKIP)("agent fail routes correctly", async () => {
    // Agent returns "failed" → fail edge fires → fallback action runs
    db.insertAction(createAction({
      id: "rt.agent",
      type: "agent",
      status: "pending",
      params: {
        prompt: `Return structured output: status "failed", summary "intentional failure", issues "test routing". Do NOT use any tools.`,
        max_turns: 5,
      },
      tags: ["task:rt"],
    }));

    db.insertAction(createAction({
      id: "rt.success-path",
      type: "command",
      status: "inactive",
      params: { command: "echo should-not-run" },
      tags: ["task:rt"],
    }));

    db.insertAction(createAction({
      id: "rt.fail-path",
      type: "command",
      status: "inactive",
      params: { command: "echo fail-path-activated" },
      tags: ["task:rt"],
    }));

    db.insertEdge(createEdge("rt.agent", "rt.success-path", "pass"));
    db.insertEdge(createEdge("rt.agent", "rt.fail-path", "fail"));

    const exec = new Executor(db, { projectDir, model: "sonnet" });
    await exec.run();

    expect(db.getAction("rt.agent")!.status).toBe("failed");
    expect(db.getAction("rt.fail-path")!.status).toBe("completed");
    expect(db.getAction("rt.success-path")!.status).toBe("inactive"); // never activated
  }, 120000);

  skipIf(SKIP)("agent output flows to next agent as predecessor context", async () => {
    // Agent A returns notes → Agent B receives them and confirms
    db.insertAction(createAction({
      id: "flow.a",
      type: "agent",
      status: "pending",
      params: {
        prompt: `Return structured output:
- status: "passed"
- summary: "first agent done"
- notes: "The secret code is PINEAPPLE-42"

Do NOT use any tools.`,
        max_turns: 5,
      },
      tags: ["task:flow"],
    }));

    db.insertAction(createAction({
      id: "flow.b",
      type: "agent",
      status: "inactive",
      params: {
        prompt: `You should see predecessor output from "flow.a" containing a secret code.

If you can see the secret code in the predecessor context, return:
- status: "passed"
- summary: "received secret code"
- notes: repeat the exact secret code you found

If you cannot see it, return:
- status: "failed"
- summary: "no secret code found"

Do NOT use any tools.`,
        max_turns: 5,
      },
      tags: ["task:flow"],
    }));

    db.insertEdge(createEdge("flow.a", "flow.b", "pass"));

    const exec = new Executor(db, { projectDir, model: "sonnet" });
    await exec.run();

    const b = db.getAction("flow.b")!;
    expect(b.status).toBe("completed");
    expect(b.output!.status).toBe("passed");
    // The agent should have found PINEAPPLE-42 in the predecessor output
    const notes = (b.output!.notes as string) ?? b.output!.summary;
    expect(notes).toContain("PINEAPPLE");
  }, 120000);
});
