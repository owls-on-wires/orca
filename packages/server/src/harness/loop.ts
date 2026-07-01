/**
 * Agentic loop (Layer B) — resolves a ModelProvider from the registry by model
 * id, drives it turn-by-turn via provider.stream(), executes tool calls
 * locally, and repeats until the model stops or limits are hit.
 *
 * The loop speaks Orca's neutral model vocabulary (ModelMessage / ToolSchema /
 * ModelDelta); all provider-specific wire translation lives in the adapter.
 */

import { mkdirSync, appendFileSync } from "fs";
import { dirname } from "path";
import { getTool, getToolDefinitions } from "./tools";
import { McpManager } from "./mcp";
import { checkToolUse, scopeSystemPrompt } from "../scope";
import type { HarnessResult, HarnessOptions, ToolContext, ToolDefinition } from "./types";
import { resolveModel, computeCost } from "../models/registry";
import type { ModelProvider, StreamOptions } from "../models/provider";
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
// Defaults
// ---------------------------------------------------------------------------

const DEFAULT_MAX_TOKENS = 8192;

// ---------------------------------------------------------------------------
// Tool schema conversion (harness ToolDefinition -> neutral ToolSchema)
// ---------------------------------------------------------------------------

function toToolSchema(def: ToolDefinition): ToolSchema {
  return {
    name: def.name,
    description: def.description,
    inputSchema: def.input_schema as Record<string, unknown>,
  };
}

// ---------------------------------------------------------------------------
// Turn reduction — collapse a provider stream into one assistant turn
// ---------------------------------------------------------------------------

interface ReducedTurn {
  text: string;
  toolCalls: ToolCall[];
  usage: Usage;
  stop: FinishReason;
}

async function reduceTurn(
  provider: ModelProvider,
  messages: ModelMessage[],
  tools: ToolSchema[],
  opts: StreamOptions,
): Promise<ReducedTurn> {
  let text = "";
  const toolCalls: ToolCall[] = [];
  let usage: Usage = emptyUsage();
  let stop: FinishReason = "stop";

  for await (const delta of provider.stream(messages, tools, opts)) {
    if (delta.type === "text") text += delta.text;
    else if (delta.type === "tool_call") toolCalls.push(delta.toolCall);
    else if (delta.type === "usage") usage = delta.usage;
    else if (delta.type === "stop") stop = delta.reason;
  }

  return { text, toolCalls, usage, stop };
}

// ---------------------------------------------------------------------------
// Structured output extraction (fallback when the model ends with prose)
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
// Structured output tool
// ---------------------------------------------------------------------------

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
    name: "StructuredOutput",
    description: "Return your final result. You MUST call this tool when you are done with your task.",
    inputSchema: schema,
  };
}

// ---------------------------------------------------------------------------
// System prompt assembly
// ---------------------------------------------------------------------------

function buildSystemPrompt(options: HarnessOptions): string {
  const parts: string[] = [];
  if (options.systemPrompt) parts.push(options.systemPrompt);
  if (options.scope && (options.scope.writable?.length || options.scope.readable?.length)) {
    parts.push(scopeSystemPrompt(options.scope));
  }
  parts.push(
    `Your working directory is ${options.cwd}. All tool calls (Read, Write, Edit, Bash, Glob, Grep) ` +
      `execute relative to this directory. Do NOT cd to other directories. ` +
      `When you have completed your task, you MUST call the StructuredOutput tool with your result. ` +
      `Set status to 'passed' if successful, 'failed' if not.`,
  );
  return parts.join("\n\n");
}

// ---------------------------------------------------------------------------
// Main loop
// ---------------------------------------------------------------------------

