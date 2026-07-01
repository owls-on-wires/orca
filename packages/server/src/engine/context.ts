/**
 * Production BuildContext factory.
 *
 * Constructs a real BuildContext that wires together all orca modules:
 * - invoke.ts — the provider-neutral agent seam (Orca's own Layer B loop)
 * - eval.ts for subprocess evaluation
 * - git/index.ts for snapshots/reverts
 * - config/prompts.ts for prompt/schema resolution
 * - state/index.ts for persistence
 * - templates/index.ts for variable rendering
 * - scope/index.ts for file access enforcement
 */

import { existsSync, readFileSync } from "fs";
import { resolve, join } from "path";
import * as yaml from "js-yaml";
import type { OrcaConfig, EvalConfig, ScopeConfig, ResolvedTask } from "../config/schema";
import type { BuildState } from "../state";
import { saveState, saveArtifact } from "../state";
import type { BuildContext } from "./loop";
import type { Display } from "../display/types";
import { invokeSimple } from "./invoke";
import { runEval } from "./eval";
import { Git, GitError } from "../git";
import { resolvePrompt, resolveSchema, getSystemPrompt } from "../config/prompts";
import { buildTaskVars, applyVars, type TemplateVars } from "../templates";
import { PrintDisplay } from "../display/print";

export interface ContextOptions {
  config: OrcaConfig;
  configPath: string;
  display?: Display;
}

export function createBuildContext(options: ContextOptions): BuildContext {
  const { config, configPath } = options;
  const display = options.display ?? new PrintDisplay();
  const projectDir = resolve(configPath, "..", config.project_dir ?? ".");
  const stagesDir = resolve(configPath, "..", "stages");

  // Git
  let git: Git | null = null;
  if (config.git?.enabled) {
    try {
      git = new Git(projectDir);
    } catch (e) {
      if (e instanceof GitError) {
        console.error(`Git enabled but project is not a git repo: ${projectDir}`);
      }
    }
  }

  // Live config reload tracking
  let configMtimeNs: bigint | null = null;

  const ctx: BuildContext = {
    async invoke(label, opts) {
      const prompt = opts.prompt;

      // Log path: .orca/tasks/{taskId}/{label}.jsonl
      const taskId = opts.taskId || "_build";
      const logDir = join(projectDir, ".orca", "tasks", taskId);
      const logPath = join(logDir, `${label}.jsonl`);

      const result = await invokeSimple({
        prompt,
        projectDir,
        model: opts.model ?? config.model,
        toolset: opts.toolset as any,
        maxTurns: opts.maxTurns,
        outputSchema: resolveSchema(label, stagesDir, opts.taskId) ?? undefined,
        scope: opts.scope,
        sessionId: opts.sessionId,
        label,
        logPath,
      });

      return {
        output: result.output,
        costUsd: result.costUsd,
        sessionId: result.sessionId,
        numTurns: result.numTurns,
        durationMs: result.durationMs,
      };
    },

    async eval(evalConfig, taskId, vars) {
      return runEval(evalConfig, taskId, projectDir, vars);
    },

    async snapshot(message) {
      if (!git) return null;
      return git.snapshot(`[orca snapshot] ${message}`);
    },

    async revert(hash) {
      if (!git || !hash) return;
      await git.revert(hash);
    },

    async commit(message) {
      if (!git) return null;
      return git.snapshot(`[orca] ${message}`);
    },

    fileExists(path) {
      // Resolve relative to project dir
      const resolved = resolve(projectDir, path);
      return existsSync(resolved);
    },

    async loadPrompt(stageName, taskId) {
      return resolvePrompt(stageName, stagesDir, taskId);
    },

    async readLiveConfig() {
      try {
        const resolvedPath = resolve(configPath);
        const stat = Bun.file(resolvedPath);
        const mtime = BigInt(Math.floor(stat.lastModified));
        if (mtime === configMtimeNs) return null;
        configMtimeNs = mtime;

        const raw = readFileSync(resolvedPath, "utf8");
        const data = yaml.load(raw) as Record<string, unknown>;
        const orcaSection = data?.orca as Record<string, unknown> | undefined;
        if (!orcaSection) return null;

        return {
          max_iterations: orcaSection.max_iterations as number | undefined,
          max_cost: orcaSection.max_cost as number | undefined,
        };
      } catch {
        return null;
      }
    },

    display,
  };

  return ctx;
}
