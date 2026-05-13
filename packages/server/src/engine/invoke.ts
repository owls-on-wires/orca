/**
 * Claude Agent SDK invocation.
 *
 * All Claude Code interactions go through this module.
 * Handles prompt rendering, structured output,
 * session management, and scope enforcement via can_use_tool.
 */

import { mkdirSync, appendFileSync } from "fs";
import { dirname, resolve } from "path";
import { checkToolUse, scopeSystemPrompt } from "../scope";
import type { ScopeConfig, Toolset } from "../config/schema";
import { TOOLSETS } from "../config/schema";
import { getSystemPrompt } from "../config/prompts";

// ---------------------------------------------------------------------------
// Types
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
// Claude Code executable resolution
// ---------------------------------------------------------------------------

function findClaudeExecutable(): string {
  const result = Bun.spawnSync(["which", "claude"]);
  const path = result.stdout.toString().trim();
  if (result.exitCode === 0 && path) return path;
  throw new Error("Claude Code executable not found in PATH. Install Claude Code first.");
}

// ---------------------------------------------------------------------------
// JSONL logger
// ---------------------------------------------------------------------------

class JsonlLog {
  private path: string | null;
  private label: string;

  constructor(path: string | null | undefined, label: string) {
    this.path = path ?? null;
    this.label = label;
    if (this.path) {
      try { mkdirSync(dirname(this.path), { recursive: true }); } catch {}
    }
  }

  write(eventType: string, data: Record<string, unknown> = {}) {
    if (!this.path) return;
    const record = {
      timestamp: new Date().toISOString(),
      label: this.label,
      event_type: eventType,
      ...data,
    };
    appendFileSync(this.path, JSON.stringify(record) + "\n");
  }
}

// ---------------------------------------------------------------------------
// Invoke
// ---------------------------------------------------------------------------

