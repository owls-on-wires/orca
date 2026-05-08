import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, existsSync, readFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import {
  loadState,
  saveState,
  saveArtifact,
  getOrcaDir,
  getRunDir,
  type BuildState,
  type TaskState,
} from "./index";

let tempDir: string;
let runDir: string;

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), "orca-state-test-"));
  runDir = join(tempDir, "run");
  Bun.spawnSync(["mkdir", "-p", runDir]);
});

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

function makeBuildState(overrides: Partial<BuildState> = {}): BuildState {
  return {
    runId: "20260414_120000",
    name: "test-build",
    status: "running",
    currentTaskId: "dev_socket",
    tasksCompleted: [],
    tasksFailed: [],
    totalCostUsd: 0,
    startedAt: "2026-04-14T12:00:00Z",
    updatedAt: "2026-04-14T12:00:00Z",
    tasks: {},
    ...overrides,
  };
}

describe("getOrcaDir", () => {
  test("returns .orca under project dir", () => {
    expect(getOrcaDir("/project")).toBe("/project/.orca");
  });
});

describe("getRunDir", () => {
  test("returns nested run directory", () => {
    expect(getRunDir("/project", "my-build", "20260414")).toBe(
      "/project/.orca/runs/my-build/20260414",
    );
  });
});

describe("saveState + loadState", () => {
  test("round-trips a build state", async () => {
    const state = makeBuildState({
      totalCostUsd: 12.50,
      tasksCompleted: ["a", "b"],
    });
    await saveState(runDir, state);
    const loaded = await loadState(runDir);
    expect(loaded).not.toBeNull();
    expect(loaded!.runId).toBe("20260414_120000");
    expect(loaded!.name).toBe("test-build");
    expect(loaded!.totalCostUsd).toBe(12.50);
    expect(loaded!.tasksCompleted).toEqual(["a", "b"]);
  });

  test("writes state.json file", async () => {
    await saveState(runDir, makeBuildState());
    expect(existsSync(join(runDir, "state.json"))).toBe(true);
  });

  test("state.json is valid JSON", async () => {
    await saveState(runDir, makeBuildState());
    const raw = readFileSync(join(runDir, "state.json"), "utf8");
    expect(() => JSON.parse(raw)).not.toThrow();
  });

  test("loadState returns null for missing file", async () => {
    const result = await loadState(join(tempDir, "nonexistent"));
    expect(result).toBeNull();
  });

  test("preserves task state", async () => {
    const taskState: TaskState = {
      taskId: "dev_socket",
      status: "running",
      currentStage: "develop",
      stageStartedAt: "2026-04-14T12:00:30Z",
      stageTurns: null,
      stageMaxTurns: 100,
      iteration: 3,
      maxIterations: 10,
      costUsd: 5.25,
      maxCost: 80,
      stopReason: null,
      snapshots: ["abc123", "def456"],
      history: [
        {
          iteration: 1,
          label: "develop",
          timestamp: "2026-04-14T12:01:00Z",
          costUsd: 2.50,
          summary: "implemented feature",
          artifactPath: "eval_iter1.json",
          outputHash: "abcdef",
        },
      ],
    };
    const state = makeBuildState({ tasks: { dev_socket: taskState } });
    await saveState(runDir, state);
    const loaded = await loadState(runDir);
    expect(loaded!.tasks.dev_socket.iteration).toBe(3);
    expect(loaded!.tasks.dev_socket.snapshots).toEqual(["abc123", "def456"]);
    expect(loaded!.tasks.dev_socket.history[0].label).toBe("develop");
    expect(loaded!.tasks.dev_socket.history[0].outputHash).toBe("abcdef");
  });

  test("overwrites existing state", async () => {
    await saveState(runDir, makeBuildState({ status: "running" }));
    await saveState(runDir, makeBuildState({ status: "completed" }));
    const loaded = await loadState(runDir);
    expect(loaded!.status).toBe("completed");
  });
});

describe("saveArtifact", () => {
  test("saves artifact as JSON file and returns path", async () => {
    const data = { all_passed: true, total: 5, passed: 5 };
    const path = await saveArtifact(runDir, "eval", 1, data);
    expect(path).toContain("eval_iter1.json");
    expect(existsSync(join(runDir, "eval_iter1.json"))).toBe(true);
  });

  test("artifact contains the data", async () => {
    const data = { forms_found: 7, dup_rate: 0.05 };
    await saveArtifact(runDir, "metrics", 3, data);
    const raw = readFileSync(join(runDir, "metrics_iter3.json"), "utf8");
    const parsed = JSON.parse(raw);
    expect(parsed.forms_found).toBe(7);
    expect(parsed.dup_rate).toBe(0.05);
  });

  test("different iterations produce different files", async () => {
    await saveArtifact(runDir, "eval", 1, { iter: 1 });
    await saveArtifact(runDir, "eval", 2, { iter: 2 });
    expect(existsSync(join(runDir, "eval_iter1.json"))).toBe(true);
    expect(existsSync(join(runDir, "eval_iter2.json"))).toBe(true);
  });

  test("creates run dir if needed", async () => {
    const nestedDir = join(tempDir, "deep", "nested", "run");
    const path = await saveArtifact(nestedDir, "eval", 1, { ok: true });
    expect(existsSync(join(nestedDir, "eval_iter1.json"))).toBe(true);
  });
});
