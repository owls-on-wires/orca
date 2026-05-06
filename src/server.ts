/**
 * Orca serve — HTTP server for managing concurrent builds via REST + SSE.
 *
 * REST endpoints handle commands (start/stop/status builds).
 * SSE streams state updates and logs to connected clients.
 */

import { existsSync, readFileSync, mkdirSync, writeFileSync, watch } from "fs";
import { join, resolve, dirname } from "path";
import { randomUUID } from "crypto";
import * as yaml from "js-yaml";
import type { NixConfig, OrcaConfig, WorkflowConfig } from "./config/schema";
import { validateConfig } from "./config/loader";
import { buildNixCommand } from "./nix";
import { VERSION } from "./version";

// @ts-ignore — import with text type for compiled binary embedding
import dashboardHtml from "./web/dashboard.html" with { type: "text" };

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface BuildInfo {
  id: string;
  name: string;
  repoUrl: string;
  repoPath: string;
  specPath: string | null;
  process: ReturnType<typeof Bun.spawn> | null;
  status: "cloning" | "running" | "completed" | "failed";
  startedAt: string;
  exitCode: number | null;
  sseClients: Set<ReadableStreamDefaultController<Uint8Array>>;
  stdout: string[];
  stderr: string[];
  stateWatcher: ReturnType<typeof watch> | null;
  lastState: Record<string, unknown> | null;
}

export interface ServeOptions {
  port: number;
  dataDir: string;
}

// ---------------------------------------------------------------------------
// SSE helpers
// ---------------------------------------------------------------------------

function sseEvent(event: string, data: unknown): Uint8Array {
  const json = JSON.stringify(data);
  return new TextEncoder().encode(`event: ${event}\ndata: ${json}\n\n`);
}

function broadcastSSE(build: BuildInfo, event: string, data: unknown) {
  const encoded = sseEvent(event, data);
  for (const controller of build.sseClients) {
    try {
      controller.enqueue(encoded);
    } catch {
      build.sseClients.delete(controller);
    }
  }
}

// ---------------------------------------------------------------------------
// State enrichment — inject task list, workflow, logs, eval results
// ---------------------------------------------------------------------------

interface BuildConfigCache {
  taskIds: string[];
  workflow: WorkflowConfig | undefined;
  config: OrcaConfig;
}

const configCache = new Map<string, BuildConfigCache>();

function loadBuildConfigSync(build: BuildInfo): BuildConfigCache | null {
  if (configCache.has(build.id)) return configCache.get(build.id)!;

  const specPath = build.specPath;
  if (!specPath || !existsSync(specPath)) return null;

  try {
    const raw = readFileSync(specPath, "utf8");
    const data = yaml.load(raw);
    if (!validateConfig(data)) return null;
    const config = data as OrcaConfig;

    // loadTasks is async but for sync contexts, do inline resolution
    let taskIds: string[] = [];
    const tasks = config.tasks;
    let taskList: any[] = [];

    if (tasks.file) {
      const filePath = resolve(dirname(specPath), tasks.file);
      if (existsSync(filePath)) {
        const taskRaw = readFileSync(filePath, "utf8");
        const taskData = yaml.load(taskRaw);
        if (Array.isArray(taskData)) {
          taskList = taskData;
        } else if (taskData && typeof taskData === "object" && Array.isArray((taskData as any).list)) {
          taskList = (taskData as any).list;
        }
      }
    }
    if (tasks.list) {
      taskList = [...taskList, ...tasks.list];
    }
    taskIds = taskList.map((t: any) => t.id);

    const cache: BuildConfigCache = {
      taskIds,
      workflow: config.workflow,
      config,
    };
    configCache.set(build.id, cache);
    return cache;
  } catch {
    return null;
  }
}

