import { describe, test, expect, beforeEach } from "bun:test";
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { agentLoop, runAgentLoop, type AgentLoopOptions, type AgentEvent } from "./agent-loop";
import { SessionStore } from "./sessions";
import { ModelRegistry } from "../models/registry";
import type { ModelProvider, ModelCapabilities, StreamOptions } from "../models/provider";
import type { ModelDelta, ModelMessage, ToolSchema, ToolCall, Usage } from "../models/types";

// ---------------------------------------------------------------------------
// Scripted provider — returns pre-canned turns and records what it was called
// with, so we can assert on message history (session resume) and tool_choice
// (forced final turn).
// ---------------------------------------------------------------------------

const CAPS: ModelCapabilities = {
  structuredOutput: true,
  parallelToolCalls: true,
  vision: false,
  promptCaching: true,
  maxContextTokens: 200_000,
};

function mkUsage(over: Partial<Usage> = {}): Usage {
  return { inputTokens: 100, outputTokens: 50, cacheReadTokens: 0, cacheWriteTokens: 0, ...over };
}

function textTurn(text: string, stop: "stop" | "max_tokens" = "stop", usage?: Usage): ModelDelta[] {
  return [{ type: "text", text }, { type: "usage", usage: usage ?? mkUsage() }, { type: "stop", reason: stop }];
}

function toolTurn(calls: ToolCall[], usage?: Usage): ModelDelta[] {
  return [
    ...calls.map((toolCall) => ({ type: "tool_call", toolCall }) as ModelDelta),
    { type: "usage", usage: usage ?? mkUsage() },
    { type: "stop", reason: "tool_use" },
  ];
}

function output(input: Record<string, unknown>, id = "out"): ModelDelta[] {
  return toolTurn([{ id, name: "StructuredOutput", input }]);
}

class ScriptProvider implements ModelProvider {
  readonly id = "anthropic";
  readonly capabilities = CAPS;
  readonly calls: { messages: ModelMessage[]; tools: ToolSchema[]; opts: StreamOptions }[] = [];
  private turns: ModelDelta[][];

  constructor(turns: ModelDelta[][]) {
    this.turns = [...turns];
  }
  supports(): boolean { return true; }
  async *stream(messages: ModelMessage[], tools: ToolSchema[], opts: StreamOptions): AsyncIterable<ModelDelta> {
    this.calls.push({ messages: JSON.parse(JSON.stringify(messages)), tools, opts });
    const turn = this.turns.shift() ?? [
      { type: "usage", usage: mkUsage() },
      { type: "stop", reason: "stop" },
    ];
    for (const d of turn) yield d;
  }
}

function registryFor(provider: ModelProvider): ModelRegistry {
  const reg = new ModelRegistry("anthropic/claude-sonnet-4-6");
  reg.registerProvider(provider);
  reg.registerModel({
    id: "anthropic/claude-sonnet-4-6",
    provider,
    apiModel: "claude-sonnet-4-6",
    price: { input: 3.0, output: 15.0, cacheRead: 0.3, cacheWrite: 3.75 },
    capabilities: CAPS,
  });
  return reg;
}

let tmpDir: string;
beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "agent-loop-"));
});

function opts(provider: ScriptProvider, over: Partial<AgentLoopOptions> = {}): AgentLoopOptions {
  return { prompt: "do the thing", cwd: tmpDir, apiKey: "test-key", registry: registryFor(provider), ...over };
}

// ---------------------------------------------------------------------------
// Structured output finalization
// ---------------------------------------------------------------------------

