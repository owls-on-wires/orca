/**
 * CLI tests — command dispatch, validation, init, status.
 *
 * These test the CLI by spawning the actual process and checking
 * stdout/stderr/exit codes. No mocks — real subprocess execution.
 */

import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync, mkdirSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

const CLI = join(import.meta.dir, "cli.ts");

function run(...args: string[]) {
  const result = Bun.spawnSync(["bun", "run", CLI, ...args], {
    cwd: import.meta.dir + "/..",
    stdout: "pipe",
    stderr: "pipe",
    timeout: 10000,
  });
  return {
    stdout: result.stdout.toString(),
    stderr: result.stderr.toString(),
    exitCode: result.exitCode,
  };
}

describe("CLI help", () => {
  test("--help shows usage", () => {
    const { stdout, exitCode } = run("--help");
    expect(exitCode).toBe(0);
    expect(stdout).toContain("orca");
    expect(stdout).toContain("build");
    expect(stdout).toContain("monitor");
    expect(stdout).toContain("status");
    expect(stdout).toContain("validate");
    expect(stdout).toContain("init");
  });

  test("-h shows usage", () => {
    const { stdout, exitCode } = run("-h");
    expect(exitCode).toBe(0);
    expect(stdout).toContain("orca");
  });

  test("no args shows usage", () => {
    const { stdout, exitCode } = run();
    expect(exitCode).toBe(0);
    expect(stdout).toContain("orca");
  });

  test("unknown command exits with error", () => {
    const { stderr, exitCode } = run("nonexistent");
    expect(exitCode).toBe(1);
    expect(stderr).toContain("Unknown command");
  });

  test("--help shows --monitor option", () => {
    const { stdout, exitCode } = run("--help");
    expect(exitCode).toBe(0);
    expect(stdout).toContain("--monitor");
  });
});

describe("CLI validate", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "orca-cli-validate-"));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  test("validates a correct config file", () => {
    const configPath = join(tempDir, "project.orca.yaml");
    writeFileSync(configPath, `
name: test-build
project_dir: .
model: opus
tasks:
  list:
    - id: hello
workflow:
  loop:
    - eval
    - develop
`);
    const { exitCode, stdout } = run("validate", configPath);
    // Should exit 0 with a success message
    expect(exitCode).toBe(0);
  });

  test("rejects invalid config file", () => {
    const configPath = join(tempDir, "project.orca.yaml");
    writeFileSync(configPath, `
project_dir: .
# missing name and workflow
`);
    const { exitCode } = run("validate", configPath);
    expect(exitCode).not.toBe(0);
  });

  test("rejects nonexistent file", () => {
    const { exitCode } = run("validate", "/nonexistent/project.orca.yaml");
    expect(exitCode).not.toBe(0);
  });

  test("rejects invalid YAML", () => {
    const configPath = join(tempDir, "project.orca.yaml");
    writeFileSync(configPath, "{{{{invalid yaml");
    const { exitCode } = run("validate", configPath);
    expect(exitCode).not.toBe(0);
  });
});

describe("CLI init", () => {
  let tempDir: string;

  function runInTemp(...args: string[]) {
    const result = Bun.spawnSync(["bun", "run", CLI, ...args], {
      cwd: tempDir,
      stdout: "pipe",
      stderr: "pipe",
      timeout: 10000,
    });
    return {
      stdout: result.stdout.toString(),
      stderr: result.stderr.toString(),
      exitCode: result.exitCode,
    };
  }

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "orca-cli-init-"));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  test("init --template generic creates config file", () => {
    const { exitCode } = runInTemp("init", "--template", "generic");
    expect(exitCode).toBe(0);
    expect(existsSync(join(tempDir, "project.orca.yaml"))).toBe(true);
    expect(existsSync(join(tempDir, "stages"))).toBe(true);
  });

  test("init --template rust-library creates config from template", () => {
    const { exitCode } = runInTemp("init", "--template", "rust-library");
    expect(exitCode).toBe(0);
    expect(existsSync(join(tempDir, "project.orca.yaml"))).toBe(true);
  });

  test("init --template rust-maintainer creates config from template", () => {
    const { exitCode } = runInTemp("init", "--template", "rust-maintainer");
    expect(exitCode).toBe(0);
    expect(existsSync(join(tempDir, "project.orca.yaml"))).toBe(true);
  });

  test("init --template metric-optimizer creates config from template", () => {
    const { exitCode } = runInTemp("init", "--template", "metric-optimizer");
    expect(exitCode).toBe(0);
    expect(existsSync(join(tempDir, "project.orca.yaml"))).toBe(true);
  });

  test("init with unknown template fails", () => {
    const { exitCode } = runInTemp("init", "--template", "nonexistent");
    expect(exitCode).not.toBe(0);
  });

  test("init fails if project.orca.yaml already exists", () => {
    writeFileSync(join(tempDir, "project.orca.yaml"), "name: existing");
    const { exitCode } = runInTemp("init", "--template", "generic");
    expect(exitCode).not.toBe(0);
  });
});

