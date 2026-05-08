/**
 * Config loader — reads and validates project.orca.yaml.
 */

import * as yaml from "js-yaml";
import Ajv from "ajv";
import { readFileSync, existsSync } from "fs";
import { resolve, dirname } from "path";
import type {
  OrcaConfig, Task, ResolvedTask, TaskDefaults,
  BudgetConfig, EvalConfig, StageOverride,
} from "./schema";

import schema from "../../../../schemas/project.orca.schema.json";

// Compile the schema once
const ajv = new Ajv({ allErrors: true });
const _validate = ajv.compile(schema);

export function validateConfig(config: unknown): config is OrcaConfig {
  return _validate(config) as boolean;
}

export async function loadConfig(path: string): Promise<OrcaConfig> {
  if (!existsSync(path)) {
    throw new Error(`Config file not found: ${path}`);
  }
  const raw = readFileSync(path, "utf8");
  const data = yaml.load(raw);
  if (!validateConfig(data)) {
    const errors = _validate.errors?.map(e => `${e.instancePath} ${e.message}`).join("; ");
    throw new Error(`Invalid config: ${errors}`);
  }
  return data;
}

export async function loadTasks(config: OrcaConfig, basePath: string): Promise<ResolvedTask[]> {
  let tasks: Task[] = [];

  // Load from external file
  if (config.tasks.file) {
    const filePath = resolve(dirname(basePath), config.tasks.file);
    if (!existsSync(filePath)) {
      throw new Error(`Tasks file not found: ${filePath}`);
    }
    const raw = readFileSync(filePath, "utf8");
    const data = yaml.load(raw);
    if (Array.isArray(data)) {
      tasks = data;
    } else if (data && typeof data === "object" && Array.isArray((data as any).list)) {
      tasks = (data as any).list;
    }
  }

  // Merge with inline tasks
  if (config.tasks.list) {
    tasks = [...tasks, ...config.tasks.list];
  }

  // Apply defaults
  return tasks.map(t => mergeTasks(config.tasks.defaults, t));
}

export function mergeTasks(defaults: TaskDefaults | undefined, task: Task): ResolvedTask {
  const d = defaults ?? {};

  // Scalars: task wins, fall back to default, then hard default
  const title = task.title ?? task.id;
  // Lists: task replaces default
  const tags = task.tags ?? d.tags ?? [];
  const depends_on = task.depends_on ?? d.depends_on ?? [];

  // Eval: shallow merge
  const eval_: EvalConfig = { ...d.eval, ...task.eval };

  // Budget: shallow merge
  const budget: BudgetConfig = { ...d.budget, ...task.budget };

  // Stages: deep merge (per-stage, task keys override default keys)
  const stages: Record<string, StageOverride> = {};
  if (d.stages) {
    for (const [k, v] of Object.entries(d.stages)) {
      stages[k] = { ...v };
    }
  }
  if (task.stages) {
    for (const [k, v] of Object.entries(task.stages)) {
      stages[k] = { ...stages[k], ...v };
    }
  }

  // Variables: deep merge (task extends defaults, same key = task wins)
  const variables: Record<string, unknown> = { ...d.variables, ...task.variables };

  return {
    id: task.id,
    title,
    tags,
    depends_on,
    eval: eval_,
    budget,
    stages: Object.keys(stages).length > 0 ? stages : undefined,
    variables,
    workflow: task.workflow,
  } as ResolvedTask;
}