function readRecentLog(orcaDir: string, taskId: string, stage?: string | null): unknown[] {
  if (!stage) return [];
  const logPath = join(orcaDir, "tasks", taskId, `${stage}.jsonl`);
  if (!existsSync(logPath)) return [];
  try {
    const content = readFileSync(logPath, "utf8");
    const lines = content.trim().split("\n").filter(Boolean);
    return lines.slice(-30).map(line => {
      try { return JSON.parse(line); } catch { return null; }
    }).filter(Boolean);
  } catch {
    return [];
  }
}

function readEvalResults(orcaDir: string, taskIds: string[]): Record<string, unknown> {
  const results: Record<string, unknown> = {};
  for (const taskId of taskIds) {
    const evalPath = join(orcaDir, "tasks", taskId, "eval_result.json");
    if (existsSync(evalPath)) {
      try {
        results[taskId] = JSON.parse(readFileSync(evalPath, "utf8"));
      } catch {}
    }
  }
  return results;
}

function enrichState(state: Record<string, unknown>, build: BuildInfo): Record<string, unknown> {
  const cache = loadBuildConfigSync(build);

  if (cache) {
    const stateTaskCount = Object.keys((state.tasks as any) || {}).length;
    state._pendingTasks = cache.taskIds;
    state._totalTasks = Math.max(cache.taskIds.length, stateTaskCount);
    state._workflow = cache.workflow;

    // Read eval results
    const orcaDir = join(build.repoPath, ".orca");
    const evalResults = readEvalResults(orcaDir, cache.taskIds);
    if (Object.keys(evalResults).length > 0) {
      state._evalResults = evalResults;
    }
  }

  // Recent log for current task
  const orcaDir = join(build.repoPath, ".orca");
  const currentTaskId = state.currentTaskId as string | undefined;
  if (currentTaskId) {
    const currentTask = (state.tasks as any)?.[currentTaskId];
    const currentStage = currentTask?.currentStage as string | undefined;
    state._recentLog = readRecentLog(orcaDir, currentTaskId, currentStage);
  }

  // Intervention
  const interventionPath = join(orcaDir, "intervention.json");
  if (existsSync(interventionPath)) {
    try {
      state._intervention = JSON.parse(readFileSync(interventionPath, "utf8"));
    } catch {}
  }

  return state;
}

// ---------------------------------------------------------------------------
// Build lifecycle
// ---------------------------------------------------------------------------

function cloneRepo(repoUrl: string, destPath: string): boolean {
  if (existsSync(destPath)) {
    // Pull instead of clone if already exists
    const result = Bun.spawnSync(["git", "pull"], {
      cwd: destPath,
      stdout: "pipe",
      stderr: "pipe",
    });
    return result.exitCode === 0;
  }

  mkdirSync(destPath, { recursive: true });
  const result = Bun.spawnSync(["git", "clone", repoUrl, destPath], {
    stdout: "pipe",
    stderr: "pipe",
  });
  return result.exitCode === 0;
}

function watchBuildState(build: BuildInfo) {
  const orcaDir = join(build.repoPath, ".orca");

  // Try to watch the .orca directory for state.json changes
  const tryWatch = () => {
    if (!existsSync(orcaDir)) return;

    try {
      build.stateWatcher = watch(orcaDir, { recursive: true }, (_eventType, filename) => {
        if (filename && filename.endsWith("state.json")) {
          // Read, enrich, and broadcast state
          const statePath = join(orcaDir, filename);
          try {
            if (existsSync(statePath)) {
              const state = JSON.parse(readFileSync(statePath, "utf8"));
              enrichState(state, build);
              build.lastState = state;
              broadcastSSE(build, "state", { buildId: build.id, state });
            }
          } catch {
            // Ignore parse errors during writes
          }
        }
      });
    } catch {
      // Watch not available, fall back to polling
    }
  };

  tryWatch();

  // If .orca dir doesn't exist yet, poll for it
  if (!build.stateWatcher) {
    const interval = setInterval(() => {
      if (existsSync(orcaDir)) {
        tryWatch();
        clearInterval(interval);
      }
      // Stop polling if build is done
      if (build.status === "completed" || build.status === "failed") {
        clearInterval(interval);
      }
    }, 1000);
  }
}

