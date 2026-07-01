import { describe, expect, test, mock, beforeEach, afterEach } from "bun:test";
import {
  runAction,
  buildPredecessorPrompt,
  type ActionResult,
  type WaitingResult,
  type PredecessorOutput,
} from "./action-runner";
import { createAction, type ActionConfig } from "./schema";

// ---------------------------------------------------------------------------
// Mock invokeSimple
// ---------------------------------------------------------------------------

const mockInvokeSimple = mock(() =>
  Promise.resolve({
    output: { status: "passed", summary: "All good" },
    costUsd: 0.05,
    sessionId: "sess-1",
    numTurns: 3,
    durationMs: 1500,
    isError: false,
  }),
);

mock.module("../engine/invoke", () => ({
  invokeSimple: mockInvokeSimple,
}));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function agentAction(overrides: Partial<ActionConfig> = {}): ActionConfig {
  return createAction({
    id: "test.develop",
    type: "agent",
    params: { prompt: "Build something" },
    ...overrides,
  });
}

function commandAction(overrides: Partial<ActionConfig> = {}): ActionConfig {
  return createAction({
    id: "test.cmd",
    type: "command",
    params: { command: "echo hello", ...overrides.params },
    ...overrides,
  });
}

const defaultOptions = { projectDir: "/tmp" };

// ---------------------------------------------------------------------------
// Command action tests
// ---------------------------------------------------------------------------

describe("command action", () => {
  test("exit 0 → pass", async () => {
    const action = commandAction({ params: { command: "true" } });
    const result = (await runAction(action, [], defaultOptions)) as ActionResult;

    expect(result.condition).toBe("pass");
    expect(result.output.status).toBe("passed");
    expect(result.cost_usd).toBe(0);
    expect(result.duration_ms).toBeGreaterThanOrEqual(0);
    expect(result.num_turns).toBe(0);
  });

  test("exit 1 → fail", async () => {
    const action = commandAction({ params: { command: "false" } });
    const result = (await runAction(action, [], defaultOptions)) as ActionResult;

    expect(result.condition).toBe("fail");
    expect(result.output.status).toBe("failed");
  });

  test("exit ≥2 → error (command broken, not test failure)", async () => {
    const action = commandAction({ params: { command: "exit 127" } });
    const result = (await runAction(action, [], defaultOptions)) as ActionResult;

    expect(result.condition).toBe("error");
    expect(result.output.status).toBe("error");
    expect(result.output.exit_code).toBe(127);
  });

  test("exit 2 → error", async () => {
    const action = commandAction({ params: { command: "exit 2" } });
    const result = (await runAction(action, [], defaultOptions)) as ActionResult;

    expect(result.condition).toBe("error");
    expect(result.output.status).toBe("error");
  });

  test("timeout → timeout condition", async () => {
    const action = commandAction({
      params: { command: "sleep 10", timeout: 0.1 },
    });
    const result = (await runAction(action, [], defaultOptions)) as ActionResult;

    expect(result.condition).toBe("timeout");
    expect(result.output.status).toBe("timeout");
  });

  test("wait_for_response → WaitingResult", async () => {
    const action = commandAction({
      params: { command: "echo started", wait_for_response: true },
    });
    const result = (await runAction(action, [], defaultOptions)) as WaitingResult;

    expect(result.waiting).toBe(true);
    expect(result.output).toBeDefined();
    expect(result.output.status).toBe("passed");
  });
});

// ---------------------------------------------------------------------------
// Agent action tests
// ---------------------------------------------------------------------------

