/**
 * Supervisor logic — builds prompts for supervisor agents and handles their
 * graph-editing output.
 */

import { Database } from "bun:sqlite";
import type { ActionConfig, ActionOutput, EdgeCondition, GraphDelta } from "./schema";
import { serializeGraphForPrompt, applyDeltas } from "./graph-ops";
import { OrcaDatabase } from "./db";

// ---------------------------------------------------------------------------
// Prompt construction
// ---------------------------------------------------------------------------

export function buildSupervisorPrompt(
  db: Database,
  triggerAction: ActionConfig,
  triggerCondition: EdgeCondition,
  taskTag: string,
): string {
  const sections: string[] = [];

  // Section 1: What failed
  sections.push("# Failure context");
  sections.push(`Action "${triggerAction.id}" completed with condition: ${triggerCondition}`);
  if (triggerAction.output) {
    sections.push(`Status: ${triggerAction.output.status}`);
    if (triggerAction.output.summary) {
      sections.push(`Summary: ${triggerAction.output.summary}`);
    }
    if (triggerAction.output.notes) {
      sections.push(`Notes: ${triggerAction.output.notes}`);
    }
  }

  // Section 2: Graph state
  sections.push("");
  sections.push("# Current graph state");
  sections.push(serializeGraphForPrompt(db, taskTag));

  // Section 3: Task history — iteration counts and costs
  sections.push("");
  sections.push("# Task history");
  const actions = db
    .query(
      `SELECT id, type, status, cost_usd, iteration FROM actions
       WHERE EXISTS (SELECT 1 FROM json_each(tags) WHERE json_each.value = ?)
       ORDER BY created_at`,
    )
    .all(taskTag) as Array<{
    id: string;
    type: string;
    status: string;
    cost_usd: number;
    iteration: number;
  }>;

  let totalCost = 0;
  for (const a of actions) {
    sections.push(`  ${a.id}: iteration=${a.iteration}, cost=$${a.cost_usd.toFixed(2)}, status=${a.status}`);
    totalCost += a.cost_usd;
  }
  sections.push(`  Total cost: $${totalCost.toFixed(2)}`);

  // Section 4: Available mutations
  sections.push("");
  sections.push("# Available graph mutations");
  sections.push("You can produce edits of the following types:");
  sections.push("");
  sections.push('- add_action: Add a new action node. Example: {"type": "add_action", "action_id": "my_task.fix", "params": {"type": "agent", "prompt": "Fix the issue"}}');
  sections.push('- remove_action: Remove an action node. Example: {"type": "remove_action", "action_id": "my_task.old_step"}');
  sections.push('- update_params: Update an action\'s params. Example: {"type": "update_params", "action_id": "my_task.develop", "params": {"max_turns": 50}}');
  sections.push('- add_edge: Add an edge between actions. Example: {"type": "add_edge", "edge": {"from_action": "a", "to_action": "b", "condition": "pass"}}');
  sections.push('- remove_edge: Remove an edge by ID. Example: {"type": "remove_edge", "action_id": "", "edge": {"id": 5}}');

  // Section 5: Instructions
  sections.push("");
  sections.push("# Instructions");
  sections.push("1. Diagnose why the action failed based on the output and graph state.");
  sections.push("2. Produce a list of graph edits to fix the problem (or empty if no edits needed).");
  sections.push("3. Optionally set retry_action to the ID of an action that should be re-run.");
  sections.push("4. Respond with structured JSON matching the supervisor schema.");

  return sections.join("\n");
}

// ---------------------------------------------------------------------------
// Result handling
// ---------------------------------------------------------------------------

export interface SupervisorOutput {
  diagnosis: string;
  edits: Array<{
    type: string;
    action_id?: string;
    params?: Record<string, unknown>;
    edge?: Record<string, unknown>;
  }>;
  retry_action?: string | null;
}

export function parseSupervisorOutput(output: ActionOutput): SupervisorOutput | null {
  // The output may have the supervisor fields directly, or nested
  const candidate = output as Record<string, unknown>;

  if (typeof candidate.diagnosis !== "string") {
    return null;
  }

  if (!Array.isArray(candidate.edits)) {
    return null;
  }

  return {
    diagnosis: candidate.diagnosis as string,
    edits: candidate.edits as SupervisorOutput["edits"],
    retry_action: (candidate.retry_action as string | null) ?? null,
  };
}

function supervisorEditToGraphDelta(edit: SupervisorOutput["edits"][number]): GraphDelta | null {
  switch (edit.type) {
    case "add_action":
      if (!edit.action_id) return null;
      return {
        type: "add_action",
        action_id: edit.action_id,
        action: {
          type: (edit.params?.type as "agent" | "command") ?? "agent",
          ...(edit.params ?? {}),
        } as Partial<ActionConfig>,
      };

    case "remove_action":
      if (!edit.action_id) return null;
      return { type: "remove_action", action_id: edit.action_id };

    case "update_params":
      if (!edit.action_id || !edit.params) return null;
      return {
        type: "update_params",
        action_id: edit.action_id,
        params: edit.params,
      };

    case "add_edge":
      if (!edit.edge) return null;
      return {
        type: "add_edge",
        edge: {
          from_action: edit.edge.from_action as string,
          to_action: edit.edge.to_action as string,
          condition: edit.edge.condition as EdgeCondition,
        },
      };

    case "remove_edge":
      if (!edit.edge || edit.edge.id === undefined) return null;
      return { type: "remove_edge", edge_id: edit.edge.id as number };

    default:
      return null;
  }
}

export function handleSupervisorResult(db: OrcaDatabase, output: ActionOutput): void {
  const parsed = parseSupervisorOutput(output);
  if (!parsed) return;

  // Convert edits to graph deltas, skipping invalid ones
  const deltas: GraphDelta[] = [];
  for (const edit of parsed.edits) {
    const delta = supervisorEditToGraphDelta(edit);
    if (delta) {
      deltas.push(delta);
    }
  }

  // Apply deltas using the raw db handle
  if (deltas.length > 0) {
    const rawDb = db.rawDb;
    try {
      applyDeltas(rawDb, deltas);
    } catch {
      // Invalid deltas should not crash the executor
    }
  }

  // Handle retry_action
  if (parsed.retry_action) {
    const target = db.getAction(parsed.retry_action);
    if (target) {
      db.updateAction(parsed.retry_action, { status: "pending" });
    }
  }
}
