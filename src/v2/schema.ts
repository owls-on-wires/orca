// V2 type definitions and helpers

export type ActionType = "agent" | "command";

export type EdgeCondition =
  | "pass"
  | "fail"
  | "max_turns"
  | "timeout"
  | "cost_exceeded"
  | "stuck"
  | "error";

export type ActionStatus =
  | "inactive"
  | "pending"
  | "running"
  | "completed"
  | "failed"
  | "skipped"
  | "waiting";

export interface ActionOutput {
  status: string;
  summary: string;
  notes?: string;
  [key: string]: unknown;
}

export interface ActionConfig {
  id: string;
  type: ActionType;
  status: ActionStatus;
  project_id: string | null;
  params: Record<string, unknown>;
  output: ActionOutput | null;
  tags: string[];
  cost_usd: number;
  iteration: number;
  created_at: string;
  updated_at: string;
  started_at: string | null;
  completed_at: string | null;
}

export interface EdgeConfig {
  id?: number;
  from_action: string;
  to_action: string;
  condition: EdgeCondition;
}

export interface HistoryEntry {
  id: number;
  action_id: string;
  iteration: number | null;
  event_type: string;
  data: unknown;
  timestamp: string;
}

export interface ActionTypeDefaults {
  type: ActionType;
  params?: Record<string, unknown>;
  edges?: Partial<Record<EdgeCondition, string>>;
}

export interface OrcaV2Config {
  name: string;
  project_dir?: string;
  model?: string;
  nix?: NixConfig;
  git?: GitConfig;
  scope?: ScopeConfig;
  defaults?: {
    types?: Record<string, ActionTypeDefaults>;
  };
  tasks: V2TaskConfig[];
}

export interface V2TaskConfig {
  id: string;
  prompt: string;
  actions: string[];
  depends_on?: string[];
  tags?: string[];
  budget?: { max_iterations?: number; max_cost?: number };
  variables?: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Projects — first-class organizational object
// ---------------------------------------------------------------------------

export interface NixConfig {
  enable?: boolean;
  flake?: boolean | string;
  packages?: string[];
}

export interface GitConfig {
  enabled?: boolean;
  snapshot_before?: string;
  commit_after?: string;
  commit_message?: string;
}

export interface ScopeConfig {
  writable?: string[];
  readable?: string[];
}

export interface ProjectConfig {
  id: string;
  project_dir: string;
  model?: string;
  nix?: NixConfig;
  git?: GitConfig;
  scope?: ScopeConfig;
  defaults?: {
    types?: Record<string, ActionTypeDefaults>;
  };
  created_at: string;
  updated_at: string;
}

export function createProject(overrides: Partial<ProjectConfig> & { id: string; project_dir: string }): ProjectConfig {
  const now = new Date().toISOString();
  return {
    model: undefined,
    nix: undefined,
    git: undefined,
    scope: undefined,
    defaults: undefined,
    created_at: now,
    updated_at: now,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Graph deltas
// ---------------------------------------------------------------------------

export type GraphDelta =
  | { type: "add_action"; action_id: string; action: Partial<ActionConfig> }
  | { type: "remove_action"; action_id: string }
  | { type: "update_params"; action_id: string; params: Record<string, unknown> }
  | { type: "add_edge"; edge: EdgeConfig }
  | { type: "remove_edge"; edge_id: number };

/** Factory with sensible defaults for ActionConfig. */
export function createAction(overrides: Partial<ActionConfig> = {}): ActionConfig {
  const now = new Date().toISOString();
  return {
    id: "",
    type: "agent",
    status: "pending",
    project_id: null,
    params: {},
    output: null,
    tags: [],
    cost_usd: 0,
    iteration: 0,
    created_at: now,
    updated_at: now,
    started_at: null,
    completed_at: null,
    ...overrides,
  };
}

/** Create an edge between two actions with a given condition. */
export function createEdge(
  from: string,
  to: string,
  condition: EdgeCondition,
): EdgeConfig {
  return {
    from_action: from,
    to_action: to,
    condition,
  };
}

/**
 * Returns true when the condition represents a terminal state
 * (i.e. "pass" — when there is no outgoing pass edge, the action graph is done).
 */
export function isTerminalCondition(condition: EdgeCondition): boolean {
  return condition === "pass";
}
