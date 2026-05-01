import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import {
  DEFAULT_STAGES,
  getDefaultPrompt,
  getDefaultSchema,
  getSystemPrompt,
  resolvePrompt,
  resolveSchema,
} from "./prompts";

describe("built-in prompt files", () => {
  test("all default stages have a prompt file", () => {
    for (const stage of DEFAULT_STAGES) {
      const prompt = getDefaultPrompt(stage);
      expect(prompt).not.toBeNull();
      expect(prompt!.length).toBeGreaterThan(0);
    }
  });

  test("all default stages have a schema file", () => {
    for (const stage of DEFAULT_STAGES) {
      const schema = getDefaultSchema(stage);
      expect(schema).not.toBeNull();
    }
  });

  test("all schemas are valid JSON with type and properties", () => {
    for (const stage of DEFAULT_STAGES) {
      const schema = getDefaultSchema(stage) as Record<string, unknown>;
      expect(schema.type).toBe("object");
      expect(schema.properties).toBeDefined();
    }
  });

  test("system prompt exists and is non-empty", () => {
    const prompt = getSystemPrompt();
    expect(prompt.length).toBeGreaterThan(0);
    expect(prompt).toContain("Output Style Guide");
  });

  test("develop schema includes escalation object", () => {
    const schema = getDefaultSchema("develop") as Record<string, any>;
    const props = schema.properties;
    expect(props.escalation).toBeDefined();
    expect(props.escalation.properties.cause).toBeDefined();
    expect(props.escalation.properties.cause.enum).toContain("test_bug");
    expect(props.escalation.properties.cause.enum).toContain("environment_problem");
    expect(props.escalation.properties.cause.enum).toContain("bad_requirements");
  });

  test("unknown stage returns null", () => {
    expect(getDefaultPrompt("nonexistent_stage")).toBeNull();
    expect(getDefaultSchema("nonexistent_stage")).toBeNull();
  });
});

describe("resolvePrompt", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "orca-prompts-test-"));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  test("falls back to built-in when no project files exist", () => {
    const prompt = resolvePrompt("develop", tempDir);
    expect(prompt).not.toBeNull();
    expect(prompt).toContain("Implement the");
  });

  test("falls back to built-in when stagesDir is null", () => {
    const prompt = resolvePrompt("develop", null);
    expect(prompt).not.toBeNull();
  });

  test("project file overrides built-in", () => {
    writeFileSync(join(tempDir, "develop.prompt.txt"), "Custom develop prompt");
    const prompt = resolvePrompt("develop", tempDir);
    expect(prompt).toBe("Custom develop prompt");
  });

  test("task-specific file overrides shared project file", () => {
    writeFileSync(join(tempDir, "develop.prompt.txt"), "Shared prompt");
    mkdirSync(join(tempDir, "my_task"), { recursive: true });
    writeFileSync(join(tempDir, "my_task", "develop.prompt.txt"), "Task-specific prompt");

    const prompt = resolvePrompt("develop", tempDir, "my_task");
    expect(prompt).toBe("Task-specific prompt");
  });

  test("shared project file used when task-specific doesn't exist", () => {
    writeFileSync(join(tempDir, "develop.prompt.txt"), "Shared prompt");
    const prompt = resolvePrompt("develop", tempDir, "my_task");
    expect(prompt).toBe("Shared prompt");
  });
});

describe("resolveSchema", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "orca-schema-test-"));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  test("falls back to built-in when no project files exist", () => {
    const schema = resolveSchema("develop", tempDir) as Record<string, any>;
    expect(schema).not.toBeNull();
    expect(schema.properties.status).toBeDefined();
  });

  test("project file overrides built-in", () => {
    writeFileSync(join(tempDir, "develop.schema.json"), '{"type":"object","properties":{"custom":{"type":"string"}}}');
    const schema = resolveSchema("develop", tempDir) as Record<string, any>;
    expect(schema.properties.custom).toBeDefined();
  });

  test("task-specific schema overrides shared", () => {
    writeFileSync(join(tempDir, "develop.schema.json"), '{"type":"object","properties":{"shared":{"type":"string"}}}');
    mkdirSync(join(tempDir, "t1"), { recursive: true });
    writeFileSync(join(tempDir, "t1", "develop.schema.json"), '{"type":"object","properties":{"specific":{"type":"string"}}}');

    const schema = resolveSchema("develop", tempDir, "t1") as Record<string, any>;
    expect(schema.properties.specific).toBeDefined();
  });
});
