/**
 * Layer A — the `ModelProvider` interface.
 *
 * A provider adapter does exactly one thing: stream a single model turn given a
 * message history + tool schemas, and report raw token usage. It does NOT
 * execute tools, manage sessions, or run the agent loop — those are Layer B
 * (Orca-owned). Adapters are dispatched by model-id prefix via the registry.
 */

import type { ModelMessage, ToolSchema, ModelDelta } from "./types";

/**
 * What a model can do natively, so Layer B can adapt or degrade.
 */
export interface ModelCapabilities {
  /** Native structured output (forced output-tool / json_schema response). */
  structuredOutput: boolean;
  /** Can request multiple tool calls in one turn. */
  parallelToolCalls: boolean;
  /** Accepts image inputs. */
  vision: boolean;
  /** Prompt/context caching support. */
  promptCaching: boolean;
  /** Maximum context window in tokens. */
  maxContextTokens: number;
}

/**
 * Per-call options for a single streamed turn. `model` is the concrete
 * provider-native model id (already stripped of any `provider/` prefix).
 */
export interface StreamOptions {
  model: string;
  system?: string;
  maxTokens?: number;
  temperature?: number;
  /** Force a particular tool, force any tool, or let the model choose. */
  toolChoice?: "auto" | "any" | { name: string };
  signal?: AbortSignal;
  /** Provider API key; falls back to the adapter's own secret resolution. */
  apiKey?: string;
  /** Override the provider base URL (OpenAI-compatible providers, proxies). */
  apiUrl?: string;
}

export interface ModelProvider {
  /** Stable provider id, e.g. `"anthropic"`. */
  readonly id: string;

  /** Static capability flags for this provider's model family. */
  readonly capabilities: ModelCapabilities;

  /** Whether this provider serves the given (possibly prefixed) model id. */
  supports(modelId: string): boolean;

  /**
   * Stream one model turn. Yields incremental text, fully-assembled tool calls,
   * a final `usage`, and a closing `stop`. Throws on transport/API errors.
   */
  stream(
    messages: ModelMessage[],
    tools: ToolSchema[],
    opts: StreamOptions,
  ): AsyncIterable<ModelDelta>;
}
