import { describe, test, expect, mock, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, readFileSync, existsSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import type { ApiResponse, HarnessOptions } from "./types";
import { estimateCost } from "./types";

// ---------------------------------------------------------------------------
// Mock the fetch function to simulate the Anthropic API
// ---------------------------------------------------------------------------

const originalFetch = globalThis.fetch;
let mockResponses: ApiResponse[] = [];
let capturedRequests: any[] = [];

function setMockResponses(...responses: ApiResponse[]) {
  mockResponses = [...responses];
  capturedRequests = [];
}

beforeEach(() => {
  mockResponses = [];
  capturedRequests = [];

  globalThis.fetch = (async (url: string, init: any) => {
    const body = JSON.parse(init.body);
    capturedRequests.push(body);

    const response = mockResponses.shift();
    if (!response) {
      return { ok: false, status: 500, text: async () => "No mock response" } as any;
    }

    return {
      ok: true,
      json: async () => response,
    } as any;
  }) as any;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

// ---------------------------------------------------------------------------
// Import after mock setup
// ---------------------------------------------------------------------------

// We need to import dynamically so the tools module registers tools
const { runAgentLoop } = await import("./loop");

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeResponse(overrides: Partial<ApiResponse> = {}): ApiResponse {
  return {
    id: "msg_test",
    type: "message",
    role: "assistant",
    content: [{ type: "text", text: "Done." }],
    model: "claude-sonnet-4-20250514",
    stop_reason: "end_turn",
    usage: { input_tokens: 100, output_tokens: 50 },
    ...overrides,
  };
}

function makeToolUseResponse(toolName: string, toolInput: Record<string, unknown>, toolId = "toolu_01"): ApiResponse {
  return makeResponse({
    stop_reason: "tool_use",
    content: [
      { type: "text", text: "I'll do that." },
      { type: "tool_use", id: toolId, name: toolName, input: toolInput },
    ],
  });
}

function makeStructuredOutputResponse(output: Record<string, unknown>): ApiResponse {
  return makeResponse({
    stop_reason: "tool_use",
    content: [
      { type: "tool_use", id: "toolu_out", name: "StructuredOutput", input: output },
    ],
  });
}

let tmpDir: string;
const defaultOpts: () => HarnessOptions = () => ({
  prompt: "Test prompt",
  cwd: tmpDir,
  apiKey: "test-key",
});

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "harness-loop-"));
});

// ---------------------------------------------------------------------------
// Basic loop behavior
// ---------------------------------------------------------------------------

describe("agent loop basics", () => {
  test("returns structured output from StructuredOutput tool", async () => {
    setMockResponses(
      makeStructuredOutputResponse({ status: "passed", summary: "All good" }),
      // After StructuredOutput, the model gets the tool result and ends
      makeResponse({ content: [{ type: "text", text: "Done." }], stop_reason: "end_turn" }),
    );

    const result = await runAgentLoop(defaultOpts());
    expect(result.output).toEqual({ status: "passed", summary: "All good" });
    expect(result.isError).toBe(false);
    expect(result.numTurns).toBeGreaterThanOrEqual(1);
  });

  test("returns null output when model ends without structured output", async () => {
    setMockResponses(
      makeResponse({ content: [{ type: "text", text: "I give up." }] }),
    );

    const result = await runAgentLoop(defaultOpts());
    // Tries to extract JSON from text, fails
    expect(result.output).toBeNull();
  });

  test("tracks cost from usage", async () => {
    setMockResponses(
      makeStructuredOutputResponse({ status: "passed", summary: "done" }),
      makeResponse(),
    );

    const result = await runAgentLoop(defaultOpts());
    expect(result.costUsd).toBeGreaterThan(0);
  });

  test("tracks duration", async () => {
    setMockResponses(
      makeStructuredOutputResponse({ status: "passed", summary: "fast" }),
      makeResponse(),
    );

    const result = await runAgentLoop(defaultOpts());
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
  });

  test("respects maxTurns", async () => {
    // Model never returns structured output — just keeps using tools
    setMockResponses(
      makeToolUseResponse("Bash", { command: "echo 1" }, "t1"),
      makeToolUseResponse("Bash", { command: "echo 2" }, "t2"),
      makeToolUseResponse("Bash", { command: "echo 3" }, "t3"),
    );

    const result = await runAgentLoop({ ...defaultOpts(), maxTurns: 3 });
    expect(result.isError).toBe(true);
    expect(result.numTurns).toBe(3);
    expect(result.output?.status).toBe("failed");
    expect((result.output?.summary as string)).toContain("max turns");
  });

  test("sends system prompt to API", async () => {
    setMockResponses(
      makeStructuredOutputResponse({ status: "passed", summary: "ok" }),
      makeResponse(),
    );

    await runAgentLoop({ ...defaultOpts(), systemPrompt: "You are a test agent." });

    expect(capturedRequests[0].system).toContain("You are a test agent.");
    expect(capturedRequests[0].system).toContain("StructuredOutput");
  });

  test("sends user prompt as first message", async () => {
    setMockResponses(
      makeStructuredOutputResponse({ status: "passed", summary: "ok" }),
      makeResponse(),
    );

    await runAgentLoop({ ...defaultOpts(), prompt: "Build auth system" });
    expect(capturedRequests[0].messages[0].content).toBe("Build auth system");
  });
});

