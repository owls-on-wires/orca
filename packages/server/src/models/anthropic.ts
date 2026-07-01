/**
 * Anthropic Messages API adapter (Layer A) — streaming.
 *
 * Translates Orca's neutral message/tool vocabulary to the Anthropic wire
 * format, calls the Messages API with `stream: true`, and yields neutral
 * `ModelDelta`s as the SSE stream arrives.
 *
 * The classic bug source — streamed tool-argument accumulation — is handled by
 * `decodeAnthropicStream`: `input_json_delta` fragments are buffered per
 * content-block index and parsed exactly once, at `content_block_stop`. That
 * decoder is a pure state machine over parsed SSE events, exported so it can be
 * unit-tested with canned chunks (no network, no API key).
 */

import { getSecret } from "../harness/secrets";
import type { ModelProvider, ModelCapabilities, StreamOptions } from "./provider";
import type {
  ModelMessage,
  ToolSchema,
  ModelDelta,
  ContentPart,
  FinishReason,
  Usage,
} from "./types";
import { emptyUsage } from "./types";

const DEFAULT_API_URL = "https://api.anthropic.com";
const ANTHROPIC_VERSION = "2023-06-01";
const DEFAULT_MAX_TOKENS = 8192;

// ---------------------------------------------------------------------------
// Anthropic wire types (only the fields we touch)
// ---------------------------------------------------------------------------

interface WireTextBlock { type: "text"; text: string }
interface WireToolUseBlock { type: "tool_use"; id: string; name: string; input: Record<string, unknown> }
interface WireToolResultBlock {
  type: "tool_result";
  tool_use_id: string;
  content: string;
  is_error?: boolean;
}
type WireBlock = WireTextBlock | WireToolUseBlock | WireToolResultBlock | { type: string; [k: string]: unknown };

interface WireMessage { role: "user" | "assistant"; content: string | WireBlock[] }

interface WireUsage {
  input_tokens?: number;
  output_tokens?: number;
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
}

// ---------------------------------------------------------------------------
// Streaming SSE event shapes (only the fields we consume)
// ---------------------------------------------------------------------------

export type AnthropicStreamEvent =
  | { type: "message_start"; message: { usage?: WireUsage } }
  | { type: "content_block_start"; index: number; content_block: { type: string; id?: string; name?: string } }
  | {
      type: "content_block_delta";
      index: number;
      delta:
        | { type: "text_delta"; text: string }
        | { type: "input_json_delta"; partial_json: string }
        | { type: string; [k: string]: unknown };
    }
  | { type: "content_block_stop"; index: number }
  | { type: "message_delta"; delta?: { stop_reason?: string | null }; usage?: WireUsage }
  | { type: "message_stop" }
  | { type: "ping" }
  | { type: "error"; error?: { type?: string; message?: string } }
  | { type: string; [k: string]: unknown };

// ---------------------------------------------------------------------------
// Neutral -> Anthropic translation
// ---------------------------------------------------------------------------

function toWireMessages(messages: ModelMessage[]): WireMessage[] {
  const out: WireMessage[] = [];
  for (const msg of messages) {
    if (typeof msg.content === "string") {
      // A "tool" role should never carry a bare string, so map user/assistant.
      out.push({ role: msg.role === "assistant" ? "assistant" : "user", content: msg.content });
      continue;
    }

    if (msg.role === "assistant") {
      const blocks: WireBlock[] = [];
      for (const part of msg.content) {
        if (part.type === "text") blocks.push({ type: "text", text: part.text });
        else if (part.type === "tool_call") {
          blocks.push({ type: "tool_use", id: part.id, name: part.name, input: part.input });
        }
      }
      out.push({ role: "assistant", content: blocks });
      continue;
    }

    // user or tool role -> a user turn. tool_result parts become tool_result
    // blocks; text parts become text blocks.
    const blocks: WireBlock[] = [];
    for (const part of msg.content) {
      if (part.type === "text") blocks.push({ type: "text", text: part.text });
      else if (part.type === "tool_result") {
        blocks.push({
          type: "tool_result",
          tool_use_id: part.toolCallId,
          content: part.content,
          ...(part.isError ? { is_error: true } : {}),
        });
      }
    }
    out.push({ role: "user", content: blocks });
  }
  return out;
}

function toWireTools(tools: ToolSchema[]): Array<Record<string, unknown>> {
  return tools.map((t) => ({
    name: t.name,
    description: t.description,
    input_schema: t.inputSchema,
  }));
}

function toWireToolChoice(
  choice: StreamOptions["toolChoice"],
): Record<string, unknown> | undefined {
  if (!choice) return undefined;
  if (choice === "auto") return { type: "auto" };
  if (choice === "any") return { type: "any" };
  return { type: "tool", name: choice.name };
}