function loadNixConfig(specPath: string | null): NixConfig | undefined {
  if (!specPath || !existsSync(specPath)) return undefined;
  try {
    const raw = readFileSync(specPath, "utf8");
    const data = yaml.load(raw) as Record<string, unknown> | null;
    return data?.nix as NixConfig | undefined;
  } catch {
    return undefined;
  }
}

function resolveSpec(
  repoPath: string,
  opts: { spec?: string; spec_path?: string },
): { specPath: string | null; error: string | null } {
  if (opts.spec) {
    // Inline spec — write to project.orca.yaml
    const specPath = join(repoPath, "project.orca.yaml");
    try {
      writeFileSync(specPath, opts.spec);
    } catch (err) {
      return { specPath: null, error: `Failed to write spec: ${err}` };
    }
    return { specPath, error: null };
  }

  if (opts.spec_path) {
    // Verify spec_path exists in the cloned repo
    const specPath = join(repoPath, opts.spec_path);
    if (!existsSync(specPath)) {
      return { specPath: null, error: `Spec file not found: ${opts.spec_path}` };
    }
    return { specPath, error: null };
  }

  // Default: look for project.orca.yaml in repo root
  const defaultSpec = join(repoPath, "project.orca.yaml");
  if (existsSync(defaultSpec)) {
    return { specPath: defaultSpec, error: null };
  }

  return { specPath: null, error: "No spec found: project.orca.yaml not found in repo root" };
}

function extractSpecName(specPath: string): string | null {
  try {
    const raw = readFileSync(specPath, "utf8");
    const data = yaml.load(raw) as Record<string, unknown> | null;
    if (data && typeof data.name === "string") {
      return data.name;
    }
  } catch {
    // Malformed YAML — ignore, use default name
  }
  return null;
}

function spawnBuild(build: BuildInfo) {
  const innerArgs = ["orca", "run"];
  if (build.specPath) {
    innerArgs.push(build.specPath);
  }

  const nixConfig = loadNixConfig(build.specPath);
  const args = buildNixCommand(build.repoPath, nixConfig, innerArgs);

  build.status = "running";
  broadcastSSE(build, "status", { buildId: build.id, status: "running" });

  const proc = Bun.spawn(args, {
    cwd: build.repoPath,
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env },
  });

  build.process = proc;

  // Capture stdout
  if (proc.stdout) {
    const reader = proc.stdout.getReader();
    const decoder = new TextDecoder();
    (async () => {
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          const text = decoder.decode(value);
          build.stdout.push(text);
          broadcastSSE(build, "stdout", { buildId: build.id, text });
        }
      } catch {}
    })();
  }

  // Capture stderr
  if (proc.stderr) {
    const reader = proc.stderr.getReader();
    const decoder = new TextDecoder();
    (async () => {
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          const text = decoder.decode(value);
          build.stderr.push(text);
          broadcastSSE(build, "stderr", { buildId: build.id, text });
        }
      } catch {}
    })();
  }

  // Watch state files
  watchBuildState(build);

  // Wait for exit
  proc.exited.then((code) => {
    build.exitCode = code;
    build.status = code === 0 ? "completed" : "failed";

    broadcastSSE(build, "status", {
      buildId: build.id,
      status: build.status,
      exitCode: code,
    });

    // Cleanup watcher
    if (build.stateWatcher) {
      build.stateWatcher.close();
      build.stateWatcher = null;
    }
  });
}

// ---------------------------------------------------------------------------
// HTTP request handler
// ---------------------------------------------------------------------------

