/**
 * OpenAI (Chat Completions) adapter (Layer A) — streaming.
 *
 * The second real provider, added to force Orca's `ModelProvider` abstraction
 * honest: two genuine implementations behind one seam, not one dressed up. Also
 * absorbs every OpenAI-compatible provider (Groq, Together, DeepSeek, vLLM,
 * Ollama, OpenRouter, Gemini-compat) via an alternate `apiUrl`.
 *
 * The taxes this adapter pays where OpenAI diverges from the neutral vocabulary
 * (see [[spec-model-provider]] acceptance criterion 3):
 *
 *  - **Message-shape translation.** Neutral tool_call parts become an assistant
 *    message's `tool_calls[]`; neutral tool_result parts (carried on a `"tool"`
 *    role) become separate `role:"tool"` messages keyed by `tool_call_id`.
 *  - **Tool-arg fragment accumulation by tool index.** Streamed function-call
 *    arguments arrive as `choices[].delta.tool_calls[]` fragments; the name/id
 *    appear only on the first fragment for a given `index`. We accumulate per
 *    index and parse the assembled JSON exactly once, at stream end.
 *  - **Strict structured output via `response_format: json_schema`.** When the
 *    loop forces the single output tool (`toolChoice:{name}`), we translate that
 *    into a strict `response_format` derived from the tool's schema and send no
 *    tools — the model returns the object as message content, which Layer B
 *    captures. Real (non-forced) turns use normal function calling.
 *  - **`stream_options:{include_usage:true}`** so a final usage chunk is emitted.
 *  - **Usage asymmetry.** OpenAI has no cache-creation split, so `cacheWrite`
 *    is always 0; cached prompt tokens are pulled out of `prompt_tokens` into
 *    `cacheRead` for lossless cost accounting.
 *
 * `decodeOpenAIStream` and `parseOpenAISSE` are pure and exported so the wire
 * path is unit-tested with canned chunks — no network, no API key.
 */

import { getSecret } from "../harness/secrets";
import type { ModelProvider, ModelCapabilities, StreamOptions } from "./provider";
import type {
  ModelMessage,
  ToolSchema,
  ModelDelta,
  FinishReason,
  Usage,
} from "./types";
import { emptyUsage } from "./types";

const DEFAULT_API_URL = "https://api.openai.com/v1";
const DEFAULT_MAX_TOKENS = 8192;

// ---------------------------------------------------------------------------
// OpenAI wire types (only the fields we touch)
// ---------------------------------------------------------------------------

interface WireToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

interface WireAssistantMessage {
  role: "assistant";
  content: string | null;
  tool_calls?: WireToolCall[];
}
interface WireUserMessage { role: "user"; content: string }
interface WireSystemMessage { role: "system"; content: string }
interface WireToolMessage { role: "tool"; tool_call_id: string; content: string }
type WireMessage = WireAssistantMessage | WireUserMessage | WireSystemMessage | WireToolMessage;

interface WireUsage {
  prompt_tokens?: number;
  completion_tokens?: number;
  prompt_tokens_details?: { cached_tokens?: number };
}

// ---------------------------------------------------------------------------
// Streaming chunk shape (only the fields we consume)
// ---------------------------------------------------------------------------

export interface OpenAIStreamChunk {
  choices?: Array<{
    index?: number;
    delta?: {
      role?: string;
      content?: string | null;
      tool_calls?: Array<{
        index?: number;
        id?: string;
        type?: string;
        function?: { name?: string; arguments?: string };
      }>;
    };
    finish_reason?: string | null;
  }>;
  usage?: WireUsage | null;
}

// ---------------------------------------------------------------------------
// Neutral -> OpenAI translation
// ---------------------------------------------------------------------------

function toWireMessages(system: string | undefined, messages: ModelMessage[]): WireMessage[] {
  const out: WireMessage[] = [];
  if (system) out.push({ role: "system", content: system });

  for (const msg of messages) {
    if (typeof msg.content === "string") {
      if (msg.role === "assistant") out.push({ role: "assistant", content: msg.content });
      else out.push({ role: "user", content: msg.content });
      continue;
    }

    if (msg.role === "assistant") {
      let text = "";
      const toolCalls: WireToolCall[] = [];
      for (const part of msg.content) {
        if (part.type === "text") text += part.text;
        else if (part.type === "tool_call") {
          toolCalls.push({
            id: part.id,
            type: "function",
            function: { name: part.name, arguments: JSON.stringify(part.input ?? {}) },
          });
        }
      }
      const m: WireAssistantMessage = { role: "assistant", content: text.length ? text : null };
      if (toolCalls.length) m.tool_calls = toolCalls;
      out.push(m);
      continue;
    }

    // user or tool role: text parts -> a user message; tool_result parts ->
    // separate role:"tool" messages keyed by tool_call_id (OpenAI's convention).
    let text = "";
    const toolMsgs: WireToolMessage[] = [];
    for (const part of msg.content) {
      if (part.type === "text") text += part.text;
      else if (part.type === "tool_result") {
        toolMsgs.push({ role: "tool", tool_call_id: part.toolCallId, content: part.content });
      }
    }
    if (text.length) out.push({ role: "user", content: text });
    out.push(...toolMsgs);
  }

  return out;
}

