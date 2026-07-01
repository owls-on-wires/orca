/**
 * Orca-owned agent loop (Layer B).
 *
 * The turn loop: call `provider.stream()` → if the model requested tools,
 * execute them against Orca's own tool registry → append results → repeat until
 * the model produces a final answer or `maxTurns` is hit. This is the loop the
 * Claude Code SDK used to own; Orca now owns it, model-agnostically.
 *
 * Responsibilities:
 *  - Built-in tool registry keyed by `TOOLSETS` (reuses `harness/tools.ts`).
 *  - Scope enforcement via `checkToolUse` as an internal gate.
 *  - `maxTurns` cap.
 *  - Structured-output finalization with explicit "final answer" turn logic —
 *    you cannot force a synthetic output tool while real tools are still in
 *    play, so when the model stops calling real tools the loop drives one forced
 *    output-tool turn to get validated structured output.
 *  - `InvokeEvent`-shaped emissions tagged with the source action id.
 *  - Durable sessions: conversation state persisted to SQLite, resumable by id.
 *
 * Provider-specific wire translation lives entirely in the adapter; this loop
 * speaks only the neutral vocabulary (ModelMessage / ToolSchema / ModelDelta).
 */

import { mkdirSync, appendFileSync } from "fs";
import { dirname } from "path";
import { getTool, getToolDefinitions } from "../harness/tools";
import { McpManager, type McpServerConfig } from "../harness/mcp";
import { checkToolUse, scopeSystemPrompt } from "../scope";
import type { ScopeConfig, Toolset } from "../config/schema";
import { TOOLSETS } from "../config/schema";
import type { ToolContext, ToolDefinition, ToolResult } from "../harness/types";
import { resolveModel, computeCost, type ModelRegistry } from "../models/registry";
import type { StreamOptions } from "../models/provider";
import type {
  ModelMessage,
  ToolSchema,
  ToolCall,
  ToolResultPart,
  ContentPart,
  FinishReason,
  Usage,
} from "../models/types";
import { emptyUsage, addUsage } from "../models/types";
import { SessionStore } from "./sessions";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface AgentLoopResult {
  output: Record<string, unknown> | null;
  costUsd: number;
  sessionId: string | null;
  numTurns: number;
  durationMs: number;
  isError: boolean;
}

/**
 * A tool the caller injects into the loop directly (not from the built-in
 * file/bash registry). Its `execute` runs in-process against the loop's tool
 * context. This is how the L3 primary agent gets a graph-mutation toolset whose
 * "tools" commit deltas to the durable circuit (P5).
 */
export interface CustomTool {
  schema: ToolSchema;
  execute: (
    input: Record<string, unknown>,
    ctx: ToolContext,
  ) => Promise<ToolResult> | ToolResult;
}

/** InvokeEvent-shaped, tagged with the source action/node id. */
export interface AgentEvent {
  type: "text" | "tool_use" | "result";
  /** The action/node id this emission originated from (braid correlation). */
  source: string;
  text?: string;
  toolName?: string;
  toolInput?: Record<string, unknown>;
  result?: AgentLoopResult;
}

export interface AgentLoopOptions {
  prompt: string;
  systemPrompt?: string;
  model?: string;
  maxTurns?: number;
  maxTokens?: number;
  outputSchema?: object;
  /** Restrict the built-in tool registry to a named toolset. */
  toolset?: Toolset;
  /**
   * Tools injected directly into the loop (executed via their own `execute`),
   * in addition to (or instead of) the built-in registry. Used for the L3
   * primary agent's graph-mutation toolset.
   */
  customTools?: CustomTool[];
  /**
   * When false, the built-in file/bash tool registry is excluded so only
   * `customTools` (+ MCP) are available — a pure-mutation agent with no file
   * access. Defaults to true.
   */
  includeBuiltinTools?: boolean;
  cwd: string;
  env?: Record<string, string>;
  apiKey?: string;
  apiUrl?: string;
  logPath?: string;
  /** Source action/node id; every emitted event is tagged with it. */
  label?: string;
  abortController?: AbortController;
  onToolUse?: (toolName: string, toolInput: Record<string, unknown>) => void;
  mcpServers?: McpServerConfig[];
  scope?: ScopeConfig;
  /** Override the model registry (defaults to the shared one). */
  registry?: ModelRegistry;
  /** Durable session store; when set, conversation state is persisted. */
  sessions?: SessionStore;
  /** Resume a prior conversation by id (requires `sessions`). */
  sessionId?: string;
}