function createFetchHandler(builds: Map<string, BuildInfo>, dataDir: string) {
  return async function fetch(req: Request): Promise<Response> {
    const url = new URL(req.url);
    const method = req.method;

    const corsHeaders = {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
    };

    if (method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders });
    }

    // POST /builds — start a new build
    if (method === "POST" && url.pathname === "/builds") {
      let body: Record<string, unknown>;
      try {
        body = await req.json() as Record<string, unknown>;
      } catch {
        return Response.json({ error: "Invalid JSON body" }, { status: 400, headers: corsHeaders });
      }

      const mode = body.mode as string | undefined;
      const repoUrl = body.repo as string | undefined;
      const dirPath = body.dir as string | undefined;
      const name = body.name as string | undefined;
      const spec = body.spec as string | undefined;
      const spec_path = body.spec_path as string | undefined;

      // Validate mode field
      if (!mode) {
        return Response.json({ error: 'Missing required field: mode ("clone" or "local")' }, { status: 400, headers: corsHeaders });
      }

      if (mode !== "clone" && mode !== "local") {
        return Response.json({ error: 'Invalid mode: must be "clone" or "local"' }, { status: 400, headers: corsHeaders });
      }

      // Reject if both repo and dir are provided
      if (repoUrl && dirPath) {
        return Response.json({ error: "Cannot specify both repo and dir" }, { status: 400, headers: corsHeaders });
      }

      // Validate mode-specific required fields
      if (mode === "clone" && !repoUrl) {
        return Response.json({ error: "Missing required field: repo" }, { status: 400, headers: corsHeaders });
      }

      if (mode === "local" && !dirPath) {
        return Response.json({ error: "Missing required field: dir" }, { status: 400, headers: corsHeaders });
      }

      const useDir = mode === "local";
      const buildId = randomUUID().slice(0, 8);
      const repoPath = useDir ? dirPath! : join(dataDir, "builds", (name || buildId), "repo");

      if (useDir && !existsSync(repoPath)) {
        return Response.json({ error: `Directory not found: ${dirPath}` }, { status: 400, headers: corsHeaders });
      }

      const buildName = name || buildId;

      const build: BuildInfo = {
        id: buildId,
        name: buildName,
        repoUrl: repoUrl || dirPath!,
        repoPath,
        specPath: null,
        process: null,
        status: useDir ? "running" : "cloning",
        startedAt: new Date().toISOString(),
        exitCode: null,
        sseClients: new Set(),
        stdout: [],
        stderr: [],
        stateWatcher: null,
        lastState: null,
      };

      builds.set(buildId, build);

      // Resolve spec and spawn (clone first if repo mode)
      (async () => {
        if (!useDir) {
          broadcastSSE(build, "status", { buildId, status: "cloning" });

          const cloned = cloneRepo(repoUrl!, repoPath);
          if (!cloned) {
            build.status = "failed";
            broadcastSSE(build, "status", { buildId, status: "failed", error: "Clone failed" });
            return;
          }
        }

        // Resolve spec: inline > spec_path > default
        const resolved = resolveSpec(repoPath, { spec, spec_path });
        if (resolved.error) {
          build.status = "failed";
          broadcastSSE(build, "status", { buildId, status: "failed", error: resolved.error });
          return;
        }

        build.specPath = resolved.specPath!;

        // Extract build name from spec if no explicit name provided
        if (!name) {
          const specName = extractSpecName(build.specPath);
          if (specName) {
            build.name = specName;
          }
        }

        spawnBuild(build);
      })();

      return Response.json(
        { id: buildId, name: buildName, status: useDir ? "starting" : "cloning" },
        { status: 201, headers: corsHeaders },
      );
    }

    // GET /builds — list all builds
    if (method === "GET" && url.pathname === "/builds") {
      const list = Array.from(builds.values()).map((b) => ({
        id: b.id,
        name: b.name,
        status: b.status,
        startedAt: b.startedAt,
        exitCode: b.exitCode,
        repoUrl: b.repoUrl,
      }));
      return Response.json(list, { headers: corsHeaders });
    }

    // GET /builds/:id — get build details
    const buildMatch = url.pathname.match(/^\/builds\/([^/]+)$/);
    if (method === "GET" && buildMatch) {
      const build = builds.get(buildMatch[1]);
      if (!build) {
        return Response.json({ error: "Build not found" }, { status: 404, headers: corsHeaders });
      }

      // Re-enrich lastState with fresh log/eval data
      let enrichedState = build.lastState;
      if (enrichedState) {
        enrichedState = enrichState({ ...enrichedState }, build);
      }

      return Response.json({
        id: build.id,
        name: build.name,
        status: build.status,
        startedAt: build.startedAt,
        exitCode: build.exitCode,
        repoUrl: build.repoUrl,
        repoPath: build.repoPath,
        lastState: enrichedState,
        stdoutLines: build.stdout.length,
        stderrLines: build.stderr.length,
      }, { headers: corsHeaders });
    }

    // DELETE /builds/:id — stop a build
    const deleteMatch = url.pathname.match(/^\/builds\/([^/]+)$/);
    if (method === "DELETE" && deleteMatch) {
      const build = builds.get(deleteMatch[1]);
      if (!build) {
        return Response.json({ error: "Build not found" }, { status: 404, headers: corsHeaders });
      }

      if (build.process && build.status === "running") {
        build.process.kill("SIGTERM");
      }

      return Response.json({ id: build.id, status: "stopping" }, { headers: corsHeaders });
    }

    // GET /builds/:id/logs — get captured output
    const logsMatch = url.pathname.match(/^\/builds\/([^/]+)\/logs$/);
    if (method === "GET" && logsMatch) {
      const build = builds.get(logsMatch[1]);
      if (!build) {
        return Response.json({ error: "Build not found" }, { status: 404, headers: corsHeaders });
      }
      return Response.json({
        stdout: build.stdout,
        stderr: build.stderr,
      }, { headers: corsHeaders });
    }

    // GET /builds/:id/events — SSE stream
    const eventsMatch = url.pathname.match(/^\/builds\/([^/]+)\/events$/);
    if (method === "GET" && eventsMatch) {
      const build = builds.get(eventsMatch[1]);
      if (!build) {
        return Response.json({ error: "Build not found" }, { status: 404, headers: corsHeaders });
      }

      let sseController: ReadableStreamDefaultController<Uint8Array>;
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          sseController = controller;
          build.sseClients.add(controller);

          // Send current state immediately
          controller.enqueue(sseEvent("status", {
            buildId: build.id,
            status: build.status,
          }));

          if (build.lastState) {
            const freshState = enrichState({ ...build.lastState }, build);
            controller.enqueue(sseEvent("state", {
              buildId: build.id,
              state: freshState,
            }));
          }
        },
        cancel() {
          build.sseClients.delete(sseController);
        },
      });

      return new Response(stream, {
        headers: {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
          Connection: "keep-alive",
          ...corsHeaders,
        },
      });
    }

    // POST /builds/:id/intervene — handle intervention response
    const interveneMatch = url.pathname.match(/^\/builds\/([^/]+)\/intervene$/);
    if (method === "POST" && interveneMatch) {
      const build = builds.get(interveneMatch[1]);
      if (!build) {
        return Response.json({ error: "Build not found" }, { status: 404, headers: corsHeaders });
      }

      let body: Record<string, unknown>;
      try {
        body = await req.json() as Record<string, unknown>;
      } catch {
        return Response.json({ error: "Invalid JSON body" }, { status: 400, headers: corsHeaders });
      }

      const action = body.action as string | undefined;
      if (!action || !["continue", "skip", "abort"].includes(action)) {
        return Response.json({ error: "Invalid action. Must be: continue, skip, or abort" }, { status: 400, headers: corsHeaders });
      }

      // Write intervention_response.json to the build's .orca/ directory
      const orcaDir = join(build.repoPath, ".orca");
      try {
        if (!existsSync(orcaDir)) {
          mkdirSync(orcaDir, { recursive: true });
        }
        writeFileSync(
          join(orcaDir, "intervention_response.json"),
          JSON.stringify({ action, note: body.note || undefined }),
        );
      } catch (err) {
        return Response.json(
          { error: `Failed to write intervention response: ${err}` },
          { status: 500, headers: corsHeaders },
        );
      }

      // Broadcast intervention response to SSE clients
      broadcastSSE(build, "intervention_response", {
        buildId: build.id,
        action,
        note: body.note || null,
      });

      return Response.json({ id: build.id, action }, { headers: corsHeaders });
    }

    // GET /health — health check
    if (url.pathname === "/health") {
      return Response.json({
        status: "ok",
        version: VERSION,
        builds: builds.size,
        uptime: process.uptime(),
      }, { headers: corsHeaders });
    }

    // GET / — serve dashboard
    if (method === "GET" && url.pathname === "/") {
      return new Response(dashboardHtml as unknown as string, {
        headers: {
          "Content-Type": "text/html; charset=utf-8",
          "Cache-Control": "no-store",
        },
      });
    }

    return Response.json({ error: "Not found" }, { status: 404, headers: corsHeaders });
  };
}

