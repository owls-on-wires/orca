import { describe, test, expect } from "bun:test";
import {
  OpenAIProvider,
  decodeOpenAIStream,
  parseOpenAISSE,
  toStrictJsonSchema,
  type OpenAIStreamChunk,
} from "./openai";
import type { ModelDelta, ModelMessage, ToolSchema } from "./types";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function collect(stream: AsyncIterable<ModelDelta>): Promise<ModelDelta[]> {
  const out: ModelDelta[] = [];
  for await (const d of stream) out.push(d);
  return out;
}

const USAGE = { prompt_tokens: 100, completion_tokens: 20, prompt_tokens_details: { cached_tokens: 0 } };

/** A streamed function-call turn whose arguments arrive in the given fragments. */
function toolChunks(opts: {
  id: string;
  name: string;
  argFragments: string[];
  index?: number;
  usage?: Record<string, unknown>;
}): OpenAIStreamChunk[] {
  const index = opts.index ?? 0;
  const chunks: OpenAIStreamChunk[] = [];
  chunks.push({
    choices: [{ index: 0, delta: { role: "assistant", content: null, tool_calls: [{ index, id: opts.id, type: "function", function: { name: opts.name, arguments: "" } }] }, finish_reason: null }],
  });
  for (const frag of opts.argFragments) {
    chunks.push({ choices: [{ index: 0, delta: { tool_calls: [{ index, function: { arguments: frag } }] }, finish_reason: null }] });
  }
  chunks.push({ choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] });
  chunks.push({ choices: [], usage: (opts.usage ?? USAGE) as any });
  return chunks;
}

/** Build an OpenAI SSE byte stream from chunks + a [DONE] sentinel. */
function sseBody(chunks: OpenAIStreamChunk[]): ReadableStream<Uint8Array> {
  const enc = new TextEncoder();
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const c of chunks) controller.enqueue(enc.encode(`data: ${JSON.stringify(c)}\n\n`));
      controller.enqueue(enc.encode("data: [DONE]\n\n"));
      controller.close();
    },
  });
}

function makeProvider(chunks?: OpenAIStreamChunk[], override?: { status: number; body: string }) {
  const captured: { url: string; body: any; headers: any }[] = [];
  const fetchImpl = (async (url: string, init: any) => {
    captured.push({ url, body: JSON.parse(init.body), headers: init.headers });
    if (override) return { ok: false, status: override.status, text: async () => override.body } as any;
    return { ok: true, status: 200, body: sseBody(chunks ?? []) } as any;
  }) as unknown as typeof fetch;
  return { provider: new OpenAIProvider({ fetchImpl }), captured };
}

const OPTS = { model: "gpt-4o-mini", apiKey: "test-key", system: "You are a test agent." };

// ---------------------------------------------------------------------------
// Tool-arg accumulation by tool index — the classic bug source (GATE)
// ---------------------------------------------------------------------------

describe("decodeOpenAIStream: tool-arg accumulation by index", () => {
  test("reconstructs exact JSON from fragmented arguments (name only on first fragment)", async () => {
    const fullInput = { file_path: "/repo/src/index.ts", offset: 10, limit: 200, flag: true };
    const fullJson = JSON.stringify(fullInput);
    const fragments = [
      fullJson.slice(0, 3),
      fullJson.slice(3, 9),
      fullJson.slice(9, 25),
      fullJson.slice(25, fullJson.length - 5),
      fullJson.slice(fullJson.length - 5),
    ];
    expect(fragments.join("")).toBe(fullJson);

    const deltas = await collect(decodeOpenAIStream(toolChunks({ id: "call_9", name: "Read", argFragments: fragments })));
    const call = deltas.find((d) => d.type === "tool_call");
    expect(call).toEqual({ type: "tool_call", toolCall: { id: "call_9", name: "Read", input: fullInput } });
  });

  test("keeps two concurrent tool indices separated", async () => {
    const chunks: OpenAIStreamChunk[] = [
      { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: "a", type: "function", function: { name: "Read", arguments: "" } }] }, finish_reason: null }] },
      { choices: [{ index: 0, delta: { tool_calls: [{ index: 1, id: "b", type: "function", function: { name: "Write", arguments: "" } }] }, finish_reason: null }] },
      { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: '{"file_path":' } }] }, finish_reason: null }] },
      { choices: [{ index: 0, delta: { tool_calls: [{ index: 1, function: { arguments: '{"file_path":"/b",' } }] }, finish_reason: null }] },
      { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: '"/a"}' } }] }, finish_reason: null }] },
      { choices: [{ index: 0, delta: { tool_calls: [{ index: 1, function: { arguments: '"content":"hi"}' } }] }, finish_reason: null }] },
      { choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] },
      { choices: [], usage: USAGE as any },
    ];
    const deltas = await collect(decodeOpenAIStream(chunks));
    const calls = deltas.filter((d) => d.type === "tool_call");
    expect(calls).toEqual([
      { type: "tool_call", toolCall: { id: "a", name: "Read", input: { file_path: "/a" } } },
      { type: "tool_call", toolCall: { id: "b", name: "Write", input: { file_path: "/b", content: "hi" } } },
    ]);
  });

  test("empty tool-arg stream yields input {}", async () => {
    const deltas = await collect(decodeOpenAIStream(toolChunks({ id: "t0", name: "Noop", argFragments: [] })));
    const call = deltas.find((d) => d.type === "tool_call");
    expect(call).toEqual({ type: "tool_call", toolCall: { id: "t0", name: "Noop", input: {} } });
  });
});

