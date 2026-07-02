/**
 * L3 primary agent — converse → reify a looping circuit (loopcraft).
 *
 * The L3 agent is Orca's conversational front door. Unlike an L0 action agent
 * (whose tools read/write files), the L3 agent's tools ARE graph mutations:
 * talking to it reifies work into the durable action/edge circuit
 * ([[principle-unify-primary-and-supervisor]]). Every mutation is routed through
 * the P4 governed chokepoint (`applyValidatedDelta`), so the agent CANNOT commit
 * an invalid or unbounded circuit — the same design-rule check the L2 supervisor
 * obeys.
 *
 * It runs on the Orca-owned Layer B loop (`engine/agent-loop.ts`) with the
 * built-in file/bash registry excluded and a single injected `apply_graph_edits`
 * tool. A batch tool (rather than one-delta-at-a-time) is deliberate: an
 * incremental build passes through intermediate states (an action with no
 * outgoing edge yet) that the DRC would reject; applying a coherent batch
 * atomically lets the agent stand up a whole build→test→route-back loop in one
 * validated step.
 */

import { OrcaDatabase } from "./db";
import type {
  ActionStatus,
  ActionType,
  EdgeCondition,
  GraphDelta,
} from "./schema";
import { applyValidatedDelta, type ApplyValidatedOptions } from "./graph-ops";
import type { CustomTool } from "../engine/agent-loop";
import { runAgentLoop, type AgentLoopOptions } from "../engine/agent-loop";
import type { Toolset } from "../config/schema";
import type { ToolSchema } from "../models/types";
import type { ModelRegistry } from "../models/registry";
import { readdirSync, readFileSync, existsSync, statSync } from "fs";
import { join, relative } from "path";

// ---------------------------------------------------------------------------
// Edit vocabulary (the `apply_graph_edits` tool input)
// ---------------------------------------------------------------------------

const EDGE_CONDITIONS: EdgeCondition[] = [
  "pass",
  "fail",
  "max_turns",
  "timeout",
  "cost_exceeded",
  "stuck",
  "error",
];

export interface GraphEdit {
  op: "add_action" | "add_edge" | "update_action" | "remove_action" | "remove_edge";
  // add_action
  id?: string;
  type?: ActionType;
  prompt?: string;
  command?: string;
  max_iterations?: number;
  /** Exactly one action in a fresh circuit must be `initial` — the entry point
   * the executor schedules first. Everything else stays dormant until an edge
   * activates it. */
  initial?: boolean;
  params?: Record<string, unknown>;
  // add_edge
  from?: string;
  to?: string;
  condition?: EdgeCondition;
  // remove_edge
  edge_id?: number;
}

export interface GraphEditToolOptions extends ApplyValidatedOptions {
  /** Project the created actions belong to (also drives task tagging). */
  projectId?: string;
  /** Tag stamped on every created action (e.g. `task:build`). */
  taskTag?: string;
  /** Extra tags stamped on every created action. */
  tags?: string[];
  /**
   * Provenance stamped on any prompt this batch authors/rewrites (who wrote
   * it): recorded both as `params.prompt_source` on the action and as a
   * `prompt_authored` history event, so a human/supervisor can see and correct
   * how a task's computed context came to be. */
  source?: string;
}

/**
 * The prompt text an edit authors/rewrites, if any. Prompts arrive either via
 * the top-level `prompt` field or nested under `params.prompt`.
 */
