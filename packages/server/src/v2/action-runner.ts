/**
 * Action runner — executes a single action and returns a classified result.
 */

import { resolve, dirname } from "path";
import { existsSync, mkdirSync, appendFileSync } from "fs";
import { applyVars } from "../templates";
import { buildNixCommand, buildNixScriptCommand } from "../nix";
import { invokeSimple } from "../engine/invoke";
import type { ScopeConfig, Toolset } from "../config/schema";
import type { ActionConfig, ActionOutput, EdgeCondition, GroundPlaneEntry, NixConfig } from "./schema";

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
  /**
   * The effective ground plane for this action — the shared, referenced context
   * channel. Injected (as a section) into an agent action's prompt at run time
   * so per-task prompts stay specific while global facts live in one place.
   */
  groundPlane?: GroundPlaneEntry[];
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

export function buildGroundPlanePrompt(entries: GroundPlaneEntry[]): string {
  if (!entries || entries.length === 0) return "";

  const sections = entries.map((e) => `### ${e.key}\n${e.value}`);
  return (
    "## Ground plane (shared project context)\n" +
    "Durable, shared facts curated for every task in this project. Reference " +
    "them; do not restate them.\n\n" +
    sections.join("\n\n")
  );
}

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
// Agent action (Orca-owned Layer B loop — no claude binary, model-agnostic)
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
  const toolset = params.toolset as Toolset | undefined;
  const outputSchema = (params.output_schema as object | undefined) ?? DEFAULT_OUTPUT_SCHEMA;

  // Assemble the effective context from the three graph-native channels:
  //   1. shared — the ground plane (global facts, referenced not copied),
  //   2. edge-carried — predecessor outputs, and
  //   3. authored — this action's own prompt.
  const parts: string[] = [];
  const groundPlanePrompt = buildGroundPlanePrompt(options.groundPlane ?? []);
  if (groundPlanePrompt) {
    parts.push(groundPlanePrompt);
  }
  const predecessorPrompt = buildPredecessorPrompt(predecessorOutputs);
  if (predecessorPrompt) {
    parts.push(predecessorPrompt);
  }
  parts.push(prompt);
  const fullPrompt = parts.join("\n\n");

  // Open nix env session — keeps TMPDIR alive for the duration of the agent
  const nixSession = openNixEnvSession(options.projectDir, options.nix);

  try {
    // Drive the Orca-owned Layer B loop through the stable invoke seam. The
    // model id selects the provider (Anthropic, OpenAI, …) — no claude binary.
    const result = await invokeSimple({
      prompt: fullPrompt,
      projectDir: resolve(options.projectDir),
      model: options.model,
      toolset,
      maxTurns,
      outputSchema,
      scope: options.scope,
      systemPrompt,
      label: action.id,
      logPath: options.logPath,
      abortController: options.abortController,
      env: nixSession?.env,
    }, options.onToolUse);

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
  if (action.type === "agent" || action.type === "agent-api") {
    return runAgentApiAction(action, predecessorOutputs, options);
  } else if (action.type === "command") {
    return runCommandAction(action, predecessorOutputs, options);
  } else {
    throw new Error(`Unknown action type: ${action.type}`);
  }
}
