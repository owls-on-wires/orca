/**
 * Shared types for the custom agent harness.
 */

// ---------------------------------------------------------------------------
// Tool system
// ---------------------------------------------------------------------------

export interface ToolDefinition {
  name: string;
  description: string;
  input_schema: object;
  cache_control?: { type: "ephemeral" };
}

export interface ToolResult {
  output: string;
  isError?: boolean;
}

export type ToolExecutor = (
  input: Record<string, unknown>,
  context: ToolContext,
) => Promise<ToolResult>;

export interface ToolContext {
  cwd: string;
  env?: Record<string, string>;
  abortSignal?: AbortSignal;
}

// ---------------------------------------------------------------------------
// API types (Anthropic Messages API)
// ---------------------------------------------------------------------------

export interface ApiMessage {
  role: "user" | "assistant";
  content: ApiContentBlock[] | string;
}

export type ApiContentBlock =
  | ApiTextBlock
  | ApiThinkingBlock
  | ApiToolUseBlock
  | ApiToolResultBlock;

export interface ApiTextBlock {
  type: "text";
  text: string;
}

export interface ApiThinkingBlock {
  type: "thinking";
  thinking: string;
}

export interface ApiToolUseBlock {
  type: "tool_use";
  id: string;
  name: string;
  input: Record<string, unknown>;
}

export interface ApiToolResultBlock {
  type: "tool_result";
  tool_use_id: string;
  content: string;
  is_error?: boolean;
}

export interface ApiSystemBlock {
  type: "text";
  text: string;
  cache_control?: { type: "ephemeral" };
}

export interface ApiRequest {
  model: string;
  max_tokens: number;
  system?: string | ApiSystemBlock[];
  messages: ApiMessage[];
  tools?: ToolDefinition[];
  tool_choice?: { type: "auto" | "any" | "tool"; name?: string };
}

export interface ApiResponse {
  id: string;
  type: "message";
  role: "assistant";
  content: ApiContentBlock[];
  model: string;
  stop_reason: "end_turn" | "tool_use" | "max_tokens" | "stop_sequence";
  usage: {
    input_tokens: number;
    output_tokens: number;
    cache_creation_input_tokens?: number;
    cache_read_input_tokens?: number;
  };
}

// ---------------------------------------------------------------------------
// Harness result (matches InvokeResult shape)
// ---------------------------------------------------------------------------

export interface HarnessResult {
  output: Record<string, unknown> | null;
  costUsd: number;
  numTurns: number;
  durationMs: number;
  isError: boolean;
}

export interface HarnessOptions {
  prompt: string;
  systemPrompt?: string;
  model?: string;
  maxTurns?: number;
  maxTokens?: number;
  outputSchema?: object;
  cwd: string;
  env?: Record<string, string>;
  apiKey?: string;
  apiUrl?: string;
  logPath?: string;
  label?: string;
  abortController?: AbortController;
  onToolUse?: (toolName: string, toolInput: Record<string, unknown>) => void;
  mcpServers?: Array<{ command: string; args?: string[]; env?: Record<string, string>; cwd?: string; prefix?: string }>;
}

// ---------------------------------------------------------------------------
// Cost calculation
// ---------------------------------------------------------------------------

// Pricing per million tokens (as of 2026)
export const MODEL_PRICING: Record<string, { input: number; output: number }> = {
  "claude-sonnet-4-20250514": { input: 3.0, output: 15.0 },
  "claude-sonnet-4-6": { input: 3.0, output: 15.0 },
  "claude-opus-4-20250514": { input: 15.0, output: 75.0 },
  "claude-opus-4-6": { input: 15.0, output: 75.0 },
  "claude-haiku-4-5-20251001": { input: 0.80, output: 4.0 },
};

export function estimateCost(
  model: string,
  inputTokens: number,
  outputTokens: number,
  cacheReadTokens: number = 0,
): number {
  // Find pricing — try exact match, then prefix match
  let pricing = MODEL_PRICING[model];
  if (!pricing) {
    if (model.includes("opus")) pricing = MODEL_PRICING["claude-opus-4-20250514"];
    else if (model.includes("haiku")) pricing = MODEL_PRICING["claude-haiku-4-20250414"];
    else pricing = MODEL_PRICING["claude-sonnet-4-20250514"]; // default to sonnet
  }

  const inputCost = (inputTokens * pricing.input) / 1_000_000;
  const outputCost = (outputTokens * pricing.output) / 1_000_000;
  // Cache reads are 10% of input price
  const cacheCost = (cacheReadTokens * pricing.input * 0.1) / 1_000_000;

  return inputCost + outputCost + cacheCost;
}