describe("agent action", () => {
  // These tests mock the legacy Claude Code SDK path (invokeSimple), which is
  // opt-in in P2 (Orca's own loop is the default). Enable the SDK path here.
  beforeEach(() => {
    process.env.ORCA_USE_CLAUDE_SDK = "1";
    mockInvokeSimple.mockClear();
  });
  afterEach(() => {
    delete process.env.ORCA_USE_CLAUDE_SDK;
  });

  test("success with passed status → pass condition", async () => {
    mockInvokeSimple.mockResolvedValueOnce({
      output: { status: "passed", summary: "Tests pass" },
      costUsd: 0.10,
      sessionId: "s1",
      numTurns: 5,
      durationMs: 3000,
      isError: false,
    });

    const action = agentAction();
    const result = (await runAction(action, [], defaultOptions)) as ActionResult;

    expect(result.condition).toBe("pass");
    expect(result.output.status).toBe("passed");
    expect(result.cost_usd).toBe(0.10);
    expect(result.num_turns).toBe(5);
    expect(result.duration_ms).toBe(3000);
  });

  test("success with failed status → fail condition", async () => {
    mockInvokeSimple.mockResolvedValueOnce({
      output: { status: "failed", summary: "Tests failing" },
      costUsd: 0.08,
      sessionId: "s2",
      numTurns: 4,
      durationMs: 2000,
      isError: false,
    });

    const action = agentAction();
    const result = (await runAction(action, [], defaultOptions)) as ActionResult;

    expect(result.condition).toBe("fail");
    expect(result.output.status).toBe("failed");
  });

  test("success with missing status → error condition", async () => {
    mockInvokeSimple.mockResolvedValueOnce({
      output: { summary: "Something happened" },
      costUsd: 0.02,
      sessionId: "s3",
      numTurns: 2,
      durationMs: 1000,
      isError: false,
    });

    const action = agentAction();
    const result = (await runAction(action, [], defaultOptions)) as ActionResult;

    expect(result.condition).toBe("error");
  });

  test("error with max turns reached → max_turns condition", async () => {
    mockInvokeSimple.mockResolvedValueOnce({
      output: null,
      costUsd: 0.15,
      sessionId: "s4",
      numTurns: 10,
      durationMs: 5000,
      isError: true,
    });

    const action = agentAction({ params: { prompt: "Do stuff", max_turns: 10 } });
    const result = (await runAction(action, [], defaultOptions)) as ActionResult;

    expect(result.condition).toBe("max_turns");
    expect(result.cost_usd).toBe(0.15);
    expect(result.num_turns).toBe(10);
    expect(result.duration_ms).toBe(5000);
  });

  test("error without max turns → error condition", async () => {
    mockInvokeSimple.mockResolvedValueOnce({
      output: null,
      costUsd: 0.03,
      sessionId: "s5",
      numTurns: 2,
      durationMs: 800,
      isError: true,
    });

    const action = agentAction();
    const result = (await runAction(action, [], defaultOptions)) as ActionResult;

    expect(result.condition).toBe("error");
    expect(result.cost_usd).toBe(0.03);
    expect(result.num_turns).toBe(2);
    expect(result.duration_ms).toBe(800);
  });

  test("cost/turns always extracted even on error subtypes", async () => {
    mockInvokeSimple.mockResolvedValueOnce({
      output: null,
      costUsd: 0.50,
      sessionId: null,
      numTurns: 25,
      durationMs: 10000,
      isError: true,
    });

    const action = agentAction({ params: { prompt: "Expensive task", max_turns: 25 } });
    const result = (await runAction(action, [], defaultOptions)) as ActionResult;

    expect(result.cost_usd).toBe(0.50);
    expect(result.num_turns).toBe(25);
    expect(result.duration_ms).toBe(10000);
  });
});

// ---------------------------------------------------------------------------
// Predecessor output injection
// ---------------------------------------------------------------------------

describe("predecessor output injection", () => {
  beforeEach(() => {
    process.env.ORCA_USE_CLAUDE_SDK = "1";
    mockInvokeSimple.mockClear();
  });
  afterEach(() => {
    delete process.env.ORCA_USE_CLAUDE_SDK;
  });

  test("formats predecessor outputs into prompt", () => {
    const predecessors: PredecessorOutput[] = [
      {
        actionId: "auth.eval",
        output: {
          status: "failed",
          summary: "3 tests failing in src/auth.test.ts",
          notes: "Run `bun test src/auth.test.ts` to see failures",
        },
      },
    ];

    const prompt = buildPredecessorPrompt(predecessors);

    expect(prompt).toContain("## Previous actions");
    expect(prompt).toContain("### auth.eval (failed)");
    expect(prompt).toContain("Summary: 3 tests failing in src/auth.test.ts");
    expect(prompt).toContain("Notes: Run `bun test src/auth.test.ts` to see failures");
  });

  test("empty predecessors → empty string", () => {
    expect(buildPredecessorPrompt([])).toBe("");
  });

  test("predecessor prompt is prepended to agent prompt", async () => {
    mockInvokeSimple.mockResolvedValueOnce({
      output: { status: "passed", summary: "Done" },
      costUsd: 0.01,
      sessionId: "s6",
      numTurns: 1,
      durationMs: 500,
      isError: false,
    });

    const predecessors: PredecessorOutput[] = [
      {
        actionId: "setup.cmd",
        output: { status: "passed", summary: "Server started" },
      },
    ];

    const action = agentAction();
    await runAction(action, predecessors, defaultOptions);

    expect(mockInvokeSimple).toHaveBeenCalledTimes(1);
    const callArgs = mockInvokeSimple.mock.calls[0][0] as { prompt: string };
    expect(callArgs.prompt).toContain("## Previous actions");
    expect(callArgs.prompt).toContain("### setup.cmd (passed)");
    expect(callArgs.prompt).toContain("Build something");
  });
});

