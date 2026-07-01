/**
 * Agent invocation seam.
 *
 * This is the stable, provider-neutral boundary the rest of Orca calls through
 * (`InvokeOptions` in, `AsyncGenerator<InvokeEvent>` out, `InvokeResult` at the
 * end). Its guts are Orca's own Layer-B agent loop (`engine/agent-loop.ts`)
 * driving a `ModelProvider` resolved from the registry — no `claude` binary, no
 * Claude Code SDK. Model-agnostic by construction: the model id selects the
 * provider (Anthropic, OpenAI, …).
 */

import { getSystemPrompt } from "../config/prompts";
import type { ScopeConfig, Toolset } from "../config/schema";
import { agentLoop, type AgentEvent, type AgentLoopOptions } from "./agent-loop";

// ---------------------------------------------------------------------------
// Types (stable public surface)
// ---------------------------------------------------------------------------

export interface InvokeOptions {
  prompt: string;
  projectDir: string;
  model?: string;
  toolset?: Toolset;
  maxTurns?: number;
  sessionId?: string;
  outputSchema?: object;
  scope?: ScopeConfig;
  systemPrompt?: string;
  timeout?: number;
  label?: string;
  logPath?: string;
  abortController?: AbortController;
  env?: Record<string, string | undefined>;
}

export interface InvokeResult {
  output: Record<string, unknown> | null;
  costUsd: number;
  sessionId: string | null;
  numTurns: number;
  durationMs: number;
  isError: boolean;
}

export interface InvokeEvent {
  type: "text" | "tool_use" | "result";
  text?: string;
  toolName?: string;
  toolInput?: Record<string, unknown>;
  result?: InvokeResult;
}

// ---------------------------------------------------------------------------
// Option translation
// ---------------------------------------------------------------------------

function toLoopOptions(options: InvokeOptions): AgentLoopOptions {
  // Orca's base system prompt is prepended; the loop layers on scope + the
  // working-directory contract itself.
  const systemPrompt = [getSystemPrompt(), options.systemPrompt]
    .filter((s): s is string => !!s)
    .join("\n\n");

  // Drop undefined values from env (the loop wants Record<string,string>).
  let env: Record<string, string> | undefined;
  if (options.env) {
    env = {};
    for (const [k, v] of Object.entries(options.env)) if (v !== undefined) env[k] = v;
  }

  return {
    prompt: options.prompt,
    systemPrompt: systemPrompt || undefined,
    model: options.model,
    maxTurns: options.maxTurns,
    outputSchema: options.outputSchema,
    toolset: options.toolset,
    cwd: options.projectDir,
    env,
    logPath: options.logPath,
    label: options.label,
    abortController: options.abortController,
    scope: options.scope,
    sessionId: options.sessionId,
  };
}

// ---------------------------------------------------------------------------
// Invoke
// ---------------------------------------------------------------------------

export async function* invoke(options: InvokeOptions): AsyncGenerator<InvokeEvent> {
  for await (const event of agentLoop(toLoopOptions(options))) {
    yield toInvokeEvent(event);
  }
}

function toInvokeEvent(event: AgentEvent): InvokeEvent {
  if (event.type === "result") {
    return { type: "result", result: event.result };
  }
  if (event.type === "tool_use") {
    return { type: "tool_use", toolName: event.toolName, toolInput: event.toolInput };
  }
  return { type: "text", text: event.text };
}

// ---------------------------------------------------------------------------
// Simple invoke (consumes the stream, returns the final result)
// ---------------------------------------------------------------------------

export async function invokeSimple(
  options: InvokeOptions,
  onToolUse?: (toolName: string, toolInput: Record<string, unknown>) => void,
): Promise<InvokeResult> {
  let result: InvokeResult | null = null;
  for await (const event of invoke(options)) {
    if (event.type === "tool_use" && onToolUse && event.toolName) {
      onToolUse(event.toolName, event.toolInput ?? {});
    }
    if (event.type === "result" && event.result) {
      result = event.result;
    }
  }
  return result ?? {
    output: null,
    costUsd: 0,
    sessionId: null,
    numTurns: 0,
    durationMs: 0,
    isError: true,
  };
}
