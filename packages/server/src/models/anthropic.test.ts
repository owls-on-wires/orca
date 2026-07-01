import { describe, test, expect } from "bun:test";
import { AnthropicProvider, decodeAnthropicStream, parseSSEStream, type AnthropicStreamEvent } from "./anthropic";
import type { ModelDelta, ModelMessage, ToolSchema } from "./types";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function collect(stream: AsyncIterable<ModelDelta>): Promise<ModelDelta[]> {
  const out: ModelDelta[] = [];
  for await (const d of stream) out.push(d);
  return out;
}

/** Build an SSE byte stream from a list of Anthropic stream events. */
function sseBody(events: AnthropicStreamEvent[]): ReadableStream<Uint8Array> {
  const enc = new TextEncoder();
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const ev of events) {
        controller.enqueue(enc.encode(`event: ${ev.type}\ndata: ${JSON.stringify(ev)}\n\n`));
      }
      controller.close();
    },
  });
}

/**
 * A canonical successful turn: text "Hello world", a tool_use whose arguments
 * arrive in fragments, then usage + stop. `argFragments` lets tests split the
 * tool-arg JSON however they like to exercise accumulation.
 */
function turnEvents(opts: {
  text?: string;
  tool?: { id: string; name: string; argFragments: string[] };
  stopReason?: string;
  usage?: Record<string, number>;
}): AnthropicStreamEvent[] {
  const events: AnthropicStreamEvent[] = [];
  events.push({
    type: "message_start",
    message: { usage: { input_tokens: opts.usage?.input_tokens ?? 10, output_tokens: 0, ...opts.usage } },
  } as AnthropicStreamEvent);

  let index = 0;
  if (opts.text !== undefined) {
    events.push({ type: "content_block_start", index, content_block: { type: "text" } } as AnthropicStreamEvent);
    events.push({ type: "content_block_delta", index, delta: { type: "text_delta", text: opts.text } } as AnthropicStreamEvent);
    events.push({ type: "content_block_stop", index } as AnthropicStreamEvent);
    index++;
  }
  if (opts.tool) {
    events.push({
      type: "content_block_start",
      index,
      content_block: { type: "tool_use", id: opts.tool.id, name: opts.tool.name },
    } as AnthropicStreamEvent);
    for (const frag of opts.tool.argFragments) {
      events.push({ type: "content_block_delta", index, delta: { type: "input_json_delta", partial_json: frag } } as AnthropicStreamEvent);
    }
    events.push({ type: "content_block_stop", index } as AnthropicStreamEvent);
    index++;
  }
  events.push({
    type: "message_delta",
    delta: { stop_reason: opts.stopReason ?? (opts.tool ? "tool_use" : "end_turn") },
    usage: { output_tokens: opts.usage?.output_tokens ?? 20 },
  } as AnthropicStreamEvent);
  events.push({ type: "message_stop" } as AnthropicStreamEvent);
  return events;
}

function makeProvider(events?: AnthropicStreamEvent[], override?: { ok: false; status: number; body: string }) {
  const captured: { url: string; body: any; headers: any }[] = [];
  const fetchImpl = (async (url: string, init: any) => {
    captured.push({ url, body: JSON.parse(init.body), headers: init.headers });
    if (override) {
      return { ok: false, status: override.status, text: async () => override.body } as any;
    }
    return { ok: true, status: 200, body: sseBody(events ?? []) } as any;
  }) as unknown as typeof fetch;
  return { provider: new AnthropicProvider({ fetchImpl }), captured };
}

const OPTS = { model: "claude-sonnet-4-6", apiKey: "test-key", system: "You are a test agent." };

// ---------------------------------------------------------------------------
// Tool-arg accumulation — the classic bug source (GATE)
// ---------------------------------------------------------------------------

