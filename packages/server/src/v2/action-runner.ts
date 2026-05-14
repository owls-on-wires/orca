/**
 * Action runner — executes a single action and returns a classified result.
 */

import { resolve, dirname } from "path";
import { readFileSync, existsSync, mkdirSync, appendFileSync } from "fs";
import { invokeSimple } from "../engine/invoke";
import type { InvokeResult, InvokeOptions } from "../engine/invoke";
import { applyVars } from "../templates";
import { buildNixCommand, buildNixScriptCommand } from "../nix";
import { runAgentLoop } from "../harness/loop";
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
// Model name resolution (short names → API model IDs)
// ---------------------------------------------------------------------------

const MODEL_ALIASES: Record<string, string> = {
  opus: "claude-opus-4-6",
  sonnet: "claude-sonnet-4-6",
  haiku: "claude-haiku-4-5-20251001",
};

function resolveModelId(model?: string): string {
  if (!model) return "claude-sonnet-4-6";
  return MODEL_ALIASES[model] ?? model;
}

// ---------------------------------------------------------------------------
// Shared condition classification from structured output
// ---------------------------------------------------------------------------

function classifyResult(
  structuredOutput: Record<string, unknown> | null,
  isError: boolean,
  numTurns: number,
  maxTurns?: number,
): { condition: EdgeCondition; output: ActionOutput } {
  let condition: EdgeCondition;
  let output: ActionOutput;

  if (isError) {
    if (maxTurns && numTurns >= maxTurns) {
      condition = "max_turns";
    } else {
      condition = "error";
    }
    output = {
      status: "failed",
      summary: "Action failed with error",
      ...(structuredOutput ?? {}),
    };
  } else {
    const status = structuredOutput?.status as string | undefined;
    if (status === "passed") {
      condition = "pass";
    } else if (status === "failed") {
      condition = "fail";
    } else {
      condition = "error";
    }
    output = {
      status: status ?? "unknown",
      summary: (structuredOutput?.summary as string) ?? "",
      ...(structuredOutput ?? {}),
    };
  }

  return { condition, output };
}

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
// Nix environment session for agent actions
// ---------------------------------------------------------------------------

export interface NixEnvSession {
  env: Record<string, string>;
  close: () => void;
}

/** Exported for testing */
export function clearNixEnvCache() { /* no-op, cache removed */ }

/**
 * Open a nix environment session for the given project directory.
 *
 * Spawns a fresh nix-shell/develop to capture env vars, then spawns a
 * keepalive process (`sleep`) in the same nix env so that TMPDIR and
 * other session-specific paths remain valid. Call close() to kill the
 * keepalive when the agent action finishes.
 *
 * Returns null if no nix environment is detected.
 */
export function openNixEnvSession(projectDir: string, nixConfig?: NixConfig): NixEnvSession | null {
  const dir = resolve(projectDir);

  if (!nixConfig || nixConfig.enable === false) {
    const hasFlake = existsSync(`${dir}/flake.nix`);
    const hasShell = existsSync(`${dir}/shell.nix`);
    const hasDefault = existsSync(`${dir}/default.nix`);
    if (!hasFlake && !hasShell && !hasDefault) return null;
  }

  try {
    // 1. Capture env vars synchronously
    const envCmd = buildNixCommand(dir, nixConfig, ["env"]);
    if (envCmd.length === 1 && envCmd[0] === "env") return null;

    const envProc = Bun.spawnSync(envCmd, { cwd: dir, stdout: "pipe", stderr: "pipe" });
    if (envProc.exitCode !== 0) return null;

    const env: Record<string, string> = {};
    const output = new TextDecoder().decode(envProc.stdout);
    for (const line of output.split("\n")) {
      const eq = line.indexOf("=");
      if (eq > 0) {
        env[line.slice(0, eq)] = line.slice(eq + 1);
      }
    }

    // 2. Spawn keepalive in the same nix env to hold TMPDIR alive
    const keepaliveCmd = buildNixCommand(dir, nixConfig, ["sleep", "86400"]);
    const keepalive = Bun.spawn(keepaliveCmd, {
      cwd: dir, stdout: "ignore", stderr: "ignore",
    });

    return {
      env,
      close: () => { try { keepalive.kill(); } catch {} },
    };
  } catch {
    return null;
  }
}

/** Convenience wrapper — opens a session, returns env, closes immediately. */
export function resolveNixEnv(projectDir: string, nixConfig?: NixConfig): Record<string, string | undefined> | undefined {
  const session = openNixEnvSession(projectDir, nixConfig);
  if (!session) return undefined;
  session.close();
  return session.env;
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

  // Open nix env session — keeps TMPDIR alive for the duration of the agent
  const nixSession = openNixEnvSession(options.projectDir, options.nix);

  try {
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
    env: nixSession?.env,
  }, options.onToolUse);

  const { condition, output } = classifyResult(
    result.output as Record<string, unknown> | null,
    result.isError,
    result.numTurns,
    maxTurns,
  );

  return { condition, output, cost_usd: result.costUsd, duration_ms: result.durationMs, num_turns: result.numTurns };
  } finally {
    nixSession?.close();
  }
}