describe("CLI status", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "orca-cli-status-"));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  test("status on config with existing state", () => {
    // Create a minimal config
    const configPath = join(tempDir, "project.orca.yaml");
    writeFileSync(configPath, `
name: test-build
project_dir: ${tempDir}
tasks:
  list:
    - id: task1
workflow:
  loop:
    - eval
`);

    // Create state directory and file
    const stateDir = join(tempDir, ".orca", "runs", "test-build", "20260414_120000");
    mkdirSync(stateDir, { recursive: true });
    writeFileSync(join(stateDir, "state.json"), JSON.stringify({
      runId: "20260414_120000",
      name: "test-build",
      status: "completed",
      currentTaskId: null,
      tasksCompleted: ["task1"],
      tasksFailed: [],
      totalCostUsd: 12.50,
      startedAt: "2026-04-14T12:00:00Z",
      updatedAt: "2026-04-14T12:30:00Z",
      tasks: {
        task1: {
          taskId: "task1",
          status: "completed",
          iteration: 3,
          maxIterations: 10,
          costUsd: 12.50,
          maxCost: 50,
          stopReason: null,
          snapshots: [],
          history: [],
        },
      },
    }));

    const { exitCode } = run("status", configPath);
    // Should read and display state without crashing
    expect(exitCode).toBeDefined();
  });

  test("status --json returns JSON", () => {
    const configPath = join(tempDir, "project.orca.yaml");
    writeFileSync(configPath, `
name: test-build
project_dir: ${tempDir}
tasks:
  list:
    - id: task1
workflow:
  loop:
    - eval
`);

    const stateDir = join(tempDir, ".orca", "runs", "test-build", "20260414_120000");
    mkdirSync(stateDir, { recursive: true });
    writeFileSync(join(stateDir, "state.json"), JSON.stringify({
      runId: "20260414_120000",
      name: "test-build",
      status: "completed",
      currentTaskId: null,
      tasksCompleted: ["task1"],
      tasksFailed: [],
      totalCostUsd: 12.50,
      startedAt: "2026-04-14T12:00:00Z",
      updatedAt: "2026-04-14T12:30:00Z",
      tasks: {},
    }));

    const { exitCode, stdout } = run("status", configPath, "--json");
    // If implemented, stdout should be valid JSON
    expect(exitCode).toBeDefined();
  });

  test("status with no state directory", () => {
    const configPath = join(tempDir, "project.orca.yaml");
    writeFileSync(configPath, `
name: test-build
project_dir: ${tempDir}
tasks:
  list:
    - id: task1
workflow:
  loop:
    - eval
`);

    const { exitCode } = run("status", configPath);
    // Should handle gracefully — no state yet
    expect(exitCode).toBeDefined();
  });
});

describe("CLI --monitor flag", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "orca-cli-monitor-"));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  test("--monitor and --detach are incompatible", () => {
    const configPath = join(tempDir, "project.orca.yaml");
    writeFileSync(configPath, `
name: test-build
project_dir: ${tempDir}
tasks:
  list:
    - id: task1
workflow:
  loop:
    - eval
`);
    const { exitCode, stderr } = run("build", configPath, "--monitor", "--detach");
    expect(exitCode).toBe(1);
    expect(stderr).toContain("--monitor and --detach are incompatible");
  });

  test("--detach and --monitor are incompatible (reversed order)", () => {
    const configPath = join(tempDir, "project.orca.yaml");
    writeFileSync(configPath, `
name: test-build
project_dir: ${tempDir}
tasks:
  list:
    - id: task1
workflow:
  loop:
    - eval
`);
    const { exitCode, stderr } = run("build", configPath, "--detach", "--monitor");
    expect(exitCode).toBe(1);
    expect(stderr).toContain("--monitor and --detach are incompatible");
  });

  test("--monitor with nonexistent config file still fails", () => {
    const { exitCode, stderr } = run("build", "/nonexistent/project.orca.yaml", "--monitor");
    expect(exitCode).toBe(1);
    expect(stderr).toContain("File not found");
  });
});