describe("decodeAnthropicStream: tool-arg accumulation", () => {
  test("reconstructs exact JSON from canned input_json_delta chunks", async () => {
    const fullInput = { file_path: "/repo/src/index.ts", offset: 10, limit: 200, flag: true };
    const fullJson = JSON.stringify(fullInput);
    // Split the JSON into awkward fragments (mid-key, mid-value, mid-number).
    const fragments = [
      fullJson.slice(0, 3),
      fullJson.slice(3, 7),
      fullJson.slice(7, 20),
      fullJson.slice(20, 21),
      fullJson.slice(21, fullJson.length - 4),
      fullJson.slice(fullJson.length - 4),
    ];
    expect(fragments.join("")).toBe(fullJson);

    const deltas = await collect(
      decodeAnthropicStream(turnEvents({ tool: { id: "toolu_9", name: "Read", argFragments: fragments } })),
    );

    const call = deltas.find((d) => d.type === "tool_call");
    expect(call).toEqual({ type: "tool_call", toolCall: { id: "toolu_9", name: "Read", input: fullInput } });
  });

  test("keeps two concurrent tool blocks separated by content-block index", async () => {
    // Interleave fragments for index 0 and index 1 in arrival order.
    const events: AnthropicStreamEvent[] = [
      { type: "message_start", message: { usage: { input_tokens: 5, output_tokens: 0 } } },
      { type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "a", name: "Read" } },
      { type: "content_block_start", index: 1, content_block: { type: "tool_use", id: "b", name: "Write" } },
      { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: '{"file_path":' } },
      { type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: '{"file_path":"/b",' } },
      { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: '"/a"}' } },
      { type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: '"content":"hi"}' } },
      { type: "content_block_stop", index: 0 },
      { type: "content_block_stop", index: 1 },
      { type: "message_delta", delta: { stop_reason: "tool_use" }, usage: { output_tokens: 12 } },
      { type: "message_stop" },
    ] as AnthropicStreamEvent[];

    const deltas = await collect(decodeAnthropicStream(events));
    const calls = deltas.filter((d) => d.type === "tool_call");
    expect(calls).toEqual([
      { type: "tool_call", toolCall: { id: "a", name: "Read", input: { file_path: "/a" } } },
      { type: "tool_call", toolCall: { id: "b", name: "Write", input: { file_path: "/b", content: "hi" } } },
    ]);
  });

  test("empty tool-arg stream yields input {}", async () => {
    const deltas = await collect(
      decodeAnthropicStream(turnEvents({ tool: { id: "t0", name: "Noop", argFragments: [] } })),
    );
    const call = deltas.find((d) => d.type === "tool_call");
    expect(call).toEqual({ type: "tool_call", toolCall: { id: "t0", name: "Noop", input: {} } });
  });
});

// ---------------------------------------------------------------------------
// Usage + stop
// ---------------------------------------------------------------------------

describe("decodeAnthropicStream: usage and stop", () => {
  test("assembles usage from message_start (input+cache) and message_delta (output)", async () => {
    const events: AnthropicStreamEvent[] = [
      { type: "message_start", message: { usage: { input_tokens: 100, output_tokens: 1, cache_read_input_tokens: 40, cache_creation_input_tokens: 25 } } },
      { type: "content_block_start", index: 0, content_block: { type: "text" } },
      { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "ok" } },
      { type: "content_block_stop", index: 0 },
      { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 55 } },
      { type: "message_stop" },
    ] as AnthropicStreamEvent[];

    const deltas = await collect(decodeAnthropicStream(events));
    const usage = deltas.find((d) => d.type === "usage");
    expect(usage).toEqual({
      type: "usage",
      usage: { inputTokens: 100, outputTokens: 55, cacheReadTokens: 40, cacheWriteTokens: 25 },
    });
    expect(deltas.at(-1)).toEqual({ type: "stop", reason: "stop" });
  });

  test("missing cache fields normalize to zero", async () => {
    const deltas = await collect(decodeAnthropicStream(turnEvents({ text: "hi" })));
    const usage = deltas.find((d) => d.type === "usage") as any;
    expect(usage.usage.cacheReadTokens).toBe(0);
    expect(usage.usage.cacheWriteTokens).toBe(0);
  });

  test("maps stop_reason tool_use and max_tokens", async () => {
    const toolStop = (await collect(decodeAnthropicStream(turnEvents({ tool: { id: "x", name: "Read", argFragments: ["{}"] } })))).at(-1);
    expect(toolStop).toEqual({ type: "stop", reason: "tool_use" });

    const maxStop = (await collect(decodeAnthropicStream(turnEvents({ text: "…", stopReason: "max_tokens" })))).at(-1);
    expect(maxStop).toEqual({ type: "stop", reason: "max_tokens" });
  });

  test("throws on an error event", async () => {
    const events = [{ type: "error", error: { type: "overloaded_error", message: "overloaded" } }] as AnthropicStreamEvent[];
    await expect(collect(decodeAnthropicStream(events))).rejects.toThrow(/overloaded/);
  });
});

// ---------------------------------------------------------------------------
// SSE framing
// ---------------------------------------------------------------------------