// ---------------------------------------------------------------------------
// Tool execution
// ---------------------------------------------------------------------------

describe("tool execution", () => {
  test("executes Read tool and returns result to model", async () => {
    const filePath = join(tmpDir, "test.txt");
    require("fs").writeFileSync(filePath, "file content");

    setMockResponses(
      makeToolUseResponse("Read", { file_path: filePath }),
      makeStructuredOutputResponse({ status: "passed", summary: "read it" }),
      makeResponse(),
    );

    const result = await runAgentLoop(defaultOpts());
    expect(result.output?.status).toBe("passed");

    // Second request should have tool_result in messages
    expect(capturedRequests.length).toBeGreaterThanOrEqual(2);
    const secondMsg = capturedRequests[1].messages;
    const toolResultMsg = secondMsg.find((m: any) =>
      Array.isArray(m.content) && m.content.some((c: any) => c.type === "tool_result")
    );
    expect(toolResultMsg).toBeDefined();
  });

  test("executes Bash tool", async () => {
    setMockResponses(
      makeToolUseResponse("Bash", { command: "echo hello" }),
      makeStructuredOutputResponse({ status: "passed", summary: "ran it" }),
      makeResponse(),
    );

    const result = await runAgentLoop(defaultOpts());
    expect(result.output?.status).toBe("passed");
  });

  test("executes Write tool", async () => {
    const filePath = join(tmpDir, "output.txt");

    setMockResponses(
      makeToolUseResponse("Write", { file_path: filePath, content: "written" }),
      makeStructuredOutputResponse({ status: "passed", summary: "wrote it" }),
      makeResponse(),
    );

    const result = await runAgentLoop(defaultOpts());
    expect(result.output?.status).toBe("passed");
    expect(readFileSync(filePath, "utf8")).toBe("written");
  });

  test("handles unknown tool gracefully", async () => {
    setMockResponses(
      makeToolUseResponse("NonExistentTool", { foo: "bar" }),
      makeStructuredOutputResponse({ status: "passed", summary: "recovered" }),
      makeResponse(),
    );

    const result = await runAgentLoop(defaultOpts());
    // Model gets error for unknown tool, then recovers
    expect(result.output?.status).toBe("passed");

    // Check that tool_result has is_error
    const secondReq = capturedRequests[1];
    const toolResults = secondReq.messages.flatMap((m: any) =>
      Array.isArray(m.content) ? m.content.filter((c: any) => c.type === "tool_result") : []
    );
    expect(toolResults[0].is_error).toBe(true);
  });

  test("fires onToolUse callback", async () => {
    const calls: { name: string; input: Record<string, unknown> }[] = [];

    setMockResponses(
      makeToolUseResponse("Bash", { command: "echo test" }),
      makeStructuredOutputResponse({ status: "passed", summary: "done" }),
      makeResponse(),
    );

    await runAgentLoop({
      ...defaultOpts(),
      onToolUse: (name, input) => calls.push({ name, input }),
    });

    expect(calls.length).toBeGreaterThanOrEqual(2); // Bash + StructuredOutput
    expect(calls[0].name).toBe("Bash");
    expect(calls[1].name).toBe("StructuredOutput");
  });
});

// ---------------------------------------------------------------------------
// Error handling
// ---------------------------------------------------------------------------

