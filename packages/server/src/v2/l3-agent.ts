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
import type { ToolSchema } from "../models/types";
import type { ModelRegistry } from "../models/registry";

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
    case "update_action":
      if (!edit.id) throw new Error("update_action requires 'id'");
      return { type: "update_params", action_id: edit.id, params: edit.params ?? {} };
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
// Loopcraft system prompt
// ---------------------------------------------------------------------------

export function loopcraftSystemPrompt(): string {
  return [
    "You are Orca's L3 primary agent. You do not edit files directly — your only",
    "tool is `apply_graph_edits`, which reifies work into a DURABLE action/edge",
    "circuit that a separate executor runs. Talking to you builds the circuit.",
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
    "  4. a BACK-EDGE test --fail--> build (retry: fix and re-test), and",
    "  5. an ESCAPE edge test --pass--> <done> that LEAVES the loop.",
    "The back-edge makes it a loop; the escape makes it terminate. A loop with a",
    "back-edge but NO escape is an unbounded cycle and WILL be rejected. Always",
    "cap the loop: set `max_iterations` on the build action (e.g. 5).",
    "",
    "# Applying edits",
    "Add the nodes AND their edges in a SINGLE `apply_graph_edits` call — the batch",
    "is validated and committed atomically, so intermediate half-built states never",
    "trip the design-rule check. If a batch is rejected, read the issues and retry.",
    "",
    "When the circuit is built, call StructuredOutput with status 'passed' and a",
    "one-line summary of the loop you reified.",
  ].join("\n");
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
    },
    (record) => {
      editRecords.push(record);
      options.onGraphEdit?.(record);
    },
  );

  const loopOptions: AgentLoopOptions = {
    prompt: options.message,
    systemPrompt: loopcraftSystemPrompt(),
    model: options.model,
    cwd: options.cwd,
    maxTurns: options.maxTurns ?? 12,
    includeBuiltinTools: false,
    customTools: [tool],
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
