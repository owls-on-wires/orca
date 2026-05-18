/**
 * TypeScript types for project.orca.yaml.
 * These mirror the JSON schema at schemas/project.orca.schema.json.
 */

// ---------------------------------------------------------------------------
// Top-level config
// ---------------------------------------------------------------------------

export interface OrcaConfig {
  name: string;
  project_dir: string;
  model: string;
  tasks: TasksConfig;
  eval?: EvalConfig;
  workflow: WorkflowConfig;
  /** Named workflow templates. Tasks can reference these by name. */
  workflows?: Record<string, WorkflowConfig>;
  stages?: Record<string, StageConfig>;
  git?: GitConfig;
  scope?: ScopeConfig;
  budget?: BudgetConfig;
  supervisor?: SupervisorConfig;
  notifications?: NotificationsConfig;
  prompts?: PromptsConfig;
  nix?: NixConfig;

  /** Live-reloadable overrides. Re-read at the top of each iteration. */
  orca?: LiveReloadConfig;
}

// ---------------------------------------------------------------------------
// Tasks
// ---------------------------------------------------------------------------

export interface TasksConfig {
  file?: string;
  defaults?: TaskDefaults;
  list?: Task[];
}

export interface TaskDefaults {
  tags?: string[];
  depends_on?: string[];
  eval?: EvalConfig;
  budget?: BudgetConfig;
  stages?: Record<string, StageOverride>;
  variables?: Record<string, unknown>;
}

export interface Task {
  id: string;
  title?: string;
  tags?: string[];
  depends_on?: string[];
  eval?: EvalConfig;
  budget?: BudgetConfig;
  stages?: Record<string, StageOverride>;
  variables?: Record<string, unknown>;
  /** Named workflow to use for this task (references workflows map). */
  workflow?: string;
}

/** A task with defaults merged in — ready for execution. */
export interface ResolvedTask extends Task {
  title: string;
  tags: string[];
  depends_on: string[];
  eval: EvalConfig;
  budget: BudgetConfig;
  variables: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Eval
// ---------------------------------------------------------------------------

export type EvalParser = "cargo_test" | "pytest" | "json" | "exit_code";

export interface EvalConfig {
  command?: string;
  parser?: EvalParser;
  timeout?: number;
  results_file?: string;
}

export interface EvalResult {
  all_passed: boolean;
  total?: number;
  passed?: number;
  failed?: number;
  compile_error?: boolean;
  compile_errors?: string[];
  passed_tests?: string[];
  failed_tests?: string[];
  duration?: number;
  output?: string;
  error?: string;
  [key: string]: unknown;
}

// ---------------------------------------------------------------------------
// Workflow
// ---------------------------------------------------------------------------

export interface WorkflowConfig {
  setup?: string;
  pre?: string[];
  loop: string[];
  post?: string[];
}

// ---------------------------------------------------------------------------
// Stages
// ---------------------------------------------------------------------------

export type Toolset = "read_only" | "all" | "code" | "bash";
export type StageType = "agent" | "command" | "eval";

export interface StageConfig {
  /** Explicit stage type. Inferred if omitted: "eval" for name "eval", "command" if command field set, "agent" otherwise. */
  type?: StageType;
  /** Require status: "passed" in output. Restarts the loop on failure. */
  gate?: boolean;
  /** Use a built-in prompt/schema by this name (e.g., "analyze") regardless of the stage's own name. */
  builtin?: string;
  toolset?: Toolset;
  max_turns?: number;
  prompt?: string;
  schema?: string;
  model?: string;
  scope?: ScopeConfig;
  escalation?: boolean;
  supervisor?: boolean;
  timeout?: number;
  condition?: string;
  /** Shell command to run (for command/eval type stages). */
  command?: string;
  /** Eval parser (for eval type stages). */
  parser?: EvalParser;
  /** Health check command (used with command), polled every 5s until exit 0. */
  wait_for?: string;
  /** Max seconds to wait for wait_for health check (default 120). */
  wait_timeout?: number;
}

export interface StageOverride {
  max_turns?: number;
  toolset?: Toolset;
  model?: string;
  timeout?: number;
}

// ---------------------------------------------------------------------------
// Git
// ---------------------------------------------------------------------------

export interface GitConfig {
  enabled?: boolean;
  snapshot_before?: string;
  commit_after?: "loop" | "phase";
  commit_message?: string;
}

// ---------------------------------------------------------------------------
// Scope
// ---------------------------------------------------------------------------

export interface ScopeConfig {
  writable?: string[];
  readable?: string[];
}

// ---------------------------------------------------------------------------
// Budget
// ---------------------------------------------------------------------------

export interface BudgetConfig {
  max_iterations?: number;
  max_cost?: number;
  stage_timeout?: number;
  stuck_window?: number;
}

// ---------------------------------------------------------------------------
// Supervisor
// ---------------------------------------------------------------------------

export interface SupervisorConfig {
  model?: string;
  toolset?: Toolset;
  max_turns?: number;
  prompt?: string;
  stuck_window?: number;
}

// ---------------------------------------------------------------------------
// Notifications
// ---------------------------------------------------------------------------

export interface NotificationsConfig {
  on_build_start?: boolean;
  on_task_start?: boolean;
  on_escalation?: boolean;
  on_task_complete?: boolean;
  on_build_complete?: boolean;
  on_budget_warning?: number;
  channels?: NotificationChannel[];
}

export interface NotificationChannel {
  type: "command";
  run: string;
}

// ---------------------------------------------------------------------------
// Prompts — project-level and per-stage prompt injection
// ---------------------------------------------------------------------------

export interface PromptsConfig {
  /** Prepended to every stage prompt. Use for project-wide context. */
  context?: string;
  /** Per-stage text blocks. Appended to the named stage's prompt. */
  stages?: Record<string, string>;
}

// ---------------------------------------------------------------------------
// Live Reload
// ---------------------------------------------------------------------------

export interface LiveReloadConfig {
  max_iterations?: number;
  max_cost?: number;
  max_turns?: number;
  stage_timeout?: number;
}

// ---------------------------------------------------------------------------
// Nix
// ---------------------------------------------------------------------------

export interface NixConfig {
  enable?: boolean;            // default true, set false to disable
  flake?: boolean | string;    // true = repo root, string = path
  shell?: string;              // explicit path to shell.nix (relative to project_dir)
  packages?: string[];         // nixpkgs for nix shell -p
}

// ---------------------------------------------------------------------------
// Toolset presets
// ---------------------------------------------------------------------------

export const TOOLSETS: Record<Toolset, string[]> = {
  read_only: ["Read", "Glob", "Grep"],
  all: ["Read", "Write", "Edit", "Bash", "Glob", "Grep"],
  code: ["Read", "Write", "Edit", "Glob", "Grep"],
  bash: ["Read", "Bash", "Glob", "Grep"],
};
