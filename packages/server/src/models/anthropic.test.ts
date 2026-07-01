import { describe, test, expect } from "bun:test";
import { AnthropicProvider } from "./anthropic";
import type { ModelDelta, ModelMessage, ToolSchema } from "./types";

// ---------------------------------------------------------------------------
// Fake fetch harness — injected so no network / API key is needed.
// ---------------------------------------------------------------------------

interface WireResponse {
  content: unknown[];
  stop_reason: string | null;
  usage: Record<string, number>;
}

function makeProvider(response: WireResponse | { ok: false; status: number; body: string }) {
  const captured: { url: string; body: any; headers: any }[] = [];
  const fetchImpl = (async (url: string, init: any) => {
    captured.push({ url, body: JSON.parse(init.body), headers: init.headers });
    if ("ok" in response && response.ok === false) {
      return { ok: false, status: response.status, text: async () => response.body } as any;
    }
    return { ok: true, json: async () => response } as any;
  }) as unknown as typeof fetch;

  return { provider: new AnthropicProvider({ fetchImpl }), captured };
}

async function collect(stream: AsyncIterable<ModelDelta>): Promise<ModelDelta[]> {
  const out: ModelDelta[] = [];
  for await (const d of stream) out.push(d);
  return out;
}

const OPTS = { model: "claude-sonnet-4-6", apiKey: "test-key", system: "You are a test agent." };

describe("AnthropicProvider.stream", () => {
  test("yields text, usage, and stop for a plain response", async () => {
    const { provider } = makeProvider({
      content: [{ type: "text", text: "Hello world" }],
      stop_reason: "end_turn",
      usage: { input_tokens: 100, output_tokens: 20, cache_read_input_tokens: 10, cache_creation_input_tokens: 5 },
    });

    const deltas = await collect(provider.stream([{ role: "user", content: "hi" }], [], OPTS));

    expect(deltas).toContainEqual({ type: "text", text: "Hello world" });
    const usage = deltas.find((d) => d.type === "usage");
    expect(usage).toEqual({
      type: "usage",
      usage: { inputTokens: 100, outputTokens: 20, cacheReadTokens: 10, cacheWriteTokens: 5 },
    });
    expect(deltas.at(-1)).toEqual({ type: "stop", reason: "stop" });
  });

  test("assembles a tool call and reports stop=tool_use", async () => {
    const { provider } = makeProvider({
      content: [
        { type: "text", text: "let me read that" },
        { type: "tool_use", id: "toolu_1", name: "Read", input: { file_path: "/x.txt" } },
      ],
      stop_reason: "tool_use",
      usage: { input_tokens: 50, output_tokens: 30 },
    });

    const deltas = await collect(provider.stream([{ role: "user", content: "read x" }], [], OPTS));

    const call = deltas.find((d) => d.type === "tool_call");
    expect(call).toEqual({ type: "tool_call", toolCall: { id: "toolu_1", name: "Read", input: { file_path: "/x.txt" } } });
    expect(deltas.at(-1)).toEqual({ type: "stop", reason: "tool_use" });
  });

  test("normalizes usage with missing cache fields to zero", async () => {
    const { provider } = makeProvider({
      content: [{ type: "text", text: "ok" }],
      stop_reason: "end_turn",
      usage: { input_tokens: 7, output_tokens: 3 },
    });
    const deltas = await collect(provider.stream([{ role: "user", content: "hi" }], [], OPTS));
    const usage = deltas.find((d) => d.type === "usage") as any;
    expect(usage.usage.cacheReadTokens).toBe(0);
    expect(usage.usage.cacheWriteTokens).toBe(0);
  });

  test("translates neutral messages to the Anthropic wire format", async () => {
    const { provider, captured } = makeProvider({
      content: [{ type: "text", text: "done" }],
      stop_reason: "end_turn",
      usage: { input_tokens: 1, output_tokens: 1 },
    });

    const messages: ModelMessage[] = [
      { role: "user", content: "start" },
      {
        role: "assistant",
        content: [
          { type: "text", text: "reading" },
          { type: "tool_call", id: "t1", name: "Read", input: { file_path: "/a" } },
        ],
      },
      { role: "tool", content: [{ type: "tool_result", toolCallId: "t1", content: "file body" }] },
    ];

    await collect(provider.stream(messages, [], OPTS));

    const body = captured[0].body;
    expect(body.model).toBe("claude-sonnet-4-6");
    // system carried as a cached text block
    expect(body.system[0].text).toContain("You are a test agent.");
    expect(body.system[0].cache_control).toEqual({ type: "ephemeral" });
    // user string preserved
    expect(body.messages[0]).toEqual({ role: "user", content: "start" });
    // assistant tool_call -> tool_use block
    expect(body.messages[1].content).toContainEqual({ type: "tool_use", id: "t1", name: "Read", input: { file_path: "/a" } });
    // tool role -> user turn with tool_result block
    expect(body.messages[2]).toEqual({
      role: "user",
      content: [{ type: "tool_result", tool_use_id: "t1", content: "file body" }],
    });
  });

  test("marks the last tool with cache_control", async () => {
    const { provider, captured } = makeProvider({
      content: [{ type: "text", text: "ok" }],
      stop_reason: "end_turn",
      usage: { input_tokens: 1, output_tokens: 1 },
    });

    const tools: ToolSchema[] = [
      { name: "Read", description: "read", inputSchema: { type: "object" } },
      { name: "Write", description: "write", inputSchema: { type: "object" } },
    ];
    await collect(provider.stream([{ role: "user", content: "hi" }], tools, OPTS));

    const wireTools = captured[0].body.tools;
    expect(wireTools[0].name).toBe("Read");
    expect(wireTools[0].cache_control).toBeUndefined();
    expect(wireTools[1].cache_control).toEqual({ type: "ephemeral" });
    expect(wireTools[1].input_schema).toEqual({ type: "object" });
  });

  test("throws on a non-ok API response", async () => {
    const { provider } = makeProvider({ ok: false, status: 429, body: "Rate limited" });
    await expect(collect(provider.stream([{ role: "user", content: "hi" }], [], OPTS))).rejects.toThrow(/429/);
  });

  test("supports() claims anthropic and claude ids only", () => {
    const p = new AnthropicProvider();
    expect(p.supports("anthropic/claude-opus-4-6")).toBe(true);
    expect(p.supports("claude-sonnet-4-6")).toBe(true);
    expect(p.supports("openai/gpt-4o")).toBe(false);
  });
});