describe("structured output", () => {
  test("captures output from a direct StructuredOutput call", async () => {
    const p = new ScriptProvider([output({ status: "passed", summary: "all good" })]);
    const r = await runAgentLoop(opts(p));
    expect(r.output).toEqual({ status: "passed", summary: "all good" });
    expect(r.isError).toBe(false);
    expect(r.numTurns).toBe(1);
  });

  test("drives an explicit forced final turn when the model ends with prose", async () => {
    const p = new ScriptProvider([
      textTurn("I'm finished; everything works."),
      output({ status: "passed", summary: "forced final" }),
    ]);
    const r = await runAgentLoop(opts(p));
    expect(r.output).toEqual({ status: "passed", summary: "forced final" });
    expect(r.numTurns).toBe(2);

    // The forced final turn must force the output tool and offer only it.
    const finalCall = p.calls[1];
    expect(finalCall.opts.toolChoice).toEqual({ name: "StructuredOutput" });
    expect(finalCall.tools.map((t) => t.name)).toEqual(["StructuredOutput"]);
  });

  test("cost is computed from usage x price table", async () => {
    // 1M input @ $3 + 1M output @ $15 = $18.
    const p = new ScriptProvider([
      output({ status: "passed", summary: "x" }, "o1"),
    ]);
    const r = await runAgentLoop(opts(p, { model: "anthropic/claude-sonnet-4-6" }));
    // Single turn usage: 100 in + 50 out.
    expect(r.costUsd).toBeCloseTo((100 * 3 + 50 * 15) / 1_000_000, 10);
    expect(r.costUsd).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// Tool execution
// ---------------------------------------------------------------------------

describe("tool execution", () => {
  test("executes Read and feeds the result back to the model", async () => {
    const file = join(tmpDir, "data.txt");
    writeFileSync(file, "answer is 42");
    const p = new ScriptProvider([
      toolTurn([{ id: "r1", name: "Read", input: { file_path: file } }]),
      output({ status: "passed", summary: "read it" }),
    ]);
    const r = await runAgentLoop(opts(p));
    expect(r.output?.status).toBe("passed");

    // Second call must include the tool_result carrying file content.
    const second = p.calls[1].messages;
    const toolMsg = second.find((m) => Array.isArray(m.content) && (m.content as any[]).some((c) => c.type === "tool_result"));
    expect(toolMsg).toBeDefined();
    const tr = (toolMsg!.content as any[]).find((c) => c.type === "tool_result");
    expect(tr.content).toContain("42");
  });

  test("respects maxTurns and reports failure", async () => {
    const p = new ScriptProvider([
      toolTurn([{ id: "b1", name: "Bash", input: { command: "echo 1" } }]),
      toolTurn([{ id: "b2", name: "Bash", input: { command: "echo 2" } }]),
      toolTurn([{ id: "b3", name: "Bash", input: { command: "echo 3" } }]),
      toolTurn([{ id: "b4", name: "Bash", input: { command: "echo 4" } }]),
    ]);
    const r = await runAgentLoop(opts(p, { maxTurns: 3 }));
    expect(r.isError).toBe(true);
    expect(r.numTurns).toBe(3);
    expect(String(r.output?.summary)).toContain("max turns");
  });

  test("toolset filters the built-in tools offered to the model", async () => {
    const p = new ScriptProvider([output({ status: "passed", summary: "ok" })]);
    await runAgentLoop(opts(p, { toolset: "read_only" }));
    const names = p.calls[0].tools.map((t) => t.name);
    expect(names).toContain("Read");
    expect(names).toContain("Grep");
    expect(names).not.toContain("Write");
    expect(names).not.toContain("Bash");
    expect(names).toContain("StructuredOutput");
  });
});

// ---------------------------------------------------------------------------
// Tool execution — edge cases
// ---------------------------------------------------------------------------

describe("tool execution edge cases", () => {
  test("executes multiple tool calls in a single turn", async () => {
    const p = new ScriptProvider([
      toolTurn([
        { id: "a", name: "Bash", input: { command: "echo a" } },
        { id: "b", name: "Bash", input: { command: "echo b" } },
      ]),
      output({ status: "passed", summary: "both" }),
    ]);
    const r = await runAgentLoop(opts(p));
    expect(r.output?.status).toBe("passed");
    const second = p.calls[1].messages;
    const toolResults = second.flatMap((m) =>
      Array.isArray(m.content) ? (m.content as any[]).filter((c) => c.type === "tool_result") : [],
    );
    expect(toolResults.length).toBe(2);
  });

  test("reports an unknown tool as an error result and recovers", async () => {
    const p = new ScriptProvider([
      toolTurn([{ id: "u", name: "NoSuchTool", input: {} }]),
      output({ status: "passed", summary: "recovered" }),
    ]);
    const r = await runAgentLoop(opts(p));
    expect(r.output?.status).toBe("passed");
    const second = p.calls[1].messages;
    const tr = second.flatMap((m) => (Array.isArray(m.content) ? (m.content as any[]) : []))
      .find((c) => c.type === "tool_result");
    expect(tr.isError).toBe(true);
    expect(tr.content).toContain("Unknown tool");
  });

  test("fires onToolUse for each tool call including StructuredOutput", async () => {
    const file = join(tmpDir, "cb.txt");
    writeFileSync(file, "x");
    const p = new ScriptProvider([
      toolTurn([{ id: "r", name: "Read", input: { file_path: file } }]),
      output({ status: "passed", summary: "done" }),
    ]);
    const names: string[] = [];
    await runAgentLoop(opts(p, { onToolUse: (n) => names.push(n) }));
    expect(names).toContain("Read");
    expect(names).toContain("StructuredOutput");
  });

  test("aborts immediately when the signal is already aborted", async () => {
    const controller = new AbortController();
    controller.abort();
    const p = new ScriptProvider([toolTurn([{ id: "b", name: "Bash", input: { command: "echo 1" } }])]);
    const r = await runAgentLoop(opts(p, { abortController: controller }));
    expect(r.isError).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// JSONL logging
// ---------------------------------------------------------------------------

describe("JSONL logging", () => {
  test("writes invoke_start, tool_use and invoke_end tagged with the label", async () => {
    const logPath = join(tmpDir, "run.jsonl");
    const file = join(tmpDir, "l.txt");
    writeFileSync(file, "content");
    const p = new ScriptProvider([
      toolTurn([{ id: "r", name: "Read", input: { file_path: file } }]),
      output({ status: "passed", summary: "logged" }),
    ]);
    await runAgentLoop(opts(p, { logPath, label: "task.x" }));

    const lines = readFileSync(logPath, "utf8").trim().split("\n").map((l) => JSON.parse(l));
    const events = lines.map((l) => l.event_type);
    expect(events).toContain("invoke_start");
    expect(events).toContain("tool_use");
    expect(events).toContain("invoke_end");
    for (const l of lines) expect(l.label).toBe("task.x");
    const end = lines.find((l) => l.event_type === "invoke_end");
    expect(end.structured_output.status).toBe("passed");
    expect(end.cost_usd).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// Scope enforcement
// ---------------------------------------------------------------------------

describe("scope enforcement", () => {
  test("denies a write outside the writable scope", async () => {
    const forbidden = join(tmpDir, "forbidden.txt");
    const p = new ScriptProvider([
      toolTurn([{ id: "w1", name: "Write", input: { file_path: forbidden, content: "nope" } }]),
      output({ status: "failed", summary: "blocked" }),
    ]);
    const r = await runAgentLoop(opts(p, { scope: { writable: ["src/**"] } }));

    // The file must NOT have been written.
    expect(existsSync(forbidden)).toBe(false);
    // The tool_result fed back must be a scope violation error.
    const second = p.calls[1].messages;
    const toolMsg = second.find((m) => Array.isArray(m.content) && (m.content as any[]).some((c) => c.type === "tool_result"));
    const tr = (toolMsg!.content as any[]).find((c) => c.type === "tool_result");
    expect(tr.isError).toBe(true);
    expect(tr.content).toContain("Scope violation");
    expect(r.output?.status).toBe("failed");
  });
});

// ---------------------------------------------------------------------------
// Source-tagged event emission
// ---------------------------------------------------------------------------

describe("event emission", () => {
  test("tags every event with the source action id", async () => {
    const file = join(tmpDir, "f");
    writeFileSync(file, "hi");
    const firstTurn: ModelDelta[] = [
      { type: "text", text: "thinking" },
      { type: "tool_call", toolCall: { id: "r", name: "Read", input: { file_path: file } } },
      { type: "usage", usage: mkUsage() },
      { type: "stop", reason: "tool_use" },
    ];
    const p = new ScriptProvider([firstTurn, output({ status: "passed", summary: "done" })]);

    const events: AgentEvent[] = [];
    for await (const ev of agentLoop(opts(p, { label: "task.develop" }))) events.push(ev);

    expect(events.length).toBeGreaterThan(0);
    for (const ev of events) expect(ev.source).toBe("task.develop");
    expect(events.some((e) => e.type === "text")).toBe(true);
    expect(events.some((e) => e.type === "tool_use" && e.toolName === "Read")).toBe(true);
    expect(events.at(-1)?.type).toBe("result");
  });
});

// ---------------------------------------------------------------------------
// Durable sessions: persist + resume
// ---------------------------------------------------------------------------

describe("durable sessions", () => {
  test("persists conversation state and resumes it by sessionId", async () => {
    const store = new SessionStore(":memory:");

    // Run 1 — a normal completed run.
    const p1 = new ScriptProvider([output({ status: "passed", summary: "first" })]);
    const r1 = await runAgentLoop(opts(p1, { sessions: store, label: "s.act" }));
    expect(r1.sessionId).toBeTruthy();
    const sid = r1.sessionId!;

    // The session row exists and stores the message history.
    const saved = store.load(sid);
    expect(saved).not.toBeNull();
    expect(saved!.messages.length).toBeGreaterThanOrEqual(2); // user + assistant
    expect(saved!.messages[0]).toEqual({ role: "user", content: "do the thing" });

    // Run 2 — resume the same session with a follow-up prompt.
    const p2 = new ScriptProvider([output({ status: "passed", summary: "second" })]);
    await runAgentLoop(opts(p2, { sessions: store, sessionId: sid, prompt: "follow up" }));

    // The resumed run's provider must have seen the PRIOR history plus the new prompt.
    const seen = p2.calls[0].messages;
    expect(seen[0]).toEqual({ role: "user", content: "do the thing" });
    expect(seen.some((m) => m.role === "user" && m.content === "follow up")).toBe(true);
    // First user prompt precedes the follow-up prompt.
    const firstIdx = seen.findIndex((m) => m.content === "do the thing");
    const followIdx = seen.findIndex((m) => m.content === "follow up");
    expect(firstIdx).toBeLessThan(followIdx);

    // Persisted turn count accumulates across resumes.
    const after = store.load(sid)!;
    expect(after.numTurns).toBeGreaterThanOrEqual(2);
  });

  test("a fresh run without a store has a null sessionId", async () => {
    const p = new ScriptProvider([output({ status: "passed", summary: "x" })]);
    const r = await runAgentLoop(opts(p));
    expect(r.sessionId).toBeNull();
  });
});