export async function* invoke(
  options: InvokeOptions,
): AsyncGenerator<InvokeEvent> {
  const sdk = await import("@anthropic-ai/claude-agent-sdk");
  const { query } = sdk;
  type SDKAssistantMessage = import("@anthropic-ai/claude-agent-sdk").SDKAssistantMessage;
  type SDKResultMessage = import("@anthropic-ai/claude-agent-sdk").SDKResultMessage;
  type SdkOptions = import("@anthropic-ai/claude-agent-sdk").Options;
  type CanUseTool = import("@anthropic-ai/claude-agent-sdk").CanUseTool;

  const label = options.label ?? "invoke";
  const log = new JsonlLog(options.logPath, label);

  // Build system prompt — always include orca's default, then user-provided, then scope
  const systemParts: string[] = [getSystemPrompt()];
  if (options.systemPrompt) systemParts.push(options.systemPrompt);
  if (options.scope) systemParts.push(scopeSystemPrompt(options.scope));
  const systemPromptAppend = systemParts.join("\n\n");

  const systemPrompt: SdkOptions["systemPrompt"] = {
    type: "preset" as const,
    preset: "claude_code" as const,
    append: systemPromptAppend,
  };

  // Build output format
  let outputFormat: SdkOptions["outputFormat"] = undefined;
  if (options.outputSchema) {
    const schema = options.outputSchema as Record<string, unknown>;
    if (schema.type === "json_schema") {
      outputFormat = schema as SdkOptions["outputFormat"];
    } else {
      outputFormat = { type: "json_schema", schema } as SdkOptions["outputFormat"];
    }
  }

  // Build can_use_tool callback for scope enforcement
  let canUseTool: CanUseTool | undefined = undefined;
  if (options.scope && (options.scope.writable?.length || options.scope.readable?.length)) {
    const scope = options.scope;
    const projectDir = resolve(options.projectDir);
    canUseTool = async (toolName, input, _opts) => {
      const violation = checkToolUse(scope, toolName, input, projectDir);
      if (violation) {
        log.write("scope_violation", { violation: `${violation.scopeType}: ${violation.toolName}(${violation.filePath})` });
        return { behavior: "deny" as const, message: `Scope violation: ${violation.scopeType} access to ${violation.filePath} not allowed` };
      }
      return { behavior: "allow" as const, updatedInput: input };
    };
  }

  // Resolve tools — `tools` restricts which tools are available,
  // `allowedTools` only controls auto-approval for permissions.
  const tools: string[] | undefined = options.toolset ? TOOLSETS[options.toolset] : undefined;

  // Resolve Claude Code executable path.
  // The SDK default uses dirname(__filename)/cli.js, which in a compiled Bun
  // binary resolves to /$bunfs/root/cli.js (virtual filesystem). We need the
  // real path to the claude binary.
  const claudePath = findClaudeExecutable();

  // Build SDK options
  const sdkOptions: SdkOptions = {
    systemPrompt,
    permissionMode: "bypassPermissions",
    allowDangerouslySkipPermissions: true,
    tools,
    canUseTool,
    model: options.model,
    pathToClaudeCodeExecutable: claudePath,
    maxTurns: options.maxTurns,
    resume: options.sessionId,
    cwd: resolve(options.projectDir),
    outputFormat,
    settingSources: ["user", "project", "local"],
    abortController: options.abortController,
    env: options.env,
  };

  log.write("invoke_start", {
    prompt_length: options.prompt.length,
    prompt: options.prompt,
    model: options.model,
    max_turns: options.maxTurns,
    session_id: options.sessionId ?? null,
    toolset: options.toolset,
  });

  let structuredOutput: unknown = null;
  let resultSessionId: string | null = null;
  let resultCost = 0;
  let resultNumTurns = 0;
  let resultDurationMs = 0;
  let resultIsError = false;

  try {
    const q = query({ prompt: options.prompt, options: sdkOptions });

    for await (const message of q) {
      if (message.type === "assistant") {
        const assistantMsg = message as SDKAssistantMessage;
        const content = assistantMsg.message?.content;
        if (Array.isArray(content)) {
          for (const block of content) {
            if (block.type === "text") {
              yield { type: "text", text: block.text };
            } else if (block.type === "tool_use") {
              yield {
                type: "tool_use",
                toolName: block.name,
                toolInput: block.input as Record<string, unknown>,
              };
              log.write("tool_use", {
                tool_name: block.name,
                tool_use_id: block.id,
                tool_input: block.input,
              });
            }
          }
        }
      } else if (message.type === "result") {
        const resultMsg = message as SDKResultMessage;
        if (resultMsg.subtype === "success") {
          resultSessionId = resultMsg.session_id;
          resultCost = resultMsg.total_cost_usd ?? 0;
          resultNumTurns = resultMsg.num_turns ?? 0;
          resultDurationMs = resultMsg.duration_ms ?? 0;
          resultIsError = resultMsg.is_error ?? false;
          // Don't let spurious SDK results with null output overwrite a valid one.
          // The SDK sometimes yields multiple result messages; only the first
          // has structured_output populated.
          if (resultMsg.structured_output != null || structuredOutput == null) {
            structuredOutput = resultMsg.structured_output;
          }

          log.write("invoke_end", {
            cost_usd: resultCost,
            duration_ms: resultDurationMs,
            num_turns: resultNumTurns,
            is_error: resultIsError,
            session_id: resultSessionId,
            structured_output: structuredOutput,
          });
        }
      }
    }
  } finally {
    // cleanup if needed
  }

  yield {
    type: "result",
    result: {
      output: typeof structuredOutput === "object" && structuredOutput !== null
        ? structuredOutput as Record<string, unknown>
        : null,
      costUsd: resultCost,
      sessionId: resultSessionId,
      numTurns: resultNumTurns,
      durationMs: resultDurationMs,
      isError: resultIsError,
    },
  };
}

// ---------------------------------------------------------------------------
// Simple invoke (consumes the stream, returns result)
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
      // Prefer a result with non-null structured output over one without.
      // The SDK sometimes yields a second result with null output after a
      // valid one — don't let the null overwrite the real output.
      if (!result || event.result.output !== null) {
        result = event.result;
      }
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