function editAuthoredPrompt(edit: GraphEdit): string | undefined {
  if (edit.op === "add_action" || edit.op === "update_action") {
    if (typeof edit.prompt === "string") return edit.prompt;
    const nested = (edit.params as Record<string, unknown> | undefined)?.prompt;
    if (typeof nested === "string") return nested;
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Edit → GraphDelta translation
// ---------------------------------------------------------------------------

function editToDelta(edit: GraphEdit, opts: GraphEditToolOptions): GraphDelta {
  switch (edit.op) {
    case "add_action": {
      if (!edit.id) throw new Error("add_action requires 'id'");
      const type: ActionType = edit.type ?? "agent";
      const params: Record<string, unknown> = { ...(edit.params ?? {}) };
      if (edit.prompt !== undefined) params.prompt = edit.prompt;
      if (edit.command !== undefined) params.command = edit.command;
      if (edit.max_iterations !== undefined) params.max_iterations = edit.max_iterations;
      // Provenance: stamp who authored the prompt (context legibility rail).
      if (opts.source && params.prompt !== undefined) params.prompt_source = opts.source;

      const tags: string[] = [];
      if (opts.projectId) tags.push(`project:${opts.projectId}`);
      if (opts.taskTag) tags.push(opts.taskTag);
      if (opts.tags) tags.push(...opts.tags);

      const status: ActionStatus = edit.initial ? "pending" : "inactive";
      return {
        type: "add_action",
        action_id: edit.id,
        action: { type, status, params, tags, project_id: opts.projectId ?? null },
      };
    }
    case "remove_action":
      if (!edit.id) throw new Error("remove_action requires 'id'");
      return { type: "remove_action", action_id: edit.id };
    case "update_action": {
      if (!edit.id) throw new Error("update_action requires 'id'");
      const params: Record<string, unknown> = { ...(edit.params ?? {}) };
      if (edit.prompt !== undefined) params.prompt = edit.prompt;
      // Provenance: a prompt rewrite records who rewrote it.
      if (opts.source && params.prompt !== undefined) params.prompt_source = opts.source;
      return { type: "update_params", action_id: edit.id, params };
    }
    case "add_edge":
      if (!edit.from || !edit.to || !edit.condition) {
        throw new Error("add_edge requires 'from', 'to', and 'condition'");
      }
      if (!EDGE_CONDITIONS.includes(edit.condition)) {
        throw new Error(
          `invalid condition '${edit.condition}' (allowed: ${EDGE_CONDITIONS.join(", ")})`,
        );
      }
      return {
        type: "add_edge",
        edge: { from_action: edit.from, to_action: edit.to, condition: edit.condition },
      };
    case "remove_edge":
      if (edit.edge_id === undefined) throw new Error("remove_edge requires 'edge_id'");
      return { type: "remove_edge", edge_id: edit.edge_id };
    default:
      throw new Error(`unknown edit op '${(edit as GraphEdit).op}'`);
  }
}

// ---------------------------------------------------------------------------
// The graph-mutation tool
// ---------------------------------------------------------------------------

const APPLY_EDITS_SCHEMA: ToolSchema = {
  name: "apply_graph_edits",
  description:
    "Apply a batch of edits to the durable action/edge circuit, atomically and " +
    "validated. Use this to reify work into the graph. The whole batch is " +
    "design-rule-checked and committed together, or rejected together (leaving " +
    "the graph untouched) — so add nodes AND the edges that connect them in the " +
    "same call. On rejection you get the validation issues back; fix them and retry.",
  inputSchema: {
    type: "object",
    properties: {
      edits: {
        type: "array",
        description: "Ordered list of graph edits to apply atomically.",
        items: {
          type: "object",
          properties: {
            op: {
              type: "string",
              enum: ["add_action", "add_edge", "update_action", "remove_action", "remove_edge"],
            },
            id: { type: "string", description: "Action id (add/update/remove_action)." },
            type: { type: "string", enum: ["agent", "command"], description: "Action type." },
            prompt: { type: "string", description: "Agent prompt (agent actions)." },
            command: { type: "string", description: "Shell command (command actions)." },
            max_iterations: { type: "number", description: "Loop cap for this node (default 10)." },
            initial: { type: "boolean", description: "Mark the single entry action the executor schedules first." },
            params: { type: "object", description: "Additional action params / update_action patch." },
            from: { type: "string", description: "add_edge source action id." },
            to: { type: "string", description: "add_edge target action id." },
            condition: { type: "string", enum: EDGE_CONDITIONS, description: "add_edge condition." },
            edge_id: { type: "number", description: "remove_edge target edge id." },
          },
          required: ["op"],
        },
      },
    },
    required: ["edits"],
  },
};

/** Default per-action prompt size cap the L3 planner is governed by. */
export const MAX_PROMPT_CHARS = 50_000;

export interface GraphEditRecord {
  ok: boolean;
  edits: GraphEdit[];
  issues: string[];
  error?: string;
}

/**
 * Build the `apply_graph_edits` custom tool bound to a database. `onApply` is
 * fired after every batch (accepted or rejected) so a caller (the server) can
 * surface a circuit-edit card and kick the executor.
 */
export function createGraphEditTool(
  db: OrcaDatabase,
  opts: GraphEditToolOptions = {},
  onApply?: (record: GraphEditRecord) => void,
): CustomTool {
  return {
    schema: APPLY_EDITS_SCHEMA,
    execute: (input) => {
      const rawEdits = input.edits;
      if (!Array.isArray(rawEdits) || rawEdits.length === 0) {
        return { output: "No edits provided. Supply a non-empty 'edits' array.", isError: true };
      }
      const edits = rawEdits as GraphEdit[];

      let deltas: GraphDelta[];
      try {
        deltas = edits.map((e) => editToDelta(e, opts));
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        onApply?.({ ok: false, edits, issues: [], error: message });
        return { output: `Malformed edit: ${message}`, isError: true };
      }

      const result = applyValidatedDelta(db.rawDb, deltas, opts);
      const record: GraphEditRecord = {
        ok: result.ok,
        edits,
        issues: result.issues,
        error: result.error,
      };
      onApply?.(record);

      if (result.ok) {
        // Provenance: record a legible history event for every prompt this
        // batch authored/rewrote (who, which op, how large). Best-effort.
        for (const edit of edits) {
          const authored = editAuthoredPrompt(edit);
          if (authored !== undefined && edit.id) {
            try {
              db.appendHistory(edit.id, "prompt_authored", {
                source: opts.source ?? null,
                op: edit.op,
                chars: authored.length,
              });
            } catch { /* never let logging mask a successful apply */ }
          }
        }
        return { output: `Applied ${deltas.length} edit(s) to the circuit.` };
      }
      if (result.kind === "validation") {
        return {
          output:
            `Rejected: the batch would corrupt the circuit. Issues:\n- ` +
            result.issues.join("\n- ") +
            `\nRevise the edits (loops need a back-edge AND an escape condition) and retry.`,
          isError: true,
        };
      }
      return { output: `Rejected (execution error): ${result.error}`, isError: true };
    },
  };
}

// ---------------------------------------------------------------------------
// The ground-plane write tool (the shared context channel)
// ---------------------------------------------------------------------------

const SET_GROUND_PLANE_SCHEMA: ToolSchema = {
  name: "set_ground_plane",
  description:
    "Write a durable, SHARED fact to the ground plane — the curated global " +
    "context every task in this project references at run time (spec, settled " +
    "decisions, conventions, the test command). Use this for facts MANY tasks " +
    "need, so per-task prompts stay specific and you avoid copying a shared fact " +
    "into every prompt (and O(N) rewrites when it changes). Keyed by `key`; " +
    "writing an existing key overwrites it.",
  inputSchema: {
    type: "object",
    properties: {
      key: {
        type: "string",
        description: "Stable identifier for this fact (e.g. 'spec', 'test-command', 'api-conventions').",
      },
      value: { type: "string", description: "The fact/content to store." },
    },
    required: ["key", "value"],
  },
};

/** Largest ground-plane value the planner may write (legibility cap). */
export const MAX_GROUND_PLANE_VALUE_CHARS = 20_000;

export interface GroundPlaneToolOptions {
  projectId?: string;
  /** Provenance stamped on writes (who authored the entry). */
  source?: string;
}

/**
 * Build the `set_ground_plane` custom tool bound to a database. This is an ACT
 * tool (a mutation of shared context) — distinct from read-only recon.
 */
export function createGroundPlaneTool(
  db: OrcaDatabase,
  opts: GroundPlaneToolOptions = {},
): CustomTool {
  return {
    schema: SET_GROUND_PLANE_SCHEMA,
    execute: (input) => {
      const key = typeof input.key === "string" ? input.key.trim() : "";
      const value = input.value;
      if (!key) {
        return { output: "set_ground_plane requires a non-empty 'key'.", isError: true };
      }
      if (typeof value !== "string") {
        return { output: "set_ground_plane requires a string 'value'.", isError: true };
      }
      if (value.length > MAX_GROUND_PLANE_VALUE_CHARS) {
        return {
          output:
            `Rejected: ground-plane value for '${key}' is ${value.length} chars, ` +
            `over the ${MAX_GROUND_PLANE_VALUE_CHARS}-char cap. Keep shared context ` +
            `concise, or split it across keys.`,
          isError: true,
        };
      }
      db.setGroundPlane(key, value, { projectId: opts.projectId, source: opts.source ?? "l3" });
      return { output: `Ground plane updated: '${key}' (${value.length} chars).` };
    },
  };
}

// ---------------------------------------------------------------------------
// Loopcraft system prompt
// ---------------------------------------------------------------------------

export function loopcraftSystemPrompt(): string {
  return [
    "You are Orca's L3 primary agent. You do not edit files directly — you reify",
    "work into a DURABLE action/edge circuit that a separate executor runs. Talking",
    "to you builds the circuit.",
    "",
    "# Observe read-only, then act by mutation",
    "Your tools split cleanly and do NOT overlap:",
    "- OBSERVE (recon): `Read`, `Grep`, `Glob` are READ-ONLY. Use them to GROUND",
    "  your plan in the ACTUAL workspace — read a config, grep for an entry point,",
    "  glob a directory — BEFORE you author prompts. You have NO Write/Edit/Bash:",
    "  you never touch files yourself; the actions you reify do the building.",
    "- ACT: `apply_graph_edits` reifies actions and edges (and authors/updates",
    "  their prompts); `set_ground_plane` writes the SHARED context channel. Both",
    "  are mutations. Recon is seeing; mutation is doing.",
    "Recon first when a goal is non-trivial; don't recon a one-line change.",
    "",
    "# Two context channels: per-task prompt vs. the ground plane",
    "Each action's effective context has a specific `prompt` AND a shared ground",
    "plane it references at run time. Keep prompts SPECIFIC to the task. Put facts",
    "MANY tasks need — the spec, settled decisions, the test command, conventions —",
    "in the ground plane via `set_ground_plane`, so you don't copy a shared fact",
    "into every prompt (which bloats them and forces O(N) rewrites when it changes).",
    "Seed the ground plane from recon before authoring prompts.",
    "Prompts you author are provenance-tagged and size-capped for legibility: keep",
    "each prompt tight; a bloated prompt is rejected by the design-rule check.",
    "",
    "# The circuit model",
    "- An ACTION is a node: type `agent` (an LLM sub-agent given a `prompt`) or",
    "  `command` (a shell `command`, e.g. a test runner). Exit 0 / status passed →",
    "  the `pass` condition; a non-zero test / failed status → `fail`.",
    "- An EDGE routes from one action to another on a CONDITION: one of",
    `  ${EDGE_CONDITIONS.join(", ")}. When an action ends, the executor follows`,
    "  every edge whose condition matches the outcome.",
    "- Exactly ONE action must be marked `initial: true` — the entry point the",
    "  executor schedules first. All other actions stay dormant until an edge",
    "  activates them.",
    "",
    "# Loopcraft: build→test→route-back with an escape",
    "Real work iterates. Construct a feedback loop:",
    "  1. a `build` agent action (writes code) — mark it `initial`,",
    "  2. a `test` command action (runs the tests),",
    "  3. edge build --pass--> test,",
    "  4. a BACK-EDGE test --fail--> build (retry: fix and re-test),",
    "  5. an ESCAPE edge test --pass--> <done> that LEAVES the loop, and",
    "  6. a STUCK escape edge test --stuck--> <done, or a supervisor> so a",
    "     non-improving loop bails to escalation instead of burning every retry.",
    "     The executor routes `stuck` after 3 byte-identical failures — but ONLY",
    "     if you wire this edge; without it a wedged gate thrashes to max_iterations.",
    "The back-edge makes it a loop; the pass-escape makes it terminate. A loop with a",
    "back-edge but NO pass-escape is an unbounded cycle and WILL be rejected. Always",
    "cap the loop: set `max_iterations` on the build action (e.g. 5).",
    "",
    "# Decompose a large goal into grounded build→test stages",
    "Do NOT collapse a big goal into one giant build action. Recon the workspace,",
    "then break the work into SEVERAL sequential build→test stages, each a small",
    "loop that must go green before the next begins:",
    "  stage1.build ⇄ stage1.test  --pass-->  stage2.build ⇄ stage2.test  --pass--> …",
    "Wire each stage's test --pass--> the next stage's build (the escape from one",
    "loop is the entry to the next), and give each build a prompt grounded in what",
    "recon actually found. Small verified stages beat one unverifiable megastep.",
    "Prefer MANY SMALL stages over a few big ones: each build stage targets ONE",
    "coherent feature group (a handful of related endpoints) that a single agent can",
    "finish in ~40 turns. NEVER put the whole app, or 'the entire core', in one stage —",
    "that is the #1 cause of a stage running out of budget. Set a generous",
    "`wall_timeout` (e.g. 1800) in each build action's params, but do NOT set",
    "`max_turns` — the harness gives a generous default; sizing it yourself starves the",
    "stage. A build stage WRITES its code; the paired test node VERIFIES it at runtime.",
    "Author each test node as a deterministic SMOKE-TEST command that boots the server",
    "with its output REDIRECTED (so the shell can't hang on it), probes the real",
    "endpoints, then kills it by captured PID — e.g.:",
    "  `PORT=37xx bun run src/server.ts >/tmp/s.log 2>&1 & S=$!; sleep 2;`",
    "  `curl -fsS localhost:37xx/health && curl -fsS -X POST localhost:37xx/<route> -d ...;`",
    "  `R=$?; kill $S 2>/dev/null; exit $R`",
    "This checks REAL behavior, needs no unit tests, and won't hang. Do NOT use a bare",
    "`bun test` (it FAILS with 'no tests found' when the stage wrote none, thrashing the",
    "loop). Build agents must never boot servers to smoke-test in-band — it is the test",
    "node's job.",
    "",
    "# Applying edits",
    "Add the nodes AND their edges in a SINGLE `apply_graph_edits` call — the batch",
    "is validated and committed atomically, so intermediate half-built states never",
    "trip the design-rule check. If a batch is rejected, read the issues and retry.",
    "",
    "# Ground every concrete value in the real workspace",
    "A WORKSPACE CONTEXT section below lists the project's ACTUAL files, its",
    "package.json scripts, and the working directory. Use it: reference REAL files",
    "from the tree (do not invent `src/index.ts` if the entry is `src/server.ts`),",
    "wire command actions to the project's real test/build commands, and remember",
    "command actions run IN the working directory — never `cd` elsewhere or invent",
    "a path. If a detail you need is not shown, use recon (`Read`/`Grep`/`Glob`) to",
    "discover it now, or have a build agent discover it at run time.",
    "",
    "When the circuit is built, call StructuredOutput with status 'passed' and a",
    "one-line summary of the loop you reified.",
  ].join("\n");
}

// ---------------------------------------------------------------------------
// Workspace grounding — inject the project's real files + conventions so the
// planner wires concrete values (paths, commands) from reality, not guesses.
// ---------------------------------------------------------------------------

function workspaceGrounding(
  cwd: string,
  db: OrcaDatabase,
  projectId?: string,
): string {
  const parts: string[] = [
    "# WORKSPACE CONTEXT",
    `Working directory: ${cwd}`,
    "Command actions execute IN this directory — reference the real files below; do not invent paths or `cd` elsewhere.",
  ];

  const IGNORE = new Set([
    "node_modules", ".git", ".orca", "dist", ".cache", "logs",
  ]);
  const files: string[] = [];
  const walk = (dir: string, depth: number): void => {
    if (depth > 3 || files.length >= 120) return;
    let names: string[];
    try { names = readdirSync(dir).sort(); } catch { return; }
    for (const name of names) {
      if (IGNORE.has(name)) continue;
      if (name.startsWith(".") && name !== ".gitignore") continue;
      const full = join(dir, name);
      let st;
      try { st = statSync(full); } catch { continue; }
      const rel = relative(cwd, full);
      if (st.isDirectory()) { files.push(rel + "/"); walk(full, depth + 1); }
      else files.push(rel);
      if (files.length >= 120) return;
    }
  };
  walk(cwd, 0);
  parts.push(
    "Files:\n" +
      (files.length ? files.map((f) => "  " + f).join("\n") : "  (empty)"),
  );

  try {
    const pkgPath = join(cwd, "package.json");
    if (existsSync(pkgPath)) {
      const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as Record<string, unknown>;
      const scripts = pkg.scripts as Record<string, string> | undefined;
      if (scripts && Object.keys(scripts).length) {
        parts.push("package.json scripts: " + JSON.stringify(scripts));
      }
      const entry = (pkg.module as string) || (pkg.main as string);
      if (entry) parts.push("package.json entry: " + entry);
    }
  } catch { /* no/invalid package.json */ }

  try {
    const actions = db
      .listActions()
      .filter((a) => !projectId || a.project_id === projectId);
    if (actions.length) {
      parts.push(
        "Existing circuit actions (extend/modify these; do not duplicate):\n" +
          actions
            .slice(0, 25)
            .map((a) => `  ${a.id} [${a.type}] ${a.status}`)
            .join("\n"),
      );
    }
  } catch { /* no db access */ }

  return parts.join("\n\n");
}

// ---------------------------------------------------------------------------
// L3 turn runner
// ---------------------------------------------------------------------------

export interface L3TurnOptions {
  db: OrcaDatabase;
  message: string;
  cwd: string;
  model?: string;
  projectId?: string;
  taskTag?: string;
  tags?: string[];
  maxTurns?: number;
  maxActions?: number;
  maxEdges?: number;
  /**
   * Context-size governance: the largest `params.prompt` (chars) a planner may
   * author/rewrite for any action. A batch introducing an over-cap prompt is
   * rejected by the DRC. Defaults to `MAX_PROMPT_CHARS`.
   */
  maxPromptChars?: number;
  /**
   * Read-only recon toolset the planner may use ALONGSIDE `apply_graph_edits`
   * to observe the workspace before/while planning. Defaults to `read_only`
   * (Read/Grep/Glob) — no Write/Edit/Bash, so acting stays mutation-only.
   */
  reconToolset?: Toolset;
  apiKey?: string;
  apiUrl?: string;
  registry?: ModelRegistry;
  logPath?: string;
  label?: string;
  abortController?: AbortController;
  /** Streamed narration text from the agent (braid). */
  onText?: (text: string) => void;
  /** Fired for every graph-edit batch (accepted or rejected). */
  onGraphEdit?: (record: GraphEditRecord) => void;
}

export interface L3TurnResult {
  output: Record<string, unknown> | null;
  costUsd: number;
  numTurns: number;
  isError: boolean;
  edits: GraphEditRecord[];
}

/**
 * Run one L3 conversational turn. The user message drives the Layer B loop; the
 * agent narrates (text) and mutates the circuit (apply_graph_edits) in the same
 * turn. Every applied batch and every narration line is surfaced via callbacks
 * so the server can broadcast them as SSE braid events.
 */
export async function runL3Turn(options: L3TurnOptions): Promise<L3TurnResult> {
  const editRecords: GraphEditRecord[] = [];

  const tool = createGraphEditTool(
    options.db,
    {
      projectId: options.projectId,
      taskTag: options.taskTag,
      tags: options.tags,
      maxActions: options.maxActions,
      maxEdges: options.maxEdges,
      maxPromptChars: options.maxPromptChars ?? MAX_PROMPT_CHARS,
      source: options.label ?? "l3",
    },
    (record) => {
      editRecords.push(record);
      options.onGraphEdit?.(record);
    },
  );

  const groundPlaneTool = createGroundPlaneTool(options.db, {
    projectId: options.projectId,
    source: options.label ?? "l3",
  });

  const grounding = workspaceGrounding(options.cwd, options.db, options.projectId);

  const loopOptions: AgentLoopOptions = {
    prompt: options.message,
    systemPrompt: loopcraftSystemPrompt() + "\n\n" + grounding,
    model: options.model,
    cwd: options.cwd,
    maxTurns: options.maxTurns ?? 12,
    // Give the planner READ-ONLY recon (Read/Grep/Glob) alongside the graph
    // mutation tool: it can OBSERVE the workspace to ground its plan, but it
    // still ACTS only by mutation — no Write/Edit/Bash in this toolset.
    toolset: options.reconToolset ?? "read_only",
    customTools: [tool, groundPlaneTool],
    registry: options.registry,
    apiKey: options.apiKey,
    apiUrl: options.apiUrl,
    logPath: options.logPath,
    label: options.label ?? "l3",
    abortController: options.abortController,
  };

  const result = await runAgentLoop(loopOptions, (event) => {
    if (event.type === "text" && event.text) options.onText?.(event.text);
  });

  return {
    output: result.output,
    costUsd: result.costUsd,
    numTurns: result.numTurns,
    isError: result.isError,
    edits: editRecords,
  };
}
