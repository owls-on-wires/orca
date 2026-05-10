import yaml from "js-yaml";
import { OrcaDatabase } from "./db";
import {
  createAction,
  createEdge,
  createProject,
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
 *
 * @param sourceDir — directory the YAML was loaded from. project_dir is
 *   resolved relative to this. If not provided, project_dir must be absolute.
 */
export function expandConfig(yamlString: string, db: OrcaDatabase, sourceDir?: string): OrcaV2Config {
  const { resolve } = require("path") as typeof import("path");
  const config = yaml.load(yamlString) as OrcaV2Config;

  if (!config || !config.tasks || !Array.isArray(config.tasks)) {
    throw new Error("Invalid config: missing tasks array");
  }
  if (!config.name) {
    throw new Error("Invalid config: missing name");
  }

  // Resolve project_dir to absolute path relative to sourceDir
  const rawProjectDir = config.project_dir ?? ".";
  const resolvedProjectDir = sourceDir
    ? resolve(sourceDir, rawProjectDir)
    : resolve(rawProjectDir);

  // Create project record
  const project = createProject({
    id: config.name,
    project_dir: resolvedProjectDir,
    model: config.model,
    nix: config.nix,
    git: config.git,
    scope: config.scope,
    defaults: config.defaults,
  });

  // Upsert: delete existing project with same ID, then insert fresh
  if (db.getProject(config.name)) {
    db.deleteProject(config.name);
  }
  db.insertProject(project);

  const globalTypeDefaults = config.defaults?.types ?? {};

  // Resolve type defaults for a task: task's template types > global defaults
  function getTypeDefaults(task: V2TaskConfig): Record<string, ActionTypeDefaults> {
    if (task.template && config.templates?.[task.template]) {
      return { ...globalTypeDefaults, ...config.templates[task.template].types };
    }
    return globalTypeDefaults;
  }

  // Resolve actions list: explicit on task > template default > error
  function getActions(task: V2TaskConfig): string[] {
    if (task.actions && task.actions.length > 0) return task.actions;
    if (task.template && config.templates?.[task.template]?.actions) {
      return config.templates[task.template].actions!;
    }
    throw new Error("Task " + task.id + " has no actions and no template with default actions");
  }

  // Validate all action types exist in their resolved defaults
  for (const task of config.tasks) {
    const td = getTypeDefaults(task);
    const actions = getActions(task);
    for (const actionType of actions) {
      if (!td[actionType]) {
        const tpl = task.template || "none";
        throw new Error(
          "Unknown action type " + actionType + " in task " + task.id + " (template: " + tpl + ")",
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
    const typeDefaults = getTypeDefaults(task);
    const actionList = getActions(task);

    for (let i = 0; i < actionList.length; i++) {
      const actionType = actionList[i];
      const typeDef = typeDefaults[actionType];
      const actionId = `${task.id}.${actionType}`;

      // Determine status: first action with no depends_on = pending, rest = inactive
      const isFirst = i === 0 && (!task.depends_on || task.depends_on.length === 0);
      const status = isFirst ? "pending" : "inactive";

      // Merge params: type defaults + top-level type fields (command, timeout, etc.)
      const reservedKeys = new Set(['type', 'params', 'edges']);
      const topLevelParams: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(typeDef)) {
        if (!reservedKeys.has(k)) topLevelParams[k] = v;
      }
      const params: Record<string, unknown> = {
        ...topLevelParams,
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

      // Apply per-task overrides for this action type
      if (task.overrides?.[actionType]) {
        Object.assign(params, task.overrides[actionType]);
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
        project_id: config.name,
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
    const typeDefaults = getTypeDefaults(task);

    const resolvedActions = getActions(task);
    for (let i = 0; i < resolvedActions.length; i++) {
      const actionType = resolvedActions[i];
      const typeDef = typeDefaults[actionType];
      const actionId = `${task.id}.${actionType}`;

      // Get edges map — start with exhaustive defaults, then overlay user config.
      // Every condition gets a default so no outcome ever goes unhandled.
      const defaultEdges: Record<string, string> = {
        pass: "next",
        fail: "first",
        max_turns: "first",
        timeout: "first",
        cost_exceeded: "first",
        stuck: "first",
        error: "first",
      };
      const edgesMap: Partial<Record<EdgeCondition, string>> = {
        ...defaultEdges,
        ...(typeDef.edges ?? {}),
      };

      // Resolve each edge
      for (const [condition, target] of Object.entries(edgesMap)) {
        const resolved = resolveTarget(
          target,
          task.id,
          resolvedActions,
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

        // Skip self-loop edges — they create infinite loops (e.g. stuck detection)
        // and block join semantics. If "first" resolves to the current action, skip.
        if (resolved === actionId) {
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
 * Re-import specific tasks from a config, replacing their actions and edges
 * while preserving all other tasks' state. This is a partial re-import.
 *
 * Algorithm:
 * 1. Parse the full config and expand ALL tasks (to compute correct edges)
 * 2. Delete old actions for specified tasks (cascades edges via DB)
 * 3. Insert new actions for specified tasks
 * 4. Insert edges where at least one endpoint belongs to a re-imported task
 *    (skips edges where the other endpoint doesn't exist in DB)
 */
export function reimportTasks(
  yamlString: string,
  db: OrcaDatabase,
  taskIds: string[],
  sourceDir?: string,
): { replaced: string[]; actions: string[]; edges: number } {
  const { resolve } = require("path") as typeof import("path");
  const config = yaml.load(yamlString) as OrcaV2Config;

  if (!config || !config.tasks || !Array.isArray(config.tasks)) {
    throw new Error("Invalid config: missing tasks array");
  }
  if (!config.name) {
    throw new Error("Invalid config: missing name");
  }

  // Validate requested task IDs exist in config
  const configTaskIds = new Set(config.tasks.map((t) => t.id));
  for (const id of taskIds) {
    if (!configTaskIds.has(id)) {
      throw new Error(`Task "${id}" not found in config`);
    }
  }

  // Ensure project record exists (don't delete — that would SET NULL all action project_ids)
  const rawProjectDir = config.project_dir ?? ".";
  const resolvedProjectDir = sourceDir
    ? resolve(sourceDir, rawProjectDir)
    : resolve(rawProjectDir);

  if (!db.getProject(config.name)) {
    db.insertProject(createProject({
      id: config.name,
      project_dir: resolvedProjectDir,
      model: config.model,
      nix: config.nix,
      git: config.git,
      scope: config.scope,
      defaults: config.defaults,
    }));
  }

  // --- Full expansion (same as expandConfig phases 1-3) ---

  const globalTypeDefaults = config.defaults?.types ?? {};

  function getTypeDefaults(task: V2TaskConfig): Record<string, ActionTypeDefaults> {
    if (task.template && config.templates?.[task.template]) {
      return { ...globalTypeDefaults, ...config.templates[task.template].types };
    }
    return globalTypeDefaults;
  }

  function getActions(task: V2TaskConfig): string[] {
    if (task.actions && task.actions.length > 0) return task.actions;
    if (task.template && config.templates?.[task.template]?.actions) {
      return config.templates[task.template].actions!;
    }
    throw new Error("Task " + task.id + " has no actions and no template with default actions");
  }

  const taskActions: Map<string, ActionConfig[]> = new Map();
  const allEdges: EdgeConfig[] = [];

  // Phase 1: Expand all tasks into actions (needed for edge resolution)
  for (const task of config.tasks) {
    const actions: ActionConfig[] = [];
    const typeDefaults = getTypeDefaults(task);
    const actionList = getActions(task);

    for (let i = 0; i < actionList.length; i++) {
      const actionType = actionList[i];
      const typeDef = typeDefaults[actionType];
      if (!typeDef) {
        throw new Error(`Unknown action type ${actionType} in task ${task.id}`);
      }
      const actionId = `${task.id}.${actionType}`;
      const isFirst = i === 0 && (!task.depends_on || task.depends_on.length === 0);

      const reservedKeys = new Set(["type", "params", "edges"]);
      const topLevelParams: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(typeDef)) {
        if (!reservedKeys.has(k)) topLevelParams[k] = v;
      }
      const params: Record<string, unknown> = {
        ...topLevelParams,
        ...(typeDef.params ?? {}),
      };
      if (typeDef.type === "agent" && task.prompt) {
        params.prompt = task.prompt;
      }
      if (task.budget) {
        if (task.budget.max_iterations !== undefined) params.max_iterations = task.budget.max_iterations;
        if (task.budget.max_cost !== undefined) params.max_cost = task.budget.max_cost;
      }
      if (task.overrides?.[actionType]) {
        Object.assign(params, task.overrides[actionType]);
      }

      const tags = [
        `type:${actionType}`,
        `task:${task.id}`,
        `project:${config.name}`,
        ...(task.tags ?? []),
      ];

      actions.push(createAction({
        id: actionId,
        type: typeDef.type,
        status: isFirst ? "pending" : "inactive",
        project_id: config.name,
        params,
        tags,
      }));
    }
    taskActions.set(task.id, actions);
  }

  // Phase 2: Generate edges
  for (const task of config.tasks) {
    const typeDefaults = getTypeDefaults(task);
    const resolvedActions = getActions(task);

    for (let i = 0; i < resolvedActions.length; i++) {
      const actionType = resolvedActions[i];
      const typeDef = typeDefaults[actionType];
      const actionId = `${task.id}.${actionType}`;

      const defaultEdges: Record<string, string> = {
        pass: "next", fail: "first", max_turns: "first",
        timeout: "first", cost_exceeded: "first", stuck: "first", error: "first",
      };
      const edgesMap: Partial<Record<EdgeCondition, string>> = {
        ...defaultEdges,
        ...(typeDef.edges ?? {}),
      };

      for (const [condition, target] of Object.entries(edgesMap)) {
        const resolved = resolveTarget(target, task.id, resolvedActions, i, typeDefaults, taskActions, config, task);
        if (resolved === null || resolved === actionId) continue;
        allEdges.push(createEdge(actionId, resolved, condition as EdgeCondition));
      }
    }
  }

  // Phase 3: Cross-task dependencies
  for (const task of config.tasks) {
    if (!task.depends_on || task.depends_on.length === 0) continue;
    const thisTaskActions = taskActions.get(task.id)!;
    const firstAction = thisTaskActions[0];
    for (const depTaskId of task.depends_on) {
      const depActions = taskActions.get(depTaskId);
      if (!depActions || depActions.length === 0) {
        throw new Error(`Task "${task.id}" depends on "${depTaskId}" which does not exist`);
      }
      const terminalAction = depActions[depActions.length - 1];
      allEdges.push(createEdge(terminalAction.id, firstAction.id, "pass"));
    }
  }

  // --- Apply delta: only modify specified tasks ---

  const taskIdSet = new Set(taskIds);
  const newActionIds = new Set<string>();

  // Collect all action IDs for re-imported tasks
  for (const taskId of taskIds) {
    const actions = taskActions.get(taskId)!;
    for (const a of actions) {
      newActionIds.add(a.id);
    }
  }

  // Delete old actions for specified tasks (cascade removes edges)
  for (const taskId of taskIds) {
    const oldActions = db.listActions({ tag: `task:${taskId}` });
    for (const old of oldActions) {
      db.deleteAction(old.id);
    }
  }

  // Insert new actions for specified tasks
  for (const taskId of taskIds) {
    const actions = taskActions.get(taskId)!;
    for (const action of actions) {
      db.insertAction(action);
    }
  }

  // Insert edges where at least one endpoint is a re-imported action
  let edgeCount = 0;
  for (const edge of allEdges) {
    const fromIsNew = newActionIds.has(edge.from_action);
    const toIsNew = newActionIds.has(edge.to_action);

    if (!fromIsNew && !toIsNew) continue;

    // Verify both endpoints exist
    const fromExists = fromIsNew || db.getAction(edge.from_action) !== null;
    const toExists = toIsNew || db.getAction(edge.to_action) !== null;

    if (fromExists && toExists) {
      db.insertEdge(edge);
      edgeCount++;
    }
  }

  return {
    replaced: taskIds,
    actions: Array.from(newActionIds),
    edges: edgeCount,
  };
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
          const autoReserved = new Set(['type', 'params', 'edges']);
          const autoTopLevel: Record<string, unknown> = {};
          for (const [k, v] of Object.entries(typeDef)) {
            if (!autoReserved.has(k)) autoTopLevel[k] = v;
          }
          const params: Record<string, unknown> = {
            ...autoTopLevel,
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
            project_id: config.name,
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
