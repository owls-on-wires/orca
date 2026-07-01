/**
 * Anthropic Messages API adapter (Layer A).
 *
 * Translates Orca's neutral message/tool vocabulary to the Anthropic wire
 * format, calls the Messages API, and yields neutral `ModelDelta`s. This P1
 * adapter uses a single non-SSE request per turn and emits the response as a
 * delta sequence; P2 replaces the transport with real SSE streaming behind the
 * same interface (fragment accumulation stays hidden inside this file).
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

interface WireResponse {
  content: WireBlock[];
  stop_reason: "end_turn" | "tool_use" | "max_tokens" | "stop_sequence" | null;
  usage: {
    input_tokens: number;
    output_tokens: number;
    cache_creation_input_tokens?: number;
    cache_read_input_tokens?: number;
  };
}

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

function normalizeUsage(u: WireResponse["usage"]): Usage {
  return {
    inputTokens: u.input_tokens ?? 0,
    outputTokens: u.output_tokens ?? 0,
    cacheReadTokens: u.cache_read_input_tokens ?? 0,
    cacheWriteTokens: u.cache_creation_input_tokens ?? 0,
  };
}

function normalizeStopReason(reason: WireResponse["stop_reason"]): FinishReason {
  switch (reason) {
    case "tool_use": return "tool_use";
    case "max_tokens": return "max_tokens";
    default: return "stop";
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
      },
      body: JSON.stringify(body),
      signal: opts.signal,
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`Anthropic API error ${response.status}: ${text}`);
    }

    const data = (await response.json()) as WireResponse;

    for (const block of data.content ?? []) {
      if (block.type === "text") {
        yield { type: "text", text: (block as WireTextBlock).text };
      } else if (block.type === "tool_use") {
        const tu = block as WireToolUseBlock;
        yield {
          type: "tool_call",
          toolCall: { id: tu.id, name: tu.name, input: (tu.input ?? {}) as Record<string, unknown> },
        };
      }
    }

    yield { type: "usage", usage: normalizeUsage(data.usage) };
    yield { type: "stop", reason: normalizeStopReason(data.stop_reason) };
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