function normalizeStopReason(reason: string | null | undefined): FinishReason {
  switch (reason) {
    case "tool_use": return "tool_use";
    case "max_tokens": return "max_tokens";
    default: return "stop";
  }
}

// ---------------------------------------------------------------------------
// SSE framing — turn a byte stream into parsed Anthropic stream events
// ---------------------------------------------------------------------------

/**
 * Parse an SSE byte stream into `AnthropicStreamEvent`s. Events are separated
 * by a blank line; we only care about `data:` payloads (each a JSON object with
 * a `type`). The `event:` line is redundant with the payload's `type`.
 */
export async function* parseSSEStream(
  body: ReadableStream<Uint8Array>,
): AsyncIterable<AnthropicStreamEvent> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      let sep: number;
      // SSE records are separated by a blank line (\n\n). Handle \r\n too.
      while ((sep = firstRecordBoundary(buffer)) !== -1) {
        const { end, next } = boundaryAt(buffer, sep);
        const record = buffer.slice(0, end);
        buffer = buffer.slice(next);
        const ev = parseSSERecord(record);
        if (ev) yield ev;
      }
    }
    // Flush any trailing record without a terminating blank line.
    const tail = parseSSERecord(buffer);
    if (tail) yield tail;
  } finally {
    reader.releaseLock();
  }
}

function firstRecordBoundary(buf: string): number {
  const a = buf.indexOf("\n\n");
  const b = buf.indexOf("\r\n\r\n");
  if (a === -1) return b;
  if (b === -1) return a;
  return Math.min(a, b);
}

function boundaryAt(buf: string, idx: number): { end: number; next: number } {
  // idx points at the first char of the boundary; distinguish \n\n vs \r\n\r\n.
  if (buf.startsWith("\r\n\r\n", idx)) return { end: idx, next: idx + 4 };
  return { end: idx, next: idx + 2 };
}

