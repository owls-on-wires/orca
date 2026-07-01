/**
 * Neutral, provider-agnostic type vocabulary for Layer A (model inference).
 *
 * These types are the lingua franca between Orca's agent loop (Layer B) and any
 * concrete provider adapter (Anthropic, OpenAI, …). Nothing here is tied to a
 * particular provider's wire format — each adapter translates to/from these.
 */

// ---------------------------------------------------------------------------
// Messages
// ---------------------------------------------------------------------------

export type Role = "user" | "assistant" | "tool";

export interface TextPart {
  type: "text";
  text: string;
}

export interface ToolCallPart {
  type: "tool_call";
  id: string;
  name: string;
  input: Record<string, unknown>;
}

export interface ToolResultPart {
  type: "tool_result";
  toolCallId: string;
  content: string;
  isError?: boolean;
}

export type ContentPart = TextPart | ToolCallPart | ToolResultPart;

/**
 * A single conversation message. `content` may be a plain string (shorthand for
 * a single text part) or an ordered list of parts. Tool results are carried on a
 * message with role `"tool"`; each adapter maps that to its own convention
 * (Anthropic tool_result blocks in a user turn, OpenAI role:"tool" messages, …).
 */
export interface ModelMessage {
  role: Role;
  content: string | ContentPart[];
}

// ---------------------------------------------------------------------------
// Tools
// ---------------------------------------------------------------------------

export interface ToolSchema {
  name: string;
  description: string;
  /** JSON Schema for the tool's input object. */
  inputSchema: Record<string, unknown>;
}

/** A fully-assembled tool call the model wants to make. */
export interface ToolCall {
  id: string;
  name: string;
  input: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Usage
// ---------------------------------------------------------------------------

/**
 * Raw token usage for one model turn. Cache fields are normalized: providers
 * that do not report a cache-creation split leave `cacheWriteTokens` at 0.
 */
export interface Usage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
}

export function emptyUsage(): Usage {
  return { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };
}

export function addUsage(a: Usage, b: Usage): Usage {
  return {
    inputTokens: a.inputTokens + b.inputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    cacheReadTokens: a.cacheReadTokens + b.cacheReadTokens,
    cacheWriteTokens: a.cacheWriteTokens + b.cacheWriteTokens,
  };
}

// ---------------------------------------------------------------------------
// Streamed deltas
// ---------------------------------------------------------------------------

export type FinishReason = "stop" | "tool_use" | "max_tokens" | "error";

/**
 * One event in a provider's stream for a *single* model turn. A provider hides
 * its own fragment-accumulation (Anthropic input_json_delta by content-block
 * index, OpenAI tool-arg fragments by tool index) and emits a `tool_call` only
 * once the call is fully assembled. Text arrives incrementally as `text`
 * deltas; the turn closes with exactly one `usage` and one `stop`.
 */
export type ModelDelta =
  | { type: "text"; text: string }
  | { type: "tool_call"; toolCall: ToolCall }
  | { type: "usage"; usage: Usage }
  | { type: "stop"; reason: FinishReason };
