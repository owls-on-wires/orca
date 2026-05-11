/**
 * Action runner — executes a single action and returns a classified result.
 */

import { resolve } from "path";
import { readFileSync, existsSync } from "fs";
import { invokeSimple } from "../engine/invoke";
import type { InvokeResult, InvokeOptions } from "../engine/invoke";
import { applyVars } from "../templates";
import { buildNixCommand } from "../nix";
import type { ScopeConfig, Toolset } from "../config/schema";
import type { ActionConfig, ActionOutput, EdgeCondition, NixConfig } from "./schema";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ActionResult {
  condition: EdgeCondition;
  output: ActionOutput;
  cost_usd: number;
  duration_ms: number;
  num_turns: number;
}

export interface WaitingResult {
  waiting: true;
  output: ActionOutput;
}

export interface RunOptions {
  projectDir: string;
  model?: string;
  scope?: ScopeConfig;
  nix?: NixConfig;
  logPath?: string;
  onToolUse?: (toolName: string, toolInput: Record<string, unknown>) => void;
  abortController?: AbortController;
}

export interface PredecessorOutput {
  actionId: string;
  output: ActionOutput;
}

/** Default structured output schema for agent actions. */
const DEFAULT_OUTPUT_SCHEMA = {
  type: "object",
  properties: {
    status: {
      type: "string",
      enum: ["passed", "failed"],
      description: "Whether the action completed successfully.",
    },
    summary: {
      type: "string",
      description: "Brief description of what was done or what went wrong.",
    },
    notes: {
      type: "string",
      description: "Free-form guidance for the next action: file paths, queries, commands, caveats.",
    },
    issues: {
      type: "string",
      description: "Description of any issues found. Empty if status is passed.",
    },
  },
  required: ["status", "summary"],
};

// ---------------------------------------------------------------------------
// Predecessor output injection
// ---------------------------------------------------------------------------

export function buildPredecessorPrompt(predecessors: PredecessorOutput[]): string {
  if (predecessors.length === 0) return "";

  const sections = predecessors.map((p) => {
    let section = `### ${p.actionId} (${p.output.status})`;
    if (p.output.summary) {
      section += `\nSummary: ${p.output.summary}`;
    }
    if (p.output.notes) {
      section += `\nNotes: ${p.output.notes}`;
    }
    return section;
  });

  return `## Previous actions\n${sections.join("\n\n")}`;
}

// ---------------------------------------------------------------------------
// Watchdog: recovers from SDK generator hangs by reading JSONL log
// ---------------------------------------------------------------------------

const WATCHDOG_POLL_INTERVAL = 5000;  // check log every 5 seconds
const WATCHDOG_GRACE_PERIOD = 15000;  // wait 15s after invoke_end before force-resolving

async function invokeWithWatchdog(
  options: InvokeOptions,
  onToolUse?: (toolName: string, toolInput: Record<string, unknown>) => void,
): Promise<InvokeResult> {
  const logPath = options.logPath;

  // If no log path, can't watchdog — fall back to direct call
  if (!logPath) {
    return invokeSimple(options, onToolUse);
  }

  // Count existing invoke_end entries so we only detect NEW ones
  let existingEnds = 0;
  if (existsSync(logPath)) {
    const content = readFileSync(logPath, "utf8");
    existingEnds = content.split("\n").filter(l => l.includes('"invoke_end"')).length;
  }

  return new Promise<InvokeResult>((resolveOuter) => {
    let resolved = false;
    let watchdogInterval: ReturnType<typeof setInterval> | null = null;
    let graceTimeout: ReturnType<typeof setTimeout> | null = null;

    function cleanup() {
      if (watchdogInterval) { clearInterval(watchdogInterval); watchdogInterval = null; }
      if (graceTimeout) { clearTimeout(graceTimeout); graceTimeout = null; }
    }

    function finish(result: InvokeResult) {
      if (resolved) return;
      resolved = true;
      cleanup();
      resolveOuter(result);
    }

    // Start the real invoke
    invokeSimple(options, onToolUse).then(
      (result) => finish(result),
      (err) => {
        // On error, resolve with error result rather than rejecting
        finish({
          output: null,
          costUsd: 0,
          sessionId: null,
          numTurns: 0,
          durationMs: 0,
          isError: true,
        });
      },
    );

    // Watchdog: poll the JSONL log for a new invoke_end
    watchdogInterval = setInterval(() => {
      if (resolved) { cleanup(); return; }
      if (!existsSync(logPath)) return;

      try {
        const content = readFileSync(logPath, "utf8");
        const lines = content.trim().split("\n").filter(Boolean);
        const endLines = lines.filter(l => l.includes('"invoke_end"'));

        // Only trigger on NEW invoke_end entries
        if (endLines.length <= existingEnds) return;

        // Found a new invoke_end — start grace period
        const lastEnd = JSON.parse(endLines[endLines.length - 1]);

        if (!graceTimeout) {
          graceTimeout = setTimeout(() => {
            if (resolved) return;
            // Grace period expired — invokeSimple didn't resolve. Force-resolve from log.
            const result: InvokeResult = {
              output: lastEnd.structured_output ?? null,
              costUsd: lastEnd.cost_usd ?? 0,
              sessionId: lastEnd.session_id ?? null,
              numTurns: lastEnd.num_turns ?? 0,
              durationMs: lastEnd.duration_ms ?? 0,
              isError: lastEnd.is_error ?? false,
            };
            console.log(`[watchdog] Force-resolving ${options.label} from JSONL (SDK generator hung)`);
            finish(result);
          }, WATCHDOG_GRACE_PERIOD);
        }
      } catch {
        // Ignore read errors — file might be mid-write
      }
    }, WATCHDOG_POLL_INTERVAL);
  });
}

