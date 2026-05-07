import yaml from "js-yaml";
import { OrcaDatabase } from "./db";
import {
  createAction,
  createEdge,
  type ActionConfig,
  type ActionTypeDefaults,
  type EdgeCondition,
  type EdgeConfig,
  type OrcaV2Config,
  type V2TaskConfig,
} from "./schema";

/**
 * Parse YAML config and expand tasks into actions + edges in the database.
 * Returns the parsed config; side effect: populates DB with actions and edges.
 */
export function expandConfig(yamlString: string, db: OrcaDatabase): OrcaV2Config {
  const config = yaml.load(yamlString) as OrcaV2Config;

  if (!config || !config.tasks || !Array.isArray(config.tasks)) {
    throw new Error("Invalid config: missing tasks array");
  }
  if (!config.name) {
    throw new Error("Invalid config: missing name");
  }

  const typeDefaults = config.defaults?.types ?? {};

  // Validate all action types exist in defaults
  for (const task of config.tasks) {
    for (const actionType of task.actions) {
      if (!typeDefaults[actionType]) {
        throw new Error(
          `Unknown action type "${actionType}" in task "${task.id}" — not defined in defaults.types`,
        );
      }
    }
  }

  // Track all actions created per task (including auto-created ones)
  const taskActions: Map<string, ActionConfig[]> = new Map();
  const allEdges: EdgeConfig[] = [];

  // Phase 1: Expand tasks into actions
  for (const task of config.tasks) {
    const actions: ActionConfig[] = [];

    for (let i = 0; i < task.actions.length; i++) {
      const actionType = task.actions[i];
      const typeDef = typeDefaults[actionType];
      const actionId = `${task.id}.${actionType}`;

      // Determine status: first action with no depends_on = pending, rest = inactive
      const isFirst = i === 0 && (!task.depends_on || task.depends_on.length === 0);
      const status = isFirst ? "pending" : "inactive";

      // Merge params: type defaults + budget
      const params: Record<string, unknown> = {
        ...(typeDef.params ?? {}),
      };

      // Inject prompt for agent actions
      if (typeDef.type === "agent" && task.prompt) {
        params.prompt = task.prompt;
      }

      // Merge budget
      if (task.budget) {
        if (task.budget.max_iterations !== undefined) {
          params.max_iterations = task.budget.max_iterations;
        }
        if (task.budget.max_cost !== undefined) {
          params.max_cost = task.budget.max_cost;
        }
      }

      // Auto-generate tags
      const tags = [
        `type:${actionType}`,
        `task:${task.id}`,
        `project:${config.name}`,
        ...(task.tags ?? []),
      ];

      const action = createAction({
        id: actionId,
        type: typeDef.type,
        status,
        params,
        tags,
      });

      actions.push(action);
    }

    taskActions.set(task.id, actions);
  }

  // Phase 2: Generate edges and auto-create actions from shorthands
  for (const task of config.tasks) {
    const actions = taskActions.get(task.id)!;

    for (let i = 0; i < task.actions.length; i++) {
      const actionType = task.actions[i];
      const typeDef = typeDefaults[actionType];
      const actionId = `${task.id}.${actionType}`;

      // Get edges map — use defaults if not specified
      let edgesMap: Partial<Record<EdgeCondition, string>>;
      if (typeDef.edges) {
        edgesMap = typeDef.edges;
      } else {
        // Default edges: pass → next, fail → first
        edgesMap = { pass: "next", fail: "first" };
      }

      // Resolve each edge
      for (const [condition, target] of Object.entries(edgesMap)) {
        const resolved = resolveTarget(
          target,
          task.id,
          task.actions,
          i,
          typeDefaults,
          taskActions,
          config,
          task,
        );

        if (resolved === null) {
          // "complete" — no edge created
          continue;
        }

        allEdges.push(createEdge(actionId, resolved, condition as EdgeCondition));
      }
    }

    // Also generate edges for auto-created actions that don't have explicit edges
    // Auto-created actions get default edges (pass: next in original list isn't applicable,
    // so they just don't get default edges unless specified in type defaults)
  }

  // Phase 3: Cross-task dependencies
  for (const task of config.tasks) {
    if (!task.depends_on || task.depends_on.length === 0) continue;

    const thisTaskActions = taskActions.get(task.id)!;
    const firstAction = thisTaskActions[0];

    for (const depTaskId of task.depends_on) {
      const depActions = taskActions.get(depTaskId);
      if (!depActions || depActions.length === 0) {
        throw new Error(
          `Task "${task.id}" depends on "${depTaskId}" which does not exist`,
        );
      }
      // Terminal action = last in the dependency task's action list
      const terminalAction = depActions[depActions.length - 1];
      allEdges.push(createEdge(terminalAction.id, firstAction.id, "pass"));
    }
  }

  // Phase 4: Insert into database
  // Insert all actions first (from all tasks)
  for (const actions of taskActions.values()) {
    for (const action of actions) {
      db.insertAction(action);
    }
  }

  // Then insert edges
  for (const edge of allEdges) {
    db.insertEdge(edge);
  }

  return config;
}

/**
 * Resolve an edge target shorthand to an actual action ID.
 * Returns null for "complete" (no edge should be created).
 */
function resolveTarget(
  target: string,
  taskId: string,
  actionTypes: string[],
  currentIndex: number,
  typeDefaults: Record<string, ActionTypeDefaults>,
  taskActions: Map<string, ActionConfig[]>,
  config: OrcaV2Config,
  task: V2TaskConfig,
): string | null {
  switch (target) {
    case "first":
      return `${taskId}.${actionTypes[0]}`;

    case "next": {
      if (currentIndex >= actionTypes.length - 1) {
        // Last action, "next" means complete (no edge)
        return null;
      }
      return `${taskId}.${actionTypes[currentIndex + 1]}`;
    }

    case "complete":
      return null;

    default: {
      // Check if target is a type name in defaults → auto-create action
      if (typeDefaults[target]) {
        const autoActionId = `${taskId}.${target}`;
        const actions = taskActions.get(taskId)!;

        // Only auto-create if it doesn't already exist
        const exists = actions.some((a) => a.id === autoActionId);
        if (!exists) {
          const typeDef = typeDefaults[target];
          const params: Record<string, unknown> = {
            ...(typeDef.params ?? {}),
          };
          if (typeDef.type === "agent" && task.prompt) {
            params.prompt = task.prompt;
          }
          if (task.budget) {
            if (task.budget.max_iterations !== undefined) {
              params.max_iterations = task.budget.max_iterations;
            }
            if (task.budget.max_cost !== undefined) {
              params.max_cost = task.budget.max_cost;
            }
          }

          const tags = [
            `type:${target}`,
            `task:${taskId}`,
            `project:${config.name}`,
            ...(task.tags ?? []),
          ];

          const action = createAction({
            id: autoActionId,
            type: typeDef.type,
            status: "inactive",
            params,
            tags,
          });
          actions.push(action);
        }

        return autoActionId;
      }

      // Literal action ID
      return target;
    }
  }
}
