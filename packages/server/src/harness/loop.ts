/**
 * Agentic loop — calls the Anthropic Messages API, executes tool calls
 * locally, and repeats until the model stops or limits are hit.
 */

import { mkdirSync, appendFileSync } from "fs";
import { dirname } from "path";
import { getTool, getToolDefinitions } from "./tools";
import { McpManager, type McpServerConfig } from "./mcp";
import { checkToolUse, scopeSystemPrompt } from "../scope";
import type {
  ApiMessage,
  ApiRequest,
  ApiResponse,
  ApiContentBlock,
  ApiSystemBlock,
  ApiToolUseBlock,
  ApiToolResultBlock,
  HarnessResult,
  HarnessOptions,
  ToolContext,
} from "./types";
import { estimateCost } from "./types";
import { getSecret } from "./secrets";

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
// API client
// ---------------------------------------------------------------------------

const DEFAULT_API_URL = "https://api.anthropic.com";
const DEFAULT_MODEL = "claude-sonnet-4-6";
const DEFAULT_MAX_TOKENS = 8192;

async function callApi(
  request: ApiRequest,
  apiKey: string,
  apiUrl: string,
  signal?: AbortSignal,
): Promise<ApiResponse> {
  const url = `${apiUrl}/v1/messages`;

  const response = await fetch(url, {
    method: "POST",
    headers: {
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
      "content-type": "application/json",
    },
    body: JSON.stringify(request),
    signal,
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Anthropic API error ${response.status}: ${body}`);
  }

  return (await response.json()) as ApiResponse;
}

// ---------------------------------------------------------------------------
// Tool execution
// ---------------------------------------------------------------------------

async function executeToolCall(
  toolUse: ApiToolUseBlock,
  context: ToolContext,
): Promise<ApiToolResultBlock> {
  const tool = getTool(toolUse.name);

  if (!tool) {
    return {
      type: "tool_result",
      tool_use_id: toolUse.id,
      content: `Unknown tool: ${toolUse.name}`,
      is_error: true,
    };
  }

  const result = await tool.execute(toolUse.input, context);

  return {
    type: "tool_result",
    tool_use_id: toolUse.id,
    content: result.output,
    is_error: result.isError,
  };
}

// ---------------------------------------------------------------------------
// Structured output extraction
// ---------------------------------------------------------------------------

function extractStructuredOutput(
  response: ApiResponse,
): Record<string, unknown> | null {
  // Look for the last text block and try to parse as JSON
  for (let i = response.content.length - 1; i >= 0; i--) {
    const block = response.content[i];
    if (block.type === "text") {
      const text = block.text.trim();
      // Try to parse JSON from the text
      try {
        const parsed = JSON.parse(text);
        if (typeof parsed === "object" && parsed !== null) {
          return parsed;
        }
      } catch {
        // Try to find JSON embedded in the text
        const jsonMatch = text.match(/\{[\s\S]*\}/);
        if (jsonMatch) {
          try {
            const parsed = JSON.parse(jsonMatch[0]);
            if (typeof parsed === "object" && parsed !== null) {
              return parsed;
            }
          } catch {}
        }
      }
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Build the structured output tool
// ---------------------------------------------------------------------------

function buildOutputTool(outputSchema?: object): {
  definition: import("./types").ToolDefinition;
  name: string;
} {
  const schema = outputSchema ?? {
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
    definition: {
      name: "StructuredOutput",
      description: "Return your final result. You MUST call this tool when you are done with your task.",
      input_schema: schema,
    },
  };
}

// ---------------------------------------------------------------------------
// Main loop
// ---------------------------------------------------------------------------

export async function runAgentLoop(options: HarnessOptions): Promise<HarnessResult> {
  const apiKey = options.apiKey ?? getSecret("ANTHROPIC_API_KEY");
  if (!apiKey) throw new Error("ANTHROPIC_API_KEY not set. Add it to packages/server/secrets.json or set the environment variable.");

  const apiUrl = options.apiUrl ?? DEFAULT_API_URL;
  const model = options.model ?? DEFAULT_MODEL;
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
  const toolDefs = [...getToolDefinitions(), ...mcpManager.getToolDefinitions(), outputTool.definition];

  // Build initial messages
  const messages: ApiMessage[] = [
    { role: "user", content: options.prompt },
  ];

  logJsonl(options.logPath, label, "invoke_start", {
    prompt_length: options.prompt.length,
    model,
    max_turns: maxTurns,
  });

  const startTime = Date.now();
  let totalInputTokens = 0;
  let totalOutputTokens = 0;
  let totalCacheReadTokens = 0;
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

      // Build system prompt as cached content blocks
      const systemBlocks: ApiSystemBlock[] = [];
      if (options.systemPrompt) {
        systemBlocks.push({ type: "text", text: options.systemPrompt });
      }
      if (options.scope && (options.scope.writable?.length || options.scope.readable?.length)) {
        systemBlocks.push({ type: "text", text: scopeSystemPrompt(options.scope) });
      }
      systemBlocks.push({
        type: "text",
        text: `Your working directory is ${options.cwd}. All tool calls (Read, Write, Edit, Bash, Glob, Grep) ` +
          `execute relative to this directory. Do NOT cd to other directories. ` +
          `When you have completed your task, you MUST call the StructuredOutput tool with your result. ` +
          `Set status to 'passed' if successful, 'failed' if not.`,
        cache_control: { type: "ephemeral" },
      });

      // Mark the last tool definition for caching (caches the entire tools prefix)
      const cachedToolDefs = toolDefs.map((t, i) =>
        i === toolDefs.length - 1 ? { ...t, cache_control: { type: "ephemeral" as const } } : t,
      );

      const request: ApiRequest = {
        model,
        max_tokens: maxTokens,
        system: systemBlocks,
        messages,
        tools: cachedToolDefs,
      };

      const response = await callApi(request, apiKey, apiUrl, options.abortController?.signal);

      // Track tokens
      totalInputTokens += response.usage.input_tokens;
      totalOutputTokens += response.usage.output_tokens;
      totalCacheReadTokens += response.usage.cache_read_input_tokens ?? 0;

      logJsonl(options.logPath, label, "api_turn", {
        turn,
        input_tokens: response.usage.input_tokens,
        output_tokens: response.usage.output_tokens,
        cache_read_tokens: response.usage.cache_read_input_tokens ?? 0,
        cache_creation_tokens: response.usage.cache_creation_input_tokens ?? 0,
        stop_reason: response.stop_reason,
      });

      // Add assistant response to conversation
      messages.push({ role: "assistant", content: response.content });

      // Check for tool use
      const toolUses = response.content.filter(
        (b): b is ApiToolUseBlock => b.type === "tool_use",
      );

      // If no tool calls, we're done
      if (toolUses.length === 0 || response.stop_reason === "end_turn") {
        structuredOutput = extractStructuredOutput(response);
        break;
      }

      // Execute tool calls
      const toolResults: ApiToolResultBlock[] = [];
      for (const toolUse of toolUses) {
        // Check for structured output tool
        if (toolUse.name === outputTool.name) {
          structuredOutput = toolUse.input;
          logJsonl(options.logPath, label, "tool_use", {
            tool_name: "StructuredOutput",
            tool_input: toolUse.input,
          });
          options.onToolUse?.("StructuredOutput", toolUse.input);

          // Return the tool result to complete the conversation
          toolResults.push({
            type: "tool_result",
            tool_use_id: toolUse.id,
            content: "Result recorded.",
          });
          continue;
        }

        // Scope enforcement — block file access outside allowed patterns
        if (options.scope) {
          const violation = checkToolUse(options.scope, toolUse.name, toolUse.input, options.cwd);
          if (violation) {
            logJsonl(options.logPath, label, "scope_violation", {
              tool_name: toolUse.name,
              file_path: violation.filePath,
              scope_type: violation.scopeType,
            });
            toolResults.push({
              type: "tool_result",
              tool_use_id: toolUse.id,
              content: `Scope violation: ${violation.scopeType} access to ${violation.filePath} not allowed. ` +
                `Allowed ${violation.scopeType} patterns: ${violation.allowedPatterns.join(", ")}`,
              is_error: true,
            });
            continue;
          }
        }

        // Execute regular tool (check MCP servers first, then built-in tools)
        logJsonl(options.logPath, label, "tool_use", {
          tool_name: toolUse.name,
          tool_use_id: toolUse.id,
          tool_input: toolUse.input,
        });
        options.onToolUse?.(toolUse.name, toolUse.input);

        const mcpResult = await mcpManager.callTool(toolUse.name, toolUse.input);
        if (mcpResult) {
          toolResults.push({
            type: "tool_result",
            tool_use_id: toolUse.id,
            content: mcpResult.output,
            is_error: mcpResult.isError,
          });
        } else {
          const result = await executeToolCall(toolUse, toolContext);
          toolResults.push(result);
        }
      }

      // Add tool results to conversation
      messages.push({ role: "user", content: toolResults });

      // If we got structured output, stop after this round
      if (structuredOutput) break;
    }
  } catch (e: any) {
    isError = true;
    if (!structuredOutput) {
      structuredOutput = { status: "failed", summary: e.message };
    }
  }

  const durationMs = Date.now() - startTime;
  const costUsd = estimateCost(model, totalInputTokens, totalOutputTokens, totalCacheReadTokens);

  // If max turns hit without structured output, mark as error
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
    total_input_tokens: totalInputTokens,
    total_output_tokens: totalOutputTokens,
    total_cache_read_tokens: totalCacheReadTokens,
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