const DEFAULT_MAX_TOKENS = 8192;
// 80: a substantial build stage writes several files AND iterates a sanity
// check; 30 cut agents off mid-build. The primary agent / supervisor pass their
// own (smaller) caps, so this floor only affects build-style agent actions.
const DEFAULT_MAX_TURNS = 80;
const OUTPUT_TOOL_NAME = "StructuredOutput";

// ---------------------------------------------------------------------------
// JSONL logger
// ---------------------------------------------------------------------------

function logJsonl(logPath: string | undefined, label: string, event: string, data: Record<string, unknown> = {}) {
  if (!logPath) return;
  try { mkdirSync(dirname(logPath), { recursive: true }); } catch {}
  const record = { timestamp: new Date().toISOString(), label, event_type: event, ...data };
  appendFileSync(logPath, JSON.stringify(record) + "\n");
}

// ---------------------------------------------------------------------------
// Tool wiring
// ---------------------------------------------------------------------------

function toToolSchema(def: ToolDefinition): ToolSchema {
  return {
    name: def.name,
    description: def.description,
    inputSchema: def.input_schema as Record<string, unknown>,
  };
}

/** Built-in tools, optionally filtered to a named toolset (keyed by TOOLSETS). */
function builtinTools(toolset?: Toolset): ToolSchema[] {
  const defs = getToolDefinitions();
  if (!toolset) return defs.map(toToolSchema);
  const allowed = new Set(TOOLSETS[toolset]);
  return defs.filter((d) => allowed.has(d.name)).map(toToolSchema);
}

function buildOutputTool(outputSchema?: object): ToolSchema {
  const schema = (outputSchema as Record<string, unknown>) ?? {
    type: "object",
    properties: {
      status: { type: "string", enum: ["passed", "failed"], description: "Whether the action completed successfully." },
      summary: { type: "string", description: "Brief description of what was done or what went wrong." },
      notes: { type: "string", description: "Free-form guidance for the next action." },
      issues: { type: "string", description: "Description of any issues found." },
    },
    required: ["status", "summary"],
  };

  return {
    name: OUTPUT_TOOL_NAME,
    description: "Return your final result. You MUST call this tool when you are done with your task.",
    inputSchema: schema,
  };
}

// ---------------------------------------------------------------------------
// System prompt assembly
// ---------------------------------------------------------------------------

function buildSystemPrompt(options: AgentLoopOptions): string {
  const parts: string[] = [];
  if (options.systemPrompt) parts.push(options.systemPrompt);
  if (options.scope && (options.scope.writable?.length || options.scope.readable?.length)) {
    parts.push(scopeSystemPrompt(options.scope));
  }
  if (options.includeBuiltinTools === false) {
    // Pure-mutation agent (no file/bash tools): only the working-directory
    // context + the final-answer contract are relevant.
    parts.push(
      `When you have completed your task, you MUST call the ${OUTPUT_TOOL_NAME} tool with your result. ` +
        `Set status to 'passed' if successful, 'failed' if not.`,
    );
  } else {
    parts.push(
      `Your working directory is ${options.cwd}. All tool calls (Read, Write, Edit, Bash, Glob, Grep) ` +
        `execute relative to this directory. Do NOT cd to other directories. ` +
        `When you have completed your task, you MUST call the ${OUTPUT_TOOL_NAME} tool with your result. ` +
        `Set status to 'passed' if successful, 'failed' if not.`,
    );
  }
  return parts.join("\n\n");
}

// ---------------------------------------------------------------------------
// Structured output fallback (only used if forced final turn fails)
// ---------------------------------------------------------------------------