// ---------------------------------------------------------------------------
// Agent-API action (direct Anthropic API, no SDK subprocess)
// ---------------------------------------------------------------------------

async function runAgentApiAction(
  action: ActionConfig,
  predecessorOutputs: PredecessorOutput[],
  options: RunOptions,
): Promise<ActionResult> {
  const params = action.params;
  const prompt = params.prompt as string;
  const systemPrompt = params.system_prompt as string | undefined;
  const maxTurns = params.max_turns as number | undefined;
  const outputSchema = (params.output_schema as object | undefined) ?? DEFAULT_OUTPUT_SCHEMA;

  // Build full prompt with predecessor injection
  const parts: string[] = [];
  const predecessorPrompt = buildPredecessorPrompt(predecessorOutputs);
  if (predecessorPrompt) {
    parts.push(predecessorPrompt);
  }
  parts.push(prompt);
  const fullPrompt = parts.join("\n\n");

  // Open nix env session — keeps TMPDIR alive for the duration of the agent
  const nixSession = openNixEnvSession(options.projectDir, options.nix);

  try {
    const result = await runAgentLoop({
      prompt: fullPrompt,
      systemPrompt,
      model: resolveModelId(options.model),
      maxTurns,
      outputSchema,
      cwd: resolve(options.projectDir),
      env: nixSession?.env,
      logPath: options.logPath,
      label: action.id,
      abortController: options.abortController,
      onToolUse: options.onToolUse,
      scope: options.scope,
    });

    const { condition, output } = classifyResult(
      result.output,
      result.isError,
      result.numTurns,
      maxTurns,
    );

    return { condition, output, cost_usd: result.costUsd, duration_ms: result.durationMs, num_turns: result.numTurns };
  } finally {
    nixSession?.close();
  }
}

// ---------------------------------------------------------------------------
// Simple JSONL logger for command actions
// ---------------------------------------------------------------------------

function logJsonl(logPath: string | undefined, label: string, eventType: string, data: Record<string, unknown> = {}) {
  if (!logPath) return;
  try { mkdirSync(dirname(logPath), { recursive: true }); } catch {}
  const record = { timestamp: new Date().toISOString(), label, event_type: eventType, ...data };
  appendFileSync(logPath, JSON.stringify(record) + "\n");
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

  logJsonl(options.logPath, action.id, "command_start", {
    command: interpolated,
    cwd: resolve(options.projectDir),
    timeout: timeout / 1000,
  });

  // Build nix-wrapped command via temp script (fresh nix shell per command, no stale env)
  const nixScript = buildNixScriptCommand(resolve(options.projectDir), interpolated, options.nix);
  const argv = nixScript ? nixScript.argv : ["sh", "-c", interpolated];

  const start = Date.now();
  let stdout = "";
  let stderr = "";
  let exitCode: number;
  let timedOut = false;

  try {
    const proc = Bun.spawn(argv, {
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
  } finally {
    nixScript?.cleanup();
  }

  const duration_ms = Date.now() - start;

  // If wait_for is set, poll until health check passes
  if (waitFor && !timedOut && exitCode === 0) {
    const pollStart = Date.now();
    let healthy = false;
    while (Date.now() - pollStart < waitTimeout) {
      try {
        const waitScript = buildNixScriptCommand(resolve(options.projectDir), waitFor, options.nix);
        const waitArgv = waitScript ? waitScript.argv : ["sh", "-c", waitFor];
        const check = Bun.spawnSync(waitArgv, {
          cwd: resolve(options.projectDir),
        });
        waitScript?.cleanup();
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
    status: timedOut ? "timeout" : exitCode === 0 ? "passed" : exitCode === 1 ? "failed" : "error",
    summary: timedOut
      ? "Command timed out"
      : exitCode === 0
        ? stdout.trim().slice(0, 500) || "Command succeeded"
        : stderr.trim().slice(0, 500) || `Exit code ${exitCode}`,
    stdout: stdout.slice(0, 2000),
    stderr: stderr.slice(0, 2000),
    exit_code: exitCode,
  };

  logJsonl(options.logPath, action.id, "command_end", {
    exit_code: exitCode,
    timed_out: timedOut,
    duration_ms,
    stdout: stdout.slice(0, 2000),
    stderr: stderr.slice(0, 2000),
  });

  // Return WaitingResult if wait_for_response
  if (waitForResponse) {
    return { waiting: true, output };
  }

  // Classify: exit 0 = pass, exit 1 = fail (tests failed), exit ≥2 = error (command broken)
  let condition: EdgeCondition;
  if (timedOut) {
    condition = "timeout";
  } else if (exitCode === 0) {
    condition = "pass";
  } else if (exitCode === 1) {
    condition = "fail";
  } else {
    condition = "error";
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
  } else if (action.type === "agent-api") {
    return runAgentApiAction(action, predecessorOutputs, options);
  } else if (action.type === "command") {
    return runCommandAction(action, predecessorOutputs, options);
  } else {
    throw new Error(`Unknown action type: ${action.type}`);
  }
}