function toWireTools(tools: ToolSchema[]): Array<Record<string, unknown>> {
  return tools.map((t) => ({
    type: "function",
    function: {
      name: t.name,
      description: t.description,
      parameters: t.inputSchema,
    },
  }));
}

/**
 * Coerce a JSON Schema into an OpenAI strict-mode-compatible one: every object
 * must set `additionalProperties:false` and list all of its properties in
 * `required`. Applied recursively to nested objects and array items. Non-object
 * nodes pass through unchanged.
 */
export function toStrictJsonSchema(schema: unknown): Record<string, unknown> {
  const node = schema as Record<string, unknown>;
  if (!node || typeof node !== "object") return { type: "object", properties: {}, required: [], additionalProperties: false };

  if (node.type === "object" || node.properties) {
    const props = (node.properties as Record<string, unknown>) ?? {};
    const strictProps: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(props)) {
      strictProps[key] = toStrictJsonSchema(value);
    }
    return {
      ...node,
      type: "object",
      properties: strictProps,
      required: Object.keys(strictProps),
      additionalProperties: false,
    };
  }

  if (node.type === "array" && node.items) {
    return { ...node, items: toStrictJsonSchema(node.items) };
  }

  return node;
}

function normalizeFinishReason(reason: string | null | undefined): FinishReason {
  switch (reason) {
    case "tool_calls":
    case "function_call":
      return "tool_use";
    case "length":
      return "max_tokens";
    default:
      return "stop";
  }
}

function toNeutralUsage(u: WireUsage | null | undefined): Usage {
  if (!u) return emptyUsage();
  const cached = u.prompt_tokens_details?.cached_tokens ?? 0;
  const prompt = u.prompt_tokens ?? 0;
  return {
    // OpenAI's prompt_tokens INCLUDES cached tokens; split them out so cache
    // reads are priced separately and cost is lossless.
    inputTokens: Math.max(0, prompt - cached),
    outputTokens: u.completion_tokens ?? 0,
    cacheReadTokens: cached,
    cacheWriteTokens: 0,
  };
}

// ---------------------------------------------------------------------------
// SSE framing — turn a byte stream into parsed OpenAI chunks
// ---------------------------------------------------------------------------

/**
 * Parse an OpenAI SSE byte stream into `OpenAIStreamChunk`s. Records are
 * separated by a blank line; each `data:` payload is a JSON chunk, except the
 * terminal `data: [DONE]` sentinel which is ignored. Tolerant of chunk
 * boundaries splitting a record mid-way.
 */
export async function* parseOpenAISSE(
  body: ReadableStream<Uint8Array>,
): AsyncIterable<OpenAIStreamChunk> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      let idx: number;
      while ((idx = recordBoundary(buffer)) !== -1) {
        const width = buffer.startsWith("\r\n\r\n", idx) ? 4 : 2;
        const record = buffer.slice(0, idx);
        buffer = buffer.slice(idx + width);
        const chunk = parseRecord(record);
        if (chunk) yield chunk;
      }
    }
    const tail = parseRecord(buffer);
    if (tail) yield tail;
  } finally {
    reader.releaseLock();
  }
}

function recordBoundary(buf: string): number {
  const a = buf.indexOf("\n\n");
  const b = buf.indexOf("\r\n\r\n");
  if (a === -1) return b;
  if (b === -1) return a;
  return Math.min(a, b);
}

