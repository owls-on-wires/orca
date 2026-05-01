/**
 * State persistence — state.json, artifacts, JSONL logs.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";

export interface TaskDiscovery {
  taskId: string;
  discoveredAt: string;
}

export interface BuildState {
  runId: string;
  name: string;
  status: "running" | "completed" | "failed" | "paused";
  currentTaskId: string | null;
  tasksCompleted: string[];
  tasksFailed: string[];
  totalCostUsd: number;
  startedAt: string;
  updatedAt: string;
  tasks: Record<string, TaskState>;
  tasksDiscovered?: TaskDiscovery[];
}

export interface TaskState {
  taskId: string;
  status: "pending" | "running" | "completed" | "failed" | "skipped";
  currentStage: string | null;
  stageStartedAt: string | null;
  stageTurns: number | null;
  stageMaxTurns: number | null;
  iteration: number;
  maxIterations: number;
  costUsd: number;
  maxCost: number;
  stopReason: string | null;
  snapshots: string[];
  history: StageRecord[];
}

export interface StageRecord {
  iteration: number;
  label: string;
  timestamp: string;
  costUsd: number;
  summary: string;
  artifactPath: string | null;
  outputHash: string | null;
}

export interface Artifact {
  name: string;
  iteration: number;
  path: string;
  data: unknown;
}

const ORCA_DIR = ".orca";

export function getOrcaDir(projectDir: string): string {
  return `${projectDir}/${ORCA_DIR}`;
}

export function getRunDir(projectDir: string, name: string, runId: string): string {
  return `${getOrcaDir(projectDir)}/runs/${name}/${runId}`;
}

export async function loadState(runDir: string): Promise<BuildState | null> {
  const statePath = join(runDir, "state.json");
  if (!existsSync(statePath)) return null;
  try {
    const raw = readFileSync(statePath, "utf8");
    return JSON.parse(raw) as BuildState;
  } catch {
    return null;
  }
}

export async function saveState(runDir: string, state: BuildState): Promise<void> {
  if (!existsSync(runDir)) {
    mkdirSync(runDir, { recursive: true });
  }
  const statePath = join(runDir, "state.json");
  writeFileSync(statePath, JSON.stringify(state, null, 2));
}

export async function saveArtifact(
  runDir: string,
  name: string,
  iteration: number,
  data: unknown,
): Promise<string> {
  if (!existsSync(runDir)) {
    mkdirSync(runDir, { recursive: true });
  }
  const filename = `${name}_iter${iteration}.json`;
  const filepath = join(runDir, filename);
  writeFileSync(filepath, JSON.stringify(data, null, 2));
  return filename;
}