describe("parseSSEStream", () => {
  test("parses events split arbitrarily across chunks", async () => {
    const enc = new TextEncoder();
    const raw =
      'event: message_start\ndata: {"type":"message_start","message":{"usage":{"input_tokens":3,"output_tokens":0}}}\n\n' +
      'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text"}}\n\n' +
      'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"hi"}}\n\n' +
      'event: content_block_stop\ndata: {"type":"content_block_stop","index":0}\n\n' +
      'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":9}}\n\n' +
      'event: message_stop\ndata: {"type":"message_stop"}\n\n';
    const bytes = enc.encode(raw);

    // Feed the bytes in tiny, boundary-splitting chunks.
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        for (let i = 0; i < bytes.length; i += 7) controller.enqueue(bytes.slice(i, i + 7));
        controller.close();
      },
    });

    const events: AnthropicStreamEvent[] = [];
    for await (const ev of parseSSEStream(body)) events.push(ev);
    expect(events.map((e) => e.type)).toEqual([
      "message_start", "content_block_start", "content_block_delta", "content_block_stop", "message_delta", "message_stop",
    ]);

    const deltas = await collect(decodeAnthropicStream(events));
    expect(deltas).toContainEqual({ type: "text", text: "hi" });
    expect(deltas.at(-1)).toEqual({ type: "stop", reason: "stop" });
  });
});

// ---------------------------------------------------------------------------
// Provider.stream — end to end over a fake SSE body
// ---------------------------------------------------------------------------

describe("AnthropicProvider.stream", () => {
  test("yields text, usage, and stop for a plain response", async () => {
    const { provider } = makeProvider(turnEvents({ text: "Hello world", usage: { input_tokens: 100, output_tokens: 20 } }));
    const deltas = await collect(provider.stream([{ role: "user", content: "hi" }], [], OPTS));
    expect(deltas).toContainEqual({ type: "text", text: "Hello world" });
    const usage = deltas.find((d) => d.type === "usage") as any;
    expect(usage.usage.inputTokens).toBe(100);
    expect(usage.usage.outputTokens).toBe(20);
    expect(deltas.at(-1)).toEqual({ type: "stop", reason: "stop" });
  });

  test("assembles a tool call and reports stop=tool_use", async () => {
    const { provider } = makeProvider(
      turnEvents({ text: "let me read", tool: { id: "toolu_1", name: "Read", argFragments: ['{"file_path"', ':"/x.txt"}'] } }),
    );
    const deltas = await collect(provider.stream([{ role: "user", content: "read x" }], [], OPTS));
    const call = deltas.find((d) => d.type === "tool_call");
    expect(call).toEqual({ type: "tool_call", toolCall: { id: "toolu_1", name: "Read", input: { file_path: "/x.txt" } } });
    expect(deltas.at(-1)).toEqual({ type: "stop", reason: "tool_use" });
  });

  test("sends stream:true and translates neutral messages to the wire format", async () => {
    const { provider, captured } = makeProvider(turnEvents({ text: "done" }));
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
    expect(body.stream).toBe(true);
    expect(body.model).toBe("claude-sonnet-4-6");
    expect(body.system[0].text).toContain("You are a test agent.");
    expect(body.system[0].cache_control).toEqual({ type: "ephemeral" });
    expect(body.messages[0]).toEqual({ role: "user", content: "start" });
    expect(body.messages[1].content).toContainEqual({ type: "tool_use", id: "t1", name: "Read", input: { file_path: "/a" } });
    expect(body.messages[2]).toEqual({
      role: "user",
      content: [{ type: "tool_result", tool_use_id: "t1", content: "file body" }],
    });
  });

  test("marks the last tool with cache_control and forwards tool_choice", async () => {
    const { provider, captured } = makeProvider(turnEvents({ text: "ok" }));
    const tools: ToolSchema[] = [
      { name: "Read", description: "read", inputSchema: { type: "object" } },
      { name: "Write", description: "write", inputSchema: { type: "object" } },
    ];
    await collect(provider.stream([{ role: "user", content: "hi" }], tools, { ...OPTS, toolChoice: { name: "Write" } }));
    const wireTools = captured[0].body.tools;
    expect(wireTools[0].cache_control).toBeUndefined();
    expect(wireTools[1].cache_control).toEqual({ type: "ephemeral" });
    expect(captured[0].body.tool_choice).toEqual({ type: "tool", name: "Write" });
  });

  test("throws on a non-ok API response", async () => {
    const { provider } = makeProvider(undefined, { ok: false, status: 429, body: "Rate limited" });
    await expect(collect(provider.stream([{ role: "user", content: "hi" }], [], OPTS))).rejects.toThrow(/429/);
  });

  test("supports() claims anthropic and claude ids only", () => {
    const p = new AnthropicProvider();
    expect(p.supports("anthropic/claude-opus-4-6")).toBe(true);
    expect(p.supports("claude-sonnet-4-6")).toBe(true);
    expect(p.supports("openai/gpt-4o")).toBe(false);
  });
});