// ---------------------------------------------------------------------------
// Usage + stop — cache split, cacheWrite=0, include_usage final chunk
// ---------------------------------------------------------------------------

describe("decodeOpenAIStream: usage and stop", () => {
  test("splits cached prompt tokens into cacheRead; cacheWrite is 0", async () => {
    const chunks: OpenAIStreamChunk[] = [
      { choices: [{ index: 0, delta: { role: "assistant", content: "ok" }, finish_reason: null }] },
      { choices: [{ index: 0, delta: {}, finish_reason: "stop" }] },
      { choices: [], usage: { prompt_tokens: 100, completion_tokens: 55, prompt_tokens_details: { cached_tokens: 40 } } as any },
    ];
    const deltas = await collect(decodeOpenAIStream(chunks));
    const usage = deltas.find((d) => d.type === "usage");
    expect(usage).toEqual({
      type: "usage",
      usage: { inputTokens: 60, outputTokens: 55, cacheReadTokens: 40, cacheWriteTokens: 0 },
    });
    expect(deltas.at(-1)).toEqual({ type: "stop", reason: "stop" });
  });

  test("missing usage normalizes to zero (cacheWrite tolerated at 0)", async () => {
    const chunks: OpenAIStreamChunk[] = [
      { choices: [{ index: 0, delta: { content: "hi" }, finish_reason: "stop" }] },
    ];
    const deltas = await collect(decodeOpenAIStream(chunks));
    const usage = deltas.find((d) => d.type === "usage") as any;
    expect(usage.usage).toEqual({ inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 });
  });

  test("maps finish_reason tool_calls and length", async () => {
    const toolStop = (await collect(decodeOpenAIStream(toolChunks({ id: "x", name: "Read", argFragments: ["{}"] })))).at(-1);
    expect(toolStop).toEqual({ type: "stop", reason: "tool_use" });

    const lenStop = (await collect(decodeOpenAIStream([{ choices: [{ index: 0, delta: { content: "…" }, finish_reason: "length" }] }]))).at(-1);
    expect(lenStop).toEqual({ type: "stop", reason: "max_tokens" });
  });
});

// ---------------------------------------------------------------------------
// toStrictJsonSchema
// ---------------------------------------------------------------------------

describe("toStrictJsonSchema", () => {
  test("adds additionalProperties:false and requires every property, recursively", () => {
    const schema = {
      type: "object",
      properties: {
        status: { type: "string", enum: ["passed", "failed"] },
        summary: { type: "string" },
        meta: { type: "object", properties: { count: { type: "number" } } },
      },
      required: ["status"],
    };
    const strict = toStrictJsonSchema(schema);
    expect(strict.additionalProperties).toBe(false);
    expect(strict.required).toEqual(["status", "summary", "meta"]);
    const meta = (strict.properties as any).meta;
    expect(meta.additionalProperties).toBe(false);
    expect(meta.required).toEqual(["count"]);
  });
});

// ---------------------------------------------------------------------------
// parseOpenAISSE framing
// ---------------------------------------------------------------------------

describe("parseOpenAISSE", () => {
  test("parses chunks split arbitrarily across byte boundaries; ignores [DONE]", async () => {
    const enc = new TextEncoder();
    const raw =
      'data: {"choices":[{"index":0,"delta":{"content":"hi"},"finish_reason":null}]}\n\n' +
      'data: {"choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\n' +
      'data: {"choices":[],"usage":{"prompt_tokens":5,"completion_tokens":2}}\n\n' +
      "data: [DONE]\n\n";
    const bytes = enc.encode(raw);
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        for (let i = 0; i < bytes.length; i += 5) controller.enqueue(bytes.slice(i, i + 5));
        controller.close();
      },
    });

    const chunks: OpenAIStreamChunk[] = [];
    for await (const c of parseOpenAISSE(body)) chunks.push(c);
    expect(chunks.length).toBe(3); // [DONE] is not emitted

    const deltas = await collect(decodeOpenAIStream(chunks));
    expect(deltas).toContainEqual({ type: "text", text: "hi" });
    expect(deltas.at(-1)).toEqual({ type: "stop", reason: "stop" });
  });
});

