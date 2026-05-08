/**
 * Prompt and schema resolution.
 *
 * Built-in defaults are embedded at compile time via static imports.
 * Project-level overrides are loaded from disk at runtime.
 *
 * 3-tier fallback:
 * 1. Project's stages/{taskId}/{stage}.prompt.txt (task-specific override)
 * 2. Project's stages/{stage}.prompt.txt (shared project prompt)
 * 3. Orca's built-in defaults (embedded in binary)
 */

import { readFileSync, existsSync } from "fs";
import { join } from "path";

// ---------------------------------------------------------------------------
// Embedded built-in prompts (compile-time, no filesystem dependency)
// ---------------------------------------------------------------------------

import systemPrompt from "../prompts/system.prompt.txt";

import setupPrompt from "../prompts/setup.prompt.txt";
import setupSchema from "../prompts/setup.schema.json";

import understandPrompt from "../prompts/understand.prompt.txt";
import understandSchema from "../prompts/understand.schema.json";

import writeTestsPrompt from "../prompts/write_tests.prompt.txt";
import writeTestsSchema from "../prompts/write_tests.schema.json";

import analyzePrompt from "../prompts/analyze.prompt.txt";
import analyzeSchema from "../prompts/analyze.schema.json";

import developPrompt from "../prompts/develop.prompt.txt";
import developSchema from "../prompts/develop.schema.json";

import supervisorPrompt from "../prompts/supervisor.prompt.txt";
import supervisorSchema from "../prompts/supervisor.schema.json";

import regressionPrompt from "../prompts/regression.prompt.txt";
import regressionSchema from "../prompts/regression.schema.json";

import qaPrompt from "../prompts/qa.prompt.txt";
import qaSchema from "../prompts/qa.schema.json";

// ---------------------------------------------------------------------------
// Lookup tables
// ---------------------------------------------------------------------------

const BUILTIN_PROMPTS: Record<string, string> = {
  setup: setupPrompt,
  understand: understandPrompt,
  write_tests: writeTestsPrompt,
  analyze: analyzePrompt,
  develop: developPrompt,
  supervisor: supervisorPrompt,
  regression: regressionPrompt,
  qa: qaPrompt,
};

const BUILTIN_SCHEMAS: Record<string, object> = {
  setup: setupSchema,
  understand: understandSchema,
  write_tests: writeTestsSchema,
  analyze: analyzeSchema,
  develop: developSchema,
  supervisor: supervisorSchema,
  regression: regressionSchema,
  qa: qaSchema,
};

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/** All stage names that have built-in defaults. */
export const DEFAULT_STAGES = [
  "setup", "understand", "write_tests", "analyze", "develop", "supervisor", "regression", "qa",
] as const;

export type DefaultStage = (typeof DEFAULT_STAGES)[number];

/** Load a built-in default prompt by stage name. */
export function getDefaultPrompt(stage: string): string | null {
  return BUILTIN_PROMPTS[stage] ?? null;
}

/** Load a built-in default schema by stage name. */
export function getDefaultSchema(stage: string): object | null {
  return BUILTIN_SCHEMAS[stage] ?? null;
}

/** Load the system prompt (always included in every invocation). */
export function getSystemPrompt(): string {
  return systemPrompt;
}

/**
 * Resolve a prompt for a stage, checking project files first,
 * then falling back to built-in defaults.
 *
 * If `builtin` is provided, it overrides the stage name for built-in lookup,
 * allowing a stage named "code_review" to use the "analyze" built-in prompt.
 */
export function resolvePrompt(
  stage: string,
  stagesDir: string | null,
  taskId?: string,
  builtin?: string,
): string | null {
  // Project-level files are checked by stage name (not builtin)
  if (stagesDir && taskId) {
    const taskPath = join(stagesDir, taskId, `${stage}.prompt.txt`);
    if (existsSync(taskPath)) return readFileSync(taskPath, "utf8");
  }

  if (stagesDir) {
    const sharedPath = join(stagesDir, `${stage}.prompt.txt`);
    if (existsSync(sharedPath)) return readFileSync(sharedPath, "utf8");
  }

  // Built-in lookup uses `builtin` name if provided, otherwise stage name
  return getDefaultPrompt(builtin ?? stage);
}

/**
 * Resolve a schema for a stage, checking project files first,
 * then falling back to built-in defaults.
 *
 * If `builtin` is provided, it overrides the stage name for built-in lookup.
 */
export function resolveSchema(
  stage: string,
  stagesDir: string | null,
  taskId?: string,
  builtin?: string,
): object | null {
  if (stagesDir && taskId) {
    const taskPath = join(stagesDir, taskId, `${stage}.schema.json`);
    if (existsSync(taskPath)) {
      try { return JSON.parse(readFileSync(taskPath, "utf8")); } catch {}
    }
  }

  if (stagesDir) {
    const sharedPath = join(stagesDir, `${stage}.schema.json`);
    if (existsSync(sharedPath)) {
      try { return JSON.parse(readFileSync(sharedPath, "utf8")); } catch {}
    }
  }

  return getDefaultSchema(builtin ?? stage);
}
