/**
 * Live harness tests — run real Anthropic API calls through the agent harness.
 *
 * These tests call the Anthropic Messages API directly (no Claude Code SDK).
 * They validate the full harness pipeline: API call → tool execution →
 * structured output → condition classification.
 *
 * Uses Haiku for speed and cost (~$0.001 per test).
 *
 * Skip with: SKIP_LIVE=1 bun test src/harness/live.test.ts
 */

import { describe, test, expect, beforeEach } from "bun:test";
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { runAgentLoop } from "../engine/agent-loop";
import { getSecret } from "./secrets";
import type { HarnessOptions } from "./types";

const SKIP = process.env.SKIP_LIVE === "1" || !getSecret("ANTHROPIC_API_KEY");

function skipIf(condition: boolean) {
  return condition ? test.skip : test;
}

const MODEL = "claude-haiku-4-5-20251001";

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "harness-live-"));
});

function opts(overrides: Partial<HarnessOptions> = {}): HarnessOptions {
  return {
    prompt: "Return status passed.",
    model: MODEL,
    cwd: tmpDir,
    maxTurns: 10,
    maxTokens: 4096,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Basic structured output
// ---------------------------------------------------------------------------

describe("live harness: structured output", () => {
  skipIf(SKIP)("returns passed status", async () => {
    const result = await runAgentLoop(opts({
      prompt: `Return structured output immediately with status "passed" and summary "live test ok". Do NOT use any tools except StructuredOutput.`,
    }));

    expect(result.isError).toBe(false);
    expect(result.output).not.toBeNull();
    expect(result.output!.status).toBe("passed");
    expect(result.output!.summary).toBeDefined();
    expect(result.numTurns).toBeGreaterThanOrEqual(1);
    expect(result.costUsd).toBeGreaterThan(0);
    expect(result.durationMs).toBeGreaterThan(0);
  }, 30000);

  skipIf(SKIP)("returns failed status", async () => {
    const result = await runAgentLoop(opts({
      prompt: `Return structured output with status "failed" and summary "intentional failure". Do NOT use any tools except StructuredOutput.`,
    }));

    expect(result.isError).toBe(false);
    expect(result.output!.status).toBe("failed");
  }, 30000);

  skipIf(SKIP)("returns custom fields in output", async () => {
    const result = await runAgentLoop(opts({
      prompt: `Return structured output with status "passed", summary "custom fields", and notes "extra data here". Do NOT use any tools except StructuredOutput.`,
    }));

    expect(result.output!.status).toBe("passed");
    expect(result.output!.notes).toBeDefined();
  }, 30000);
});

// ---------------------------------------------------------------------------
// Tool usage: Read
// ---------------------------------------------------------------------------

describe("live harness: Read tool", () => {
  skipIf(SKIP)("agent reads a file and reports its content", async () => {
    writeFileSync(join(tmpDir, "data.txt"), "The answer is 42.");

    const result = await runAgentLoop(opts({
      prompt: `Read the file ${join(tmpDir, "data.txt")}. Then return structured output with status "passed" and summary containing whatever the file says.`,
    }));

    expect(result.output!.status).toBe("passed");
    expect(result.output!.summary).toContain("42");
    expect(result.numTurns).toBeGreaterThanOrEqual(2); // Read + StructuredOutput
  }, 30000);
});

// ---------------------------------------------------------------------------
// Tool usage: Write
// ---------------------------------------------------------------------------

describe("live harness: Write tool", () => {
  skipIf(SKIP)("agent creates a file", async () => {
    const filePath = join(tmpDir, "output.txt");

    const result = await runAgentLoop(opts({
      prompt: `Write the text "hello from harness" to the file ${filePath}. Then return structured output with status "passed" and summary "file written".`,
    }));

    expect(result.output!.status).toBe("passed");
    expect(existsSync(filePath)).toBe(true);
    expect(readFileSync(filePath, "utf8")).toContain("hello from harness");
  }, 30000);
});

// ---------------------------------------------------------------------------
// Tool usage: Edit
// ---------------------------------------------------------------------------

describe("live harness: Edit tool", () => {
  skipIf(SKIP)("agent edits a file", async () => {
    const filePath = join(tmpDir, "edit-me.txt");
    writeFileSync(filePath, "old value here");

    const result = await runAgentLoop(opts({
      prompt: `Edit the file ${filePath}: replace "old value" with "new value". Then return structured output with status "passed".`,
    }));

    expect(result.output!.status).toBe("passed");
    expect(readFileSync(filePath, "utf8")).toContain("new value");
  }, 30000);
});

// ---------------------------------------------------------------------------
// Tool usage: Bash
// ---------------------------------------------------------------------------

describe("live harness: Bash tool", () => {
  skipIf(SKIP)("agent runs a command and reports output", async () => {
    const result = await runAgentLoop(opts({
      prompt: `Run the command "echo hello-from-bash" using the Bash tool. Then return structured output with status "passed" and summary containing the command output.`,
    }));

    expect(result.output!.status).toBe("passed");
    expect(result.output!.summary).toContain("hello");
  }, 30000);
});

// ---------------------------------------------------------------------------
// Tool usage: Glob
// ---------------------------------------------------------------------------

describe("live harness: Glob tool", () => {
  skipIf(SKIP)("agent finds files by pattern", async () => {
    writeFileSync(join(tmpDir, "a.ts"), "");
    writeFileSync(join(tmpDir, "b.ts"), "");
    writeFileSync(join(tmpDir, "c.js"), "");

    const result = await runAgentLoop(opts({
      prompt: `Use the Glob tool to find all .ts files in ${tmpDir}. Then return structured output with status "passed" and summary listing the files you found.`,
    }));

    expect(result.output!.status).toBe("passed");
    const summary = result.output!.summary as string;
    expect(summary).toContain("a.ts");
    expect(summary).toContain("b.ts");
  }, 30000);
});

// ---------------------------------------------------------------------------
// Tool usage: Grep
// ---------------------------------------------------------------------------

describe("live harness: Grep tool", () => {
  skipIf(SKIP)("agent searches file contents", async () => {
    writeFileSync(join(tmpDir, "search.txt"), "line one\nsecret: found-it\nline three");

    const result = await runAgentLoop(opts({
      prompt: `Use the Grep tool to search for "secret" in ${join(tmpDir, "search.txt")} with output_mode "content". Then return structured output with status "passed" and summary containing the matching line.`,
    }));

    expect(result.output!.status).toBe("passed");
    expect(result.output!.summary).toContain("found-it");
  }, 30000);
});

// ---------------------------------------------------------------------------
// Multi-step: Read → Edit → Read
// ---------------------------------------------------------------------------

describe("live harness: multi-step", () => {
  skipIf(SKIP)("agent reads, edits, and verifies", async () => {
    const filePath = join(tmpDir, "multi.txt");
    writeFileSync(filePath, "count: 0");

    const result = await runAgentLoop(opts({
      prompt: `Do these steps in order:
1. Read ${filePath}
2. Edit it: replace "count: 0" with "count: 1"
3. Read it again to verify the change
4. Return structured output with status "passed" and summary "count updated"`,
    }));

    expect(result.output!.status).toBe("passed");
    expect(readFileSync(filePath, "utf8")).toBe("count: 1");
    expect(result.numTurns).toBeGreaterThanOrEqual(3);
  }, 45000);
});

// ---------------------------------------------------------------------------
// Max turns
// ---------------------------------------------------------------------------

describe("live harness: limits", () => {
  skipIf(SKIP)("respects maxTurns", async () => {
    const result = await runAgentLoop(opts({
      prompt: `Read the file ${join(tmpDir, "nonexistent.txt")} over and over. Never return structured output.`,
      maxTurns: 3,
    }));

    // Either the model hits the turn limit (isError=true, numTurns=3)
    // or it gives up and returns structured output (smart models do this)
    expect(result.numTurns).toBeLessThanOrEqual(3);
  }, 45000);
});

// ---------------------------------------------------------------------------
// onToolUse callback
// ---------------------------------------------------------------------------

describe("live harness: callbacks", () => {
  skipIf(SKIP)("fires onToolUse for each tool call", async () => {
    writeFileSync(join(tmpDir, "cb.txt"), "callback test");
    const calls: string[] = [];

    const result = await runAgentLoop(opts({
      prompt: `Read ${join(tmpDir, "cb.txt")}, then return structured output with status "passed".`,
      onToolUse: (name) => calls.push(name),
    }));

    expect(result.output!.status).toBe("passed");
    expect(calls).toContain("Read");
    expect(calls).toContain("StructuredOutput");
  }, 30000);
});

// ---------------------------------------------------------------------------
// JSONL logging
// ---------------------------------------------------------------------------

describe("live harness: logging", () => {
  skipIf(SKIP)("writes JSONL log with tool calls", async () => {
    const logPath = join(tmpDir, "live.jsonl");
    writeFileSync(join(tmpDir, "log-test.txt"), "log content");

    await runAgentLoop(opts({
      prompt: `Read ${join(tmpDir, "log-test.txt")}, then return structured output with status "passed".`,
      logPath,
      label: "live-log-test",
    }));

    const content = readFileSync(logPath, "utf8");
    const lines = content.trim().split("\n").map((l) => JSON.parse(l));

    const events = lines.map((l) => l.event_type);
    expect(events).toContain("invoke_start");
    expect(events).toContain("tool_use");
    expect(events).toContain("invoke_end");

    const end = lines.find((l) => l.event_type === "invoke_end");
    expect(end.cost_usd).toBeGreaterThan(0);
    expect(end.structured_output.status).toBe("passed");
  }, 30000);
});