export async function runAgentLoop(options: HarnessOptions): Promise<HarnessResult> {
  const resolved = resolveModel(options.model);
  const maxTurns = options.maxTurns ?? 30;
  const maxTokens = options.maxTokens ?? DEFAULT_MAX_TOKENS;
  const label = options.label ?? "harness";

  const toolContext: ToolContext = {
    cwd: options.cwd,
    env: options.env,
    abortSignal: options.abortController?.signal,
  };

  // Connect MCP servers (if any)
  const mcpManager = new McpManager();
  if (options.mcpServers && options.mcpServers.length > 0) {
    await mcpManager.connectAll(options.mcpServers);
  }

  try {
    // Build tool list: registered tools + MCP tools + structured output tool
    const outputTool = buildOutputTool(options.outputSchema);
    const tools: ToolSchema[] = [
      ...getToolDefinitions().map(toToolSchema),
      ...mcpManager.getToolDefinitions().map(toToolSchema),
      outputTool,
    ];

    const system = buildSystemPrompt(options);
    const messages: ModelMessage[] = [{ role: "user", content: options.prompt }];

    logJsonl(options.logPath, label, "invoke_start", {
      prompt_length: options.prompt.length,
      model: resolved.id,
      max_turns: maxTurns,
    });

    const startTime = Date.now();
    let totalUsage: Usage = emptyUsage();
    let turn = 0;
    let structuredOutput: Record<string, unknown> | null = null;
    let isError = false;

    try {
      while (turn < maxTurns) {
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
        };

        const { text, toolCalls, usage, stop } = await reduceTurn(resolved.provider, messages, tools, streamOpts);

        totalUsage = addUsage(totalUsage, usage);

        logJsonl(options.logPath, label, "api_turn", {
          turn,
          input_tokens: usage.inputTokens,
          output_tokens: usage.outputTokens,
          cache_read_tokens: usage.cacheReadTokens,
          cache_creation_tokens: usage.cacheWriteTokens,
          stop_reason: stop,
        });

        // Record the assistant turn.
        const assistantParts: ContentPart[] = [];
        if (text) assistantParts.push({ type: "text", text });
        for (const tc of toolCalls) {
          assistantParts.push({ type: "tool_call", id: tc.id, name: tc.name, input: tc.input });
        }
        messages.push({ role: "assistant", content: assistantParts });

        // No tool calls (or a clean stop) — we're done.
        if (toolCalls.length === 0 || stop === "stop") {
          structuredOutput = extractStructuredOutput(text);
          break;
        }

        // Execute tool calls.
        const toolResults: ToolResultPart[] = [];
        for (const call of toolCalls) {
          if (call.name === outputTool.name) {
            structuredOutput = call.input;
            logJsonl(options.logPath, label, "tool_use", { tool_name: "StructuredOutput", tool_input: call.input });
            options.onToolUse?.("StructuredOutput", call.input);
            toolResults.push({ type: "tool_result", toolCallId: call.id, content: "Result recorded." });
            continue;
          }

          // Scope enforcement.
          if (options.scope) {
            const violation = checkToolUse(options.scope, call.name, call.input, options.cwd);
            if (violation) {
              logJsonl(options.logPath, label, "scope_violation", {
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

          logJsonl(options.logPath, label, "tool_use", {
            tool_name: call.name,
            tool_use_id: call.id,
            tool_input: call.input,
          });
          options.onToolUse?.(call.name, call.input);

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

        if (structuredOutput) break;
      }
    } catch (e: any) {
      isError = true;
      if (!structuredOutput) {
        structuredOutput = { status: "failed", summary: e.message };
      }
    }

    const durationMs = Date.now() - startTime;
    const costUsd = computeCost(resolved.price, totalUsage);

    if (turn >= maxTurns && !structuredOutput) {
      isError = true;
      structuredOutput = { status: "failed", summary: `Exceeded max turns (${maxTurns})` };
    }

    logJsonl(options.logPath, label, "invoke_end", {
      cost_usd: costUsd,
      duration_ms: durationMs,
      num_turns: turn,
      is_error: isError,
      structured_output: structuredOutput,
      total_input_tokens: totalUsage.inputTokens,
      total_output_tokens: totalUsage.outputTokens,
      total_cache_read_tokens: totalUsage.cacheReadTokens,
    });

    return {
      output: structuredOutput,
      costUsd,
      numTurns: turn,
      durationMs,
      isError,
    };
  } finally {
    mcpManager.closeAll();
  }
}