// ---------------------------------------------------------------------------
// Graceful shutdown
// ---------------------------------------------------------------------------

async function gracefulShutdown(
  builds: Map<string, BuildInfo>,
  server: ReturnType<typeof Bun.serve>,
) {
  if (!process.env.ORCA_TEST) console.log("\norca serve: shutting down...");

  // SIGTERM all child processes
  for (const build of builds.values()) {
    if (build.process && build.status === "running") {
      build.process.kill("SIGTERM");
    }
    if (build.stateWatcher) {
      build.stateWatcher.close();
    }
    // Close SSE connections
    for (const controller of build.sseClients) {
      try { controller.close(); } catch {}
    }
  }

  // Wait for children to exit (up to 10 seconds)
  const runningBuilds = Array.from(builds.values()).filter(
    (b) => b.process && b.status === "running",
  );

  if (runningBuilds.length > 0) {
    await Promise.race([
      Promise.all(runningBuilds.map((b) => b.process!.exited)),
      Bun.sleep(10000),
    ]);
  }

  server.stop();
  if (!process.env.ORCA_TEST) console.log("orca serve: stopped");
}

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

export function startServer(options: ServeOptions): {
  server: ReturnType<typeof Bun.serve>;
  builds: Map<string, BuildInfo>;
  shutdown: () => Promise<void>;
} {
  const { port, dataDir } = options;
  const builds = new Map<string, BuildInfo>();

  // Ensure data directory exists
  mkdirSync(dataDir, { recursive: true });

  const server = Bun.serve({
    port,
    fetch: createFetchHandler(builds, dataDir),
  });

  const shutdown = () => gracefulShutdown(builds, server);

  // Register signal handlers (only when not in test mode)
  if (!process.env.ORCA_TEST) {
    process.on("SIGTERM", () => {
      shutdown().then(() => process.exit(0));
    });
    process.on("SIGINT", () => {
      shutdown().then(() => process.exit(0));
    });

    console.log(`\norca serve: listening on http://localhost:${port}`);
    console.log(`  Data dir: ${dataDir}`);
    console.log(`  Endpoints:`);
    console.log(`    GET    /                       — dashboard`);
    console.log(`    POST   /builds                 — start a build (requires mode: "clone" or "local")`);
    console.log(`    GET    /builds                 — list builds`);
    console.log(`    GET    /builds/:id             — build details`);
    console.log(`    DELETE /builds/:id             — stop a build`);
    console.log(`    GET    /builds/:id/logs        — build output`);
    console.log(`    GET    /builds/:id/events      — SSE stream`);
    console.log(`    POST   /builds/:id/intervene   — intervention response`);
    console.log(`    GET    /health                 — health check\n`);
  }

  return { server, builds, shutdown };
}