function parseSSERecord(record: string): AnthropicStreamEvent | null {
  const dataParts: string[] = [];
  for (const rawLine of record.split("\n")) {
    const line = rawLine.replace(/\r$/, "");
    if (line.startsWith("data:")) dataParts.push(line.slice(5).trimStart());
  }
  if (dataParts.length === 0) return null;
  const payload = dataParts.join("\n");
  if (!payload || payload === "[DONE]") return null;
  try {
    return JSON.parse(payload) as AnthropicStreamEvent;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Stream decoder — the state machine (pure, unit-testable)
// ---------------------------------------------------------------------------

interface BlockState {
  kind: "text" | "tool_use" | "other";
  id?: string;
  name?: string;
  jsonBuf: string;
}

/**
 * Reduce a sequence of Anthropic stream events into neutral `ModelDelta`s.
 *
 * Tool arguments arrive as `input_json_delta` fragments; we accumulate them per
 * content-block index and parse the assembled JSON exactly once, at
 * `content_block_stop`. Text arrives as `text_delta`. Usage is assembled from
 * `message_start` (input + cache split) and `message_delta` (final output).
 */
export async function* decodeAnthropicStream(
  events: AsyncIterable<AnthropicStreamEvent> | Iterable<AnthropicStreamEvent>,
): AsyncIterable<ModelDelta> {
  const blocks = new Map<number, BlockState>();
  const usage: Usage = emptyUsage();
  let stop: FinishReason = "stop";

  for await (const ev of asAsync(events)) {
    switch (ev.type) {
      case "message_start": {
        const u = (ev as any).message?.usage as WireUsage | undefined;
        if (u) {
          usage.inputTokens = u.input_tokens ?? 0;
          usage.outputTokens = u.output_tokens ?? 0;
          usage.cacheReadTokens = u.cache_read_input_tokens ?? 0;
          usage.cacheWriteTokens = u.cache_creation_input_tokens ?? 0;
        }
        break;
      }
      case "content_block_start": {
        const e = ev as Extract<AnthropicStreamEvent, { type: "content_block_start" }>;
        const cb = e.content_block;
        if (cb?.type === "tool_use") {
          blocks.set(e.index, { kind: "tool_use", id: cb.id, name: cb.name, jsonBuf: "" });
        } else if (cb?.type === "text") {
          blocks.set(e.index, { kind: "text", jsonBuf: "" });
        } else {
          blocks.set(e.index, { kind: "other", jsonBuf: "" });
        }
        break;
      }
      case "content_block_delta": {
        const e = ev as Extract<AnthropicStreamEvent, { type: "content_block_delta" }>;
        const d = e.delta as any;
        if (d?.type === "text_delta") {
          if (d.text) yield { type: "text", text: d.text };
        } else if (d?.type === "input_json_delta") {
          const b = blocks.get(e.index);
          if (b) b.jsonBuf += d.partial_json ?? "";
        }
        break;
      }
      case "content_block_stop": {
        const e = ev as Extract<AnthropicStreamEvent, { type: "content_block_stop" }>;
        const b = blocks.get(e.index);
        if (b && b.kind === "tool_use") {
          let input: Record<string, unknown> = {};
          const raw = b.jsonBuf.trim();
          if (raw) {
            try {
              const parsed = JSON.parse(raw);
              if (parsed && typeof parsed === "object") input = parsed as Record<string, unknown>;
            } catch {
              // Leave input as {} on malformed JSON rather than corrupting the call.
            }
          }
          yield { type: "tool_call", toolCall: { id: b.id ?? "", name: b.name ?? "", input } };
        }
        break;
      }
      case "message_delta": {
        const e = ev as Extract<AnthropicStreamEvent, { type: "message_delta" }>;
        if (e.usage?.output_tokens != null) usage.outputTokens = e.usage.output_tokens;
        if (e.usage?.input_tokens != null) usage.inputTokens = e.usage.input_tokens;
        if (e.delta?.stop_reason) stop = normalizeStopReason(e.delta.stop_reason);
        break;
      }
      case "error": {
        const e = ev as Extract<AnthropicStreamEvent, { type: "error" }>;
        throw new Error(`Anthropic stream error: ${e.error?.message ?? JSON.stringify(e.error ?? {})}`);
      }
      default:
        break;
    }
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

export interface AnthropicProviderOptions {
  /** Injectable fetch for tests; when unset, `globalThis.fetch` is read at call time. */
  fetchImpl?: typeof fetch;
}

export class AnthropicProvider implements ModelProvider {
  readonly id = "anthropic";

  readonly capabilities: ModelCapabilities = {
    structuredOutput: true,
    parallelToolCalls: true,
    vision: true,
    promptCaching: true,
    maxContextTokens: 200_000,
  };

  private readonly fetchImpl?: typeof fetch;

  constructor(opts: AnthropicProviderOptions = {}) {
    this.fetchImpl = opts.fetchImpl;
  }

  supports(modelId: string): boolean {
    const id = modelId.toLowerCase();
    return id.startsWith("anthropic/") || id.startsWith("claude");
  }

  async *stream(
    messages: ModelMessage[],
    tools: ToolSchema[],
    opts: StreamOptions,
  ): AsyncIterable<ModelDelta> {
    const apiKey = opts.apiKey ?? getSecret("ANTHROPIC_API_KEY");
    if (!apiKey) {
      throw new Error(
        "ANTHROPIC_API_KEY not set. Add it to packages/server/secrets.json or set the environment variable.",
      );
    }
    const apiUrl = opts.apiUrl ?? DEFAULT_API_URL;

    // Cache the system prompt and the tool prefix — the largest stable inputs.
    const system = opts.system
      ? [{ type: "text", text: opts.system, cache_control: { type: "ephemeral" } }]
      : undefined;

    const wireTools = toWireTools(tools);
    if (wireTools.length > 0) {
      wireTools[wireTools.length - 1] = {
        ...wireTools[wireTools.length - 1],
        cache_control: { type: "ephemeral" },
      };
    }

    const body: Record<string, unknown> = {
      model: opts.model,
      max_tokens: opts.maxTokens ?? DEFAULT_MAX_TOKENS,
      messages: toWireMessages(messages),
      stream: true,
    };
    if (system) body.system = system;
    if (wireTools.length > 0) body.tools = wireTools;
    if (opts.temperature !== undefined) body.temperature = opts.temperature;
    const toolChoice = toWireToolChoice(opts.toolChoice);
    if (toolChoice) body.tool_choice = toolChoice;

    const fetchFn = this.fetchImpl ?? globalThis.fetch;
    const response = await fetchFn(`${apiUrl}/v1/messages`, {
      method: "POST",
      headers: {
        "x-api-key": apiKey,
        "anthropic-version": ANTHROPIC_VERSION,
        "content-type": "application/json",
        "accept": "text/event-stream",
      },
      body: JSON.stringify(body),
      signal: opts.signal,
    });

    if (!response.ok) {
      const text = await response.text().catch(() => "");
      throw new Error(`Anthropic API error ${response.status}: ${text}`);
    }

    if (!response.body) {
      throw new Error("Anthropic API returned no response body for a streaming request.");
    }

    yield* decodeAnthropicStream(parseSSEStream(response.body));
  }
}

// ---------------------------------------------------------------------------
// Content-part helpers shared with Layer B
// ---------------------------------------------------------------------------

/** Build the assistant message's neutral content from a reduced turn. */
export function assistantContent(text: string, toolCalls: ContentPart[]): ContentPart[] {
  const parts: ContentPart[] = [];
  if (text) parts.push({ type: "text", text });
  parts.push(...toolCalls);
  return parts;
}