// ---------------------------------------------------------------------------
// Nix environment resolution
// ---------------------------------------------------------------------------

import { resolveNixEnv, clearNixEnvCache } from "./action-runner";
import { mkdtempSync, writeFileSync } from "fs";
import { join } from "path";

describe("resolveNixEnv", () => {
  beforeEach(() => clearNixEnvCache());

  test("returns undefined when no nix files exist", () => {
    const tmpDir = mkdtempSync(join(require("os").tmpdir(), "orca-nix-"));
    const result = resolveNixEnv(tmpDir);
    expect(result).toBeUndefined();
  });

  test("returns undefined when nix.enable is false", () => {
    const tmpDir = mkdtempSync(join(require("os").tmpdir(), "orca-nix-"));
    writeFileSync(join(tmpDir, "flake.nix"), "{}");
    const result = resolveNixEnv(tmpDir, { enable: false });
    expect(result).toBeUndefined();
  });

  test("detects shell.nix and resolves env", () => {
    const tmpDir = mkdtempSync(join(require("os").tmpdir(), "orca-nix-"));
    // Create a minimal shell.nix that just exports PATH
    writeFileSync(join(tmpDir, "shell.nix"), `
      { pkgs ? import <nixpkgs> {} }:
      pkgs.mkShell { buildInputs = []; }
    `);
    const result = resolveNixEnv(tmpDir);
    // If nix is available on the system, this returns env vars
    // If nix is not available, it returns undefined (spawnSync fails)
    if (result) {
      expect(result.PATH).toBeDefined();
      expect(typeof result.PATH).toBe("string");
    }
    // Either way, it shouldn't throw
  });

  test("returns fresh env on each call (no stale cache)", () => {
    const tmpDir = mkdtempSync(join(require("os").tmpdir(), "orca-nix-"));
    writeFileSync(join(tmpDir, "shell.nix"), `
      { pkgs ? import <nixpkgs> {} }:
      pkgs.mkShell { buildInputs = []; }
    `);
    const r1 = resolveNixEnv(tmpDir);
    const r2 = resolveNixEnv(tmpDir);
    // Both should return valid envs with PATH
    if (r1 && r2) {
      expect(r1.PATH).toBeDefined();
      expect(r2.PATH).toBeDefined();
      // Fresh calls — not the same reference
      expect(r1).not.toBe(r2);
    }
  });

  test("passes env to invokeSimple for agent actions", async () => {
    // The SDK path is opt-in (P2 fallback); enable it for this assertion.
    process.env.ORCA_USE_CLAUDE_SDK = "1";
    // Verify the env field is passed through to invokeSimple
    const action = agentAction();
    mockInvokeSimple.mockClear();
    mockInvokeSimple.mockResolvedValueOnce({
      output: { status: "passed", summary: "ok" },
      costUsd: 0.01,
      sessionId: "s1",
      numTurns: 1,
      durationMs: 100,
      isError: false,
    });

    // Run with a projectDir that has no nix files — env should be undefined
    const tmpDir = mkdtempSync(join(require("os").tmpdir(), "orca-nonix-"));
    await runAction(action, [], { projectDir: tmpDir });

    // invokeSimple was called — check the options
    expect(mockInvokeSimple).toHaveBeenCalledTimes(1);
    const opts = mockInvokeSimple.mock.calls[0][0] as { env?: Record<string, string> };
    expect(opts.env).toBeUndefined();
    delete process.env.ORCA_USE_CLAUDE_SDK;
  });
});