// ---------------------------------------------------------------------------
// Agent action
// ---------------------------------------------------------------------------

async function runAgentAction(
  action: ActionConfig,
  predecessorOutputs: PredecessorOutput[],
  options: RunOptions,
): Promise<ActionResult> {
  const params = action.params;
  const prompt = params.prompt as string;
  const systemPrompt = params.system_prompt as string | undefined;
  const maxTurns = params.max_turns as number | undefined;
  const toolset = params.toolset as Toolset | undefined;
  const outputSchema = (params.output_schema as object | undefined) ?? DEFAULT_OUTPUT_SCHEMA;

  // Build full prompt with predecessor injection
  const parts: string[] = [];
  const predecessorPrompt = buildPredecessorPrompt(predecessorOutputs);
  if (predecessorPrompt) {
    parts.push(predecessorPrompt);
  }
  parts.push(prompt);

  const fullPrompt = parts.join("\n\n");

  const result = await invokeWithWatchdog({
    prompt: fullPrompt,
    projectDir: resolve(options.projectDir),
    model: options.model,
    toolset,
    maxTurns,
    outputSchema,
    scope: options.scope,
    logPath: options.logPath,
    systemPrompt,
    label: action.id,
    abortController: options.abortController,
  }, options.onToolUse);

  // Always extract cost/turns/duration regardless of subtype
  const cost_usd = result.costUsd;
  const num_turns = result.numTurns;
  const duration_ms = result.durationMs;

  // Classify based on result
  let condition: EdgeCondition;
  let output: ActionOutput;

  if (result.isError) {
    // Determine error subtype from the result
    // The InvokeResult abstracts away subtypes — isError=true means non-success
    // We check if it was max_turns by looking at numTurns vs maxTurns
    if (maxTurns && num_turns >= maxTurns) {
      condition = "max_turns";
    } else {
      condition = "error";
    }
    output = {
      status: "failed",
      summary: "Action failed with error",
      ...(result.output as Record<string, unknown> ?? {}),
    };
  } else {
    // Success subtype — classify from structured output
    const structuredOutput = result.output as Record<string, unknown> | null;
    const status = structuredOutput?.status as string | undefined;

    if (status === "passed") {
      condition = "pass";
    } else if (status === "failed") {
      condition = "fail";
    } else {
      // Unknown or missing status — classify as error, not fail.
      // "fail" means the agent tried and reported failure (retry makes sense).
      // "error" means the output was malformed or unexpected (escalate).
      condition = "error";
    }

    output = {
      status: status ?? "unknown",
      summary: (structuredOutput?.summary as string) ?? "",
      ...(structuredOutput ?? {}),
    };
  }

  return { condition, output, cost_usd, duration_ms, num_turns };
}

// ---------------------------------------------------------------------------
// Command action
// ---------------------------------------------------------------------------