function parseRecord(record: string): OpenAIStreamChunk | null {
  const dataParts: string[] = [];
  for (const rawLine of record.split("\n")) {
    const line = rawLine.replace(/\r$/, "");
    if (line.startsWith("data:")) dataParts.push(line.slice(5).trimStart());
  }
  if (dataParts.length === 0) return null;
  const payload = dataParts.join("\n");
  if (!payload || payload === "[DONE]") return null;
  try {
    return JSON.parse(payload) as OpenAIStreamChunk;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Stream decoder — the state machine (pure, unit-testable)
// ---------------------------------------------------------------------------

interface ToolAcc {
  id: string;
  name: string;
  args: string;
}

/**
 * Reduce a sequence of OpenAI stream chunks into neutral `ModelDelta`s.
 *
 * Function-call arguments arrive as fragments across chunks; each fragment
 * carries only a tool `index` (the id/name appear once, on the first fragment).
 * We accumulate per index and parse the assembled JSON exactly once, after the
 * stream ends. Text arrives as `content` deltas. Usage comes from the terminal
 * usage chunk (requires `stream_options:{include_usage:true}`).
 */
export async function* decodeOpenAIStream(
  chunks: AsyncIterable<OpenAIStreamChunk> | Iterable<OpenAIStreamChunk>,
): AsyncIterable<ModelDelta> {
  const tools = new Map<number, ToolAcc>();
  let usage: Usage = emptyUsage();
  let stop: FinishReason = "stop";

  for await (const chunk of asAsync(chunks)) {
    for (const choice of chunk.choices ?? []) {
      const delta = choice.delta;
      if (delta?.content) yield { type: "text", text: delta.content };

      for (const tc of delta?.tool_calls ?? []) {
        const index = tc.index ?? 0;
        let acc = tools.get(index);
        if (!acc) {
          acc = { id: "", name: "", args: "" };
          tools.set(index, acc);
        }
        if (tc.id) acc.id = tc.id;
        if (tc.function?.name) acc.name = tc.function.name;
        if (tc.function?.arguments) acc.args += tc.function.arguments;
      }

      if (choice.finish_reason) stop = normalizeFinishReason(choice.finish_reason);
    }

    if (chunk.usage) usage = toNeutralUsage(chunk.usage);
  }

  // Emit fully-assembled tool calls in tool-index order.
  for (const index of [...tools.keys()].sort((a, b) => a - b)) {
    const acc = tools.get(index)!;
    let input: Record<string, unknown> = {};
    const raw = acc.args.trim();
    if (raw) {
      try {
        const parsed = JSON.parse(raw);
        if (parsed && typeof parsed === "object") input = parsed as Record<string, unknown>;
      } catch {
        // Leave input as {} rather than corrupting the call with partial JSON.
      }
    }
    yield { type: "tool_call", toolCall: { id: acc.id || `call_${index}`, name: acc.name, input } };
  }

  yield { type: "usage", usage };
  yield { type: "stop", reason: stop };
}

async function* asAsync<T>(src: AsyncIterable<T> | Iterable<T>): AsyncIterable<T> {
  if (Symbol.asyncIterator in (src as any)) {
    for await (const v of src as AsyncIterable<T>) yield v;
  } else {
    for (const v of src as Iterable<T>) yield v;
  }
}

// ---------------------------------------------------------------------------
// Provider
// ---------------------------------------------------------------------------

export interface OpenAIProviderOptions {
  /** Injectable fetch for tests; when unset, `globalThis.fetch` is read at call time. */
  fetchImpl?: typeof fetch;
}

export class OpenAIProvider implements ModelProvider {
  readonly id = "openai";

  readonly capabilities: ModelCapabilities = {
    structuredOutput: true,
    parallelToolCalls: true,
    vision: true,
    promptCaching: true,
    maxContextTokens: 128_000,
  };

  private readonly fetchImpl?: typeof fetch;

  constructor(opts: OpenAIProviderOptions = {}) {
    this.fetchImpl = opts.fetchImpl;
  }

  supports(modelId: string): boolean {
    const id = modelId.toLowerCase();
    return id.startsWith("openai/") || /^(gpt|o1|o3|o4|chatgpt)/.test(id);
  }

  async *stream(
    messages: ModelMessage[],
    tools: ToolSchema[],
    opts: StreamOptions,
  ): AsyncIterable<ModelDelta> {
    const apiKey = opts.apiKey ?? getSecret("OPENAI_API_KEY");
    if (!apiKey) {
      throw new Error(
        "OPENAI_API_KEY not set. Add it to packages/server/secrets.json or set the environment variable.",
      );
    }
    const apiUrl = opts.apiUrl ?? DEFAULT_API_URL;

    const body: Record<string, unknown> = {
      model: opts.model,
      max_completion_tokens: opts.maxTokens ?? DEFAULT_MAX_TOKENS,
      messages: toWireMessages(opts.system, messages),
      stream: true,
      stream_options: { include_usage: true },
    };
    if (opts.temperature !== undefined) body.temperature = opts.temperature;

    // Structured-output finalization: a forced single-tool choice becomes a
    // strict `response_format` derived from that tool's schema. The model then
    // returns the object as message content (Layer B's fallback captures it).
    const forced = typeof opts.toolChoice === "object" ? opts.toolChoice : undefined;
    const forcedTool = forced ? tools.find((t) => t.name === forced.name) : undefined;

    if (forcedTool) {
      body.response_format = {
        type: "json_schema",
        json_schema: {
          name: forcedTool.name,
          strict: true,
          schema: toStrictJsonSchema(forcedTool.inputSchema),
        },
      };
      // No tools on a structured-output turn.
    } else {
      const wireTools = toWireTools(tools);
      if (wireTools.length > 0) {
        body.tools = wireTools;
        if (forced) {
          // Forcing a tool that isn't in the list — fall back to tool_choice.
          body.tool_choice = { type: "function", function: { name: forced.name } };
        } else {
          body.tool_choice = opts.toolChoice === "any" ? "required" : "auto";
        }
      }
    }

    const fetchFn = this.fetchImpl ?? globalThis.fetch;
    const response = await fetchFn(`${apiUrl}/chat/completions`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${apiKey}`,
        "content-type": "application/json",
        accept: "text/event-stream",
      },
      body: JSON.stringify(body),
      signal: opts.signal,
    });

    if (!response.ok) {
      const text = await response.text().catch(() => "");
      throw new Error(`OpenAI API error ${response.status}: ${text}`);
    }
    if (!response.body) {
      throw new Error("OpenAI API returned no response body for a streaming request.");
    }

    yield* decodeOpenAIStream(parseOpenAISSE(response.body));
  }
}