// ---------------------------------------------------------------------------
// Message-shape translation + request body (GATE surfaces)
// ---------------------------------------------------------------------------

describe("OpenAIProvider.stream: request translation", () => {
  test("translates neutral messages to OpenAI role:'tool' keyed by tool_call_id", async () => {
    const { provider, captured } = makeProvider([{ choices: [{ index: 0, delta: { content: "done" }, finish_reason: "stop" }] }, { choices: [], usage: USAGE as any }]);
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
    expect(body.stream_options).toEqual({ include_usage: true });
    expect(body.model).toBe("gpt-4o-mini");
    expect(body.messages[0]).toEqual({ role: "system", content: "You are a test agent." });
    expect(body.messages[1]).toEqual({ role: "user", content: "start" });
    expect(body.messages[2]).toEqual({
      role: "assistant",
      content: "reading",
      tool_calls: [{ id: "t1", type: "function", function: { name: "Read", arguments: JSON.stringify({ file_path: "/a" }) } }],
    });
    expect(body.messages[3]).toEqual({ role: "tool", tool_call_id: "t1", content: "file body" });
  });

  test("normal turn sends function tools with tool_choice auto", async () => {
    const { provider, captured } = makeProvider([{ choices: [{ index: 0, delta: { content: "ok" }, finish_reason: "stop" }] }, { choices: [], usage: USAGE as any }]);
    const tools: ToolSchema[] = [{ name: "Read", description: "read", inputSchema: { type: "object" } }];
    await collect(provider.stream([{ role: "user", content: "hi" }], tools, OPTS));
    const body = captured[0].body;
    expect(body.tools).toEqual([{ type: "function", function: { name: "Read", description: "read", parameters: { type: "object" } } }]);
    expect(body.tool_choice).toBe("auto");
    expect(body.response_format).toBeUndefined();
  });

  test("toolChoice 'any' maps to required", async () => {
    const { provider, captured } = makeProvider([{ choices: [{ index: 0, delta: { content: "ok" }, finish_reason: "stop" }] }, { choices: [], usage: USAGE as any }]);
    const tools: ToolSchema[] = [{ name: "Read", description: "read", inputSchema: { type: "object" } }];
    await collect(provider.stream([{ role: "user", content: "hi" }], tools, { ...OPTS, toolChoice: "any" }));
    expect(captured[0].body.tool_choice).toBe("required");
  });

  test("forced output tool becomes strict response_format json_schema and drops tools", async () => {
    const { provider, captured } = makeProvider([{ choices: [{ index: 0, delta: { content: '{"status":"passed","summary":"s"}' }, finish_reason: "stop" }] }, { choices: [], usage: USAGE as any }]);
    const outputTool: ToolSchema = {
      name: "StructuredOutput",
      description: "final",
      inputSchema: { type: "object", properties: { status: { type: "string" }, summary: { type: "string" } }, required: ["status"] },
    };
    const deltas = await collect(provider.stream([{ role: "user", content: "hi" }], [outputTool], { ...OPTS, toolChoice: { name: "StructuredOutput" } }));
    const body = captured[0].body;
    expect(body.tools).toBeUndefined();
    expect(body.response_format.type).toBe("json_schema");
    expect(body.response_format.json_schema.name).toBe("StructuredOutput");
    expect(body.response_format.json_schema.strict).toBe(true);
    expect(body.response_format.json_schema.schema.additionalProperties).toBe(false);
    expect(body.response_format.json_schema.schema.required).toEqual(["status", "summary"]);
    // The JSON object arrives as message content.
    expect(deltas).toContainEqual({ type: "text", text: '{"status":"passed","summary":"s"}' });
  });

  test("throws on a non-ok API response", async () => {
    const { provider } = makeProvider(undefined, { status: 429, body: "Rate limited" });
    await expect(collect(provider.stream([{ role: "user", content: "hi" }], [], OPTS))).rejects.toThrow(/429/);
  });

  test("supports() claims openai and gpt/o-series ids only", () => {
    const p = new OpenAIProvider();
    expect(p.supports("openai/gpt-4o")).toBe(true);
    expect(p.supports("gpt-5")).toBe(true);
    expect(p.supports("o3-mini")).toBe(true);
    expect(p.supports("anthropic/claude-opus-4-6")).toBe(false);
    expect(p.supports("claude-sonnet-4-6")).toBe(false);
  });
});