describe("error handling", () => {
  test("API error returns error result", async () => {
    globalThis.fetch = (async () => ({
      ok: false,
      status: 429,
      text: async () => "Rate limited",
    })) as any;

    const result = await runAgentLoop(defaultOpts());
    expect(result.isError).toBe(true);
    expect(result.output?.status).toBe("failed");
    expect((result.output?.summary as string)).toContain("429");
  });

  test("abort signal stops the loop", async () => {
    const controller = new AbortController();

    // Abort immediately
    controller.abort();

    setMockResponses(
      makeToolUseResponse("Bash", { command: "echo 1" }),
    );

    const result = await runAgentLoop({
      ...defaultOpts(),
      abortController: controller,
    });

    expect(result.isError).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// JSONL logging
// ---------------------------------------------------------------------------

describe("JSONL logging", () => {
  test("writes invoke_start and invoke_end", async () => {
    const logPath = join(tmpDir, "test.jsonl");

    setMockResponses(
      makeStructuredOutputResponse({ status: "passed", summary: "logged" }),
      makeResponse(),
    );

    await runAgentLoop({ ...defaultOpts(), logPath, label: "test-action" });

    const content = readFileSync(logPath, "utf8");
    const lines = content.trim().split("\n").map((l) => JSON.parse(l));

    const start = lines.find((l) => l.event_type === "invoke_start");
    expect(start).toBeDefined();
    expect(start.label).toBe("test-action");

    const end = lines.find((l) => l.event_type === "invoke_end");
    expect(end).toBeDefined();
    expect(end.cost_usd).toBeGreaterThanOrEqual(0);
    expect(end.structured_output.status).toBe("passed");
  });

  test("writes tool_use entries", async () => {
    const logPath = join(tmpDir, "tools.jsonl");

    setMockResponses(
      makeToolUseResponse("Bash", { command: "echo hi" }),
      makeStructuredOutputResponse({ status: "passed", summary: "done" }),
      makeResponse(),
    );

    await runAgentLoop({ ...defaultOpts(), logPath });

    const content = readFileSync(logPath, "utf8");
    const lines = content.trim().split("\n").map((l) => JSON.parse(l));

    const toolEntries = lines.filter((l) => l.event_type === "tool_use");
    expect(toolEntries.length).toBeGreaterThanOrEqual(1);
    expect(toolEntries[0].tool_name).toBe("Bash");
  });
});

// ---------------------------------------------------------------------------
// Cost estimation
// ---------------------------------------------------------------------------

describe("cost estimation", () => {
  test("sonnet pricing", () => {
    const cost = estimateCost("claude-sonnet-4-20250514", 1_000_000, 1_000_000);
    expect(cost).toBe(3.0 + 15.0); // $3/M input + $15/M output
  });

  test("opus pricing", () => {
    const cost = estimateCost("claude-opus-4-20250514", 1_000_000, 1_000_000);
    expect(cost).toBe(15.0 + 75.0);
  });

  test("haiku pricing", () => {
    const cost = estimateCost("claude-haiku-4-20250414", 1_000_000, 1_000_000);
    expect(cost).toBe(0.80 + 4.0);
  });

  test("model name fuzzy matching", () => {
    const cost = estimateCost("opus", 1_000_000, 0);
    expect(cost).toBe(15.0); // matches opus pricing
  });

  test("cache read tokens at 10% rate", () => {
    const cost = estimateCost("claude-sonnet-4-20250514", 0, 0, 1_000_000);
    expect(cost).toBeCloseTo(0.3); // 10% of $3/M
  });

  test("zero tokens = zero cost", () => {
    expect(estimateCost("claude-sonnet-4-20250514", 0, 0)).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Multi-turn conversation
// ---------------------------------------------------------------------------

describe("multi-turn conversation", () => {
  test("conversation accumulates across turns", async () => {
    setMockResponses(
      makeToolUseResponse("Bash", { command: "echo step1" }, "t1"),
      makeToolUseResponse("Bash", { command: "echo step2" }, "t2"),
      makeStructuredOutputResponse({ status: "passed", summary: "multi-step" }),
      makeResponse(),
    );

    const result = await runAgentLoop(defaultOpts());
    expect(result.output?.status).toBe("passed");
    expect(result.numTurns).toBe(3);

    // Third request should have full conversation history
    expect(capturedRequests[2].messages.length).toBeGreaterThanOrEqual(5);
    // user, assistant, user(tool_result), assistant, user(tool_result)
  });

  test("handles multiple tool uses in single response", async () => {
    setMockResponses(
      makeResponse({
        stop_reason: "tool_use",
        content: [
          { type: "tool_use", id: "t1", name: "Bash", input: { command: "echo a" } },
          { type: "tool_use", id: "t2", name: "Bash", input: { command: "echo b" } },
        ],
      }),
      makeStructuredOutputResponse({ status: "passed", summary: "parallel" }),
      makeResponse(),
    );

    const result = await runAgentLoop(defaultOpts());
    expect(result.output?.status).toBe("passed");

    // Tool results for both should be in the next request
    const secondReq = capturedRequests[1];
    const toolResults = secondReq.messages.flatMap((m: any) =>
      Array.isArray(m.content) ? m.content.filter((c: any) => c.type === "tool_result") : []
    );
    expect(toolResults.length).toBe(2);
  });
});