function extractStructuredOutput(text: string): Record<string, unknown> | null {
  const trimmed = text.trim();
  if (!trimmed) return null;
  try {
    const parsed = JSON.parse(trimmed);
    if (typeof parsed === "object" && parsed !== null) return parsed;
  } catch {
    const jsonMatch = trimmed.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      try {
        const parsed = JSON.parse(jsonMatch[0]);
        if (typeof parsed === "object" && parsed !== null) return parsed;
      } catch {}
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// One streamed turn — collect deltas, surfacing text as it arrives
// ---------------------------------------------------------------------------

interface ReducedTurn {
  text: string;
  toolCalls: ToolCall[];
  usage: Usage;
  stop: FinishReason;
}

// ---------------------------------------------------------------------------
// Core loop (async generator of source-tagged events)
// ---------------------------------------------------------------------------

export async function* agentLoop(options: AgentLoopOptions): AsyncGenerator<AgentEvent> {
  const registry = options.registry;
  const resolved = registry ? registry.resolveModel(options.model) : resolveModel(options.model);
  const maxTurns = options.maxTurns ?? DEFAULT_MAX_TURNS;
  const maxTokens = options.maxTokens ?? DEFAULT_MAX_TOKENS;
  const source = options.label ?? "agent";

  const toolContext: ToolContext = {
    cwd: options.cwd,
    env: options.env,
    abortSignal: options.abortController?.signal,
  };

  // Resolve/seed session.
  const store = options.sessions;
  const sessionId = store ? (options.sessionId ?? store.newId()) : (options.sessionId ?? null);
  const prior = store && options.sessionId ? store.load(options.sessionId) : null;

  const mcpManager = new McpManager();
  if (options.mcpServers && options.mcpServers.length > 0) {
    await mcpManager.connectAll(options.mcpServers);
  }

  const startTime = Date.now();
  let totalUsage: Usage = prior ? { ...prior.usage } : emptyUsage();
  const priorTurns = prior?.numTurns ?? 0;
  let turn = 0;
  let structuredOutput: Record<string, unknown> | null = null;
  let isError = false;
  let lastText = "";

  const outputTool = buildOutputTool(options.outputSchema);
  const customTools = options.customTools ?? [];
  const customToolMap = new Map(customTools.map((t) => [t.schema.name, t]));
  const builtins = options.includeBuiltinTools === false ? [] : builtinTools(options.toolset);
  const realTools: ToolSchema[] = [
    ...builtins,
    ...customTools.map((t) => t.schema),
    ...mcpManager.getToolDefinitions().map(toToolSchema),
  ];
  const allTools: ToolSchema[] = [...realTools, outputTool];
  const system = buildSystemPrompt(options);

  // Seed conversation: prior history (if resuming) + the new user prompt.
  const messages: ModelMessage[] = [
    ...(prior?.messages ?? []),
    { role: "user", content: options.prompt },
  ];

  const persist = () => {
    if (!store || !sessionId) return;
    store.save(sessionId, {
      actionId: options.label ?? null,
      model: resolved.id,
      messages,
      usage: totalUsage,
      costUsd: computeCost(resolved.price, totalUsage),
      numTurns: priorTurns + turn,
    });
  };

  logJsonl(options.logPath, source, "invoke_start", {
    prompt_length: options.prompt.length,
    model: resolved.id,
    max_turns: maxTurns,
    session_id: sessionId,
    resumed: !!prior,
  });

  try {
    let forceFinal = false;

    while (turn < maxTurns || forceFinal) {
      if (options.abortController?.signal.aborted) {
        isError = true;
        break;
      }

      turn++;

      const streamOpts: StreamOptions = {
        model: resolved.apiModel,
        system,
        maxTokens,
        signal: options.abortController?.signal,
        apiKey: options.apiKey,
        apiUrl: options.apiUrl,
        toolChoice: forceFinal ? { name: OUTPUT_TOOL_NAME } : "auto",
      };
      const turnTools = forceFinal ? [outputTool] : allTools;

      // Stream one turn, surfacing text as it arrives and tagging the source.
      const reduced: ReducedTurn = { text: "", toolCalls: [], usage: emptyUsage(), stop: "stop" };
      for await (const delta of resolved.provider.stream(messages, turnTools, streamOpts)) {
        if (delta.type === "text") {
          reduced.text += delta.text;
          yield { type: "text", source, text: delta.text };
        } else if (delta.type === "tool_call") {
          reduced.toolCalls.push(delta.toolCall);
        } else if (delta.type === "usage") {
          reduced.usage = delta.usage;
        } else if (delta.type === "stop") {
          reduced.stop = delta.reason;
        }
      }

      totalUsage = addUsage(totalUsage, reduced.usage);
      lastText = reduced.text;

      logJsonl(options.logPath, source, "api_turn", {
        turn,
        forced_final: forceFinal,
        input_tokens: reduced.usage.inputTokens,
        output_tokens: reduced.usage.outputTokens,
        cache_read_tokens: reduced.usage.cacheReadTokens,
        cache_creation_tokens: reduced.usage.cacheWriteTokens,
        stop_reason: reduced.stop,
      });

      // Record the assistant turn.
      const assistantParts: ContentPart[] = [];
      if (reduced.text) assistantParts.push({ type: "text", text: reduced.text });
      for (const tc of reduced.toolCalls) {
        assistantParts.push({ type: "tool_call", id: tc.id, name: tc.name, input: tc.input });
      }
      messages.push({ role: "assistant", content: assistantParts });

      // No tool calls: the model produced a final answer (prose).
      if (reduced.toolCalls.length === 0) {
        if (structuredOutput) { persist(); break; }
        if (!forceFinal) {
          // Explicit final-answer turn: force the output tool exactly once.
          forceFinal = true;
          persist();
          continue;
        }
        // Forced turn still yielded prose — fall back to best-effort extraction.
        structuredOutput = extractStructuredOutput(reduced.text);
        persist();
        break;
      }

      // Execute the requested tool calls.
      const toolResults: ToolResultPart[] = [];
      for (const call of reduced.toolCalls) {
        yield { type: "tool_use", source, toolName: call.name, toolInput: call.input };

        if (call.name === OUTPUT_TOOL_NAME) {
          structuredOutput = call.input;
          logJsonl(options.logPath, source, "tool_use", { tool_name: OUTPUT_TOOL_NAME, tool_input: call.input });
          options.onToolUse?.(OUTPUT_TOOL_NAME, call.input);
          toolResults.push({ type: "tool_result", toolCallId: call.id, content: "Result recorded." });
          continue;
        }

        // Scope enforcement.
        if (options.scope) {
          const violation = checkToolUse(options.scope, call.name, call.input, options.cwd);
          if (violation) {
            logJsonl(options.logPath, source, "scope_violation", {
              tool_name: call.name,
              file_path: violation.filePath,
              scope_type: violation.scopeType,
            });
            toolResults.push({
              type: "tool_result",
              toolCallId: call.id,
              content: `Scope violation: ${violation.scopeType} access to ${violation.filePath} not allowed. ` +
                `Allowed ${violation.scopeType} patterns: ${violation.allowedPatterns.join(", ")}`,
              isError: true,
            });
            continue;
          }
        }

        logJsonl(options.logPath, source, "tool_use", {
          tool_name: call.name,
          tool_use_id: call.id,
          tool_input: call.input,
        });
        options.onToolUse?.(call.name, call.input);

        // Injected custom tools (e.g. the L3 graph-mutation toolset) run first.
        const customTool = customToolMap.get(call.name);
        if (customTool) {
          const result = await customTool.execute(call.input, toolContext);
          toolResults.push({ type: "tool_result", toolCallId: call.id, content: result.output, isError: result.isError });
          continue;
        }

        const mcpResult = await mcpManager.callTool(call.name, call.input);
        if (mcpResult) {
          toolResults.push({ type: "tool_result", toolCallId: call.id, content: mcpResult.output, isError: mcpResult.isError });
        } else {
          const tool = getTool(call.name);
          if (!tool) {
            toolResults.push({ type: "tool_result", toolCallId: call.id, content: `Unknown tool: ${call.name}`, isError: true });
          } else {
            const result = await tool.execute(call.input, toolContext);
            toolResults.push({ type: "tool_result", toolCallId: call.id, content: result.output, isError: result.isError });
          }
        }
      }

      messages.push({ role: "tool", content: toolResults });
      persist();

      if (structuredOutput) break;
      if (forceFinal) break; // forced output turn done
    }
  } catch (e: any) {
    isError = true;
    if (!structuredOutput) {
      structuredOutput = { status: "failed", summary: e?.message ?? String(e) };
    }
  } finally {
    mcpManager.closeAll();
  }

  if (turn >= maxTurns && !structuredOutput) {
    isError = true;
    structuredOutput = { status: "failed", summary: `Exceeded max turns (${maxTurns})` };
  }

  const durationMs = Date.now() - startTime;
  const costUsd = computeCost(resolved.price, totalUsage);
  persist();

  logJsonl(options.logPath, source, "invoke_end", {
    cost_usd: costUsd,
    duration_ms: durationMs,
    num_turns: turn,
    is_error: isError,
    session_id: sessionId,
    structured_output: structuredOutput,
    total_input_tokens: totalUsage.inputTokens,
    total_output_tokens: totalUsage.outputTokens,
    total_cache_read_tokens: totalUsage.cacheReadTokens,
  });

  const result: AgentLoopResult = {
    output: structuredOutput,
    costUsd,
    sessionId,
    numTurns: turn,
    durationMs,
    isError,
  };
  yield { type: "result", source, result };
}

// ---------------------------------------------------------------------------
// Simple wrapper — consume the stream, return the result
// ---------------------------------------------------------------------------

export async function runAgentLoop(
  options: AgentLoopOptions,
  onEvent?: (event: AgentEvent) => void,
): Promise<AgentLoopResult> {
  let result: AgentLoopResult | null = null;
  for await (const event of agentLoop(options)) {
    onEvent?.(event);
    if (event.type === "result" && event.result) result = event.result;
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