async function runCommandAction(
  action: ActionConfig,
  predecessorOutputs: PredecessorOutput[],
  options: RunOptions,
): Promise<ActionResult | WaitingResult> {
  const params = action.params;
  const command = params.command as string;
  const timeout = ((params.timeout as number) ?? 120) * 1000; // convert to ms
  const waitForResponse = params.wait_for_response as boolean | undefined;
  const waitFor = params.wait_for as string | undefined;
  const waitTimeout = ((params.wait_timeout as number) ?? 60) * 1000;

  // Interpolate template variables
  const vars: Record<string, string> = {};
  // Action-level vars for human/notification commands
  vars["action_id"] = action.id;
  const taskTag = action.tags.find((t) => t.startsWith("task:"));
  vars["task_id"] = taskTag ? taskTag.slice(5) : "";
  vars["summary"] = "";
  vars["condition"] = "";
  // Predecessor vars
  for (const pred of predecessorOutputs) {
    vars[`${pred.actionId}.summary`] = pred.output.summary ?? "";
    vars[`${pred.actionId}.status`] = pred.output.status ?? "";
    // Use last predecessor's summary/condition as default
    vars["summary"] = pred.output.summary ?? "";
    vars["condition"] = pred.output.status ?? "";
  }
  const interpolated = applyVars(command, vars);

  const start = Date.now();
  let stdout = "";
  let stderr = "";
  let exitCode: number;
  let timedOut = false;

  try {
    // Wrap command in nix shell if project has nix config
    const baseCmd = ["sh", "-c", interpolated];
    const cmd = options.nix
      ? buildNixCommand(resolve(options.projectDir), options.nix, baseCmd)
      : baseCmd;

    const proc = Bun.spawn(cmd, {
      cwd: resolve(options.projectDir),
      stdout: "pipe",
      stderr: "pipe",
    });

    const timeoutId = setTimeout(() => {
      timedOut = true;
      proc.kill();
    }, timeout);

    const [outBuf, errBuf] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);
    stdout = outBuf;
    stderr = errBuf;

    await proc.exited;
    exitCode = proc.exitCode ?? 1;
    clearTimeout(timeoutId);
  } catch (e) {
    exitCode = 1;
    stderr = String(e);
  }

  const duration_ms = Date.now() - start;

  // If wait_for is set, poll until health check passes
  if (waitFor && !timedOut && exitCode === 0) {
    const pollStart = Date.now();
    let healthy = false;
    while (Date.now() - pollStart < waitTimeout) {
      try {
        const waitCmd = ["sh", "-c", waitFor];
        const wrappedWait = options.nix
          ? buildNixCommand(resolve(options.projectDir), options.nix, waitCmd)
          : waitCmd;
        const check = Bun.spawnSync(wrappedWait, {
          cwd: resolve(options.projectDir),
        });
        if (check.exitCode === 0) {
          healthy = true;
          break;
        }
      } catch {}
      await new Promise((r) => setTimeout(r, 5000));
    }
    if (!healthy) {
      timedOut = true;
    }
  }

  // Build output
  const output: ActionOutput = {
    status: timedOut ? "timeout" : exitCode === 0 ? "passed" : "failed",
    summary: timedOut
      ? "Command timed out"
      : exitCode === 0
        ? stdout.trim().slice(0, 500) || "Command succeeded"
        : stderr.trim().slice(0, 500) || `Exit code ${exitCode}`,
    stdout: stdout.slice(0, 2000),
    stderr: stderr.slice(0, 2000),
    exit_code: exitCode,
  };

  // Return WaitingResult if wait_for_response
  if (waitForResponse) {
    return { waiting: true, output };
  }

  // Classify
  let condition: EdgeCondition;
  if (timedOut) {
    condition = "timeout";
  } else if (exitCode === 0) {
    condition = "pass";
  } else {
    condition = "fail";
  }

  return { condition, output, cost_usd: 0, duration_ms, num_turns: 0 };
}

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

export async function runAction(
  action: ActionConfig,
  predecessorOutputs: PredecessorOutput[],
  options: RunOptions,
): Promise<ActionResult | WaitingResult> {
  if (action.type === "agent") {
    return runAgentAction(action, predecessorOutputs, options);
  } else if (action.type === "command") {
    return runCommandAction(action, predecessorOutputs, options);
  } else {
    throw new Error(`Unknown action type: ${action.type}`);
  }
}
