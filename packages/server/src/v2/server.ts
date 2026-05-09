/**
 * Action-centric HTTP server — Bun.serve() with REST endpoints.
 * Standalone: bun run src/v2/server.ts --port 7072 --db /path/to/db
 */

import { OrcaDatabase } from "./db";
import { expandConfig } from "./config";
import { Executor, type ExecutorOptions } from "./executor";
import { runAction } from "./action-runner";
import type {
  ActionConfig,
  ActionStatus,
  EdgeCondition,
  ActionTypeDefaults,
} from "./schema";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ServerOptions {
  port?: number;
  dbPath?: string;
  db?: OrcaDatabase;
  executor?: Executor;
  /** If true, don't start executor loop automatically */
  noExecutor?: boolean;
}

// SSE event types
export type SSEEventType =
  | "action_started"
  | "action_completed"
  | "action_waiting"
  | "edge_traversed"
  | "executor_state";

export interface SSEClient {
  controller: ReadableStreamDefaultController;
  actionFilter?: string; // if set, only events for this action
}

interface ServerState {
  db: OrcaDatabase;
  executor: Executor | null;
  executorState: "running" | "paused" | "idle";
  typeDefaults: Record<string, ActionTypeDefaults>;
  startTime: number;
  sseClients: Set<SSEClient>;
}

// ---------------------------------------------------------------------------
// CORS + JSON helpers
// ---------------------------------------------------------------------------

const CORS_HEADERS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, PATCH, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json", ...CORS_HEADERS },
  });
}

function jsonError(error: string, status = 400): Response {
  return json({ error }, status);
}

async function parseBody(req: Request): Promise<unknown> {
  try {
    return await req.json();
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// SSE helpers
// ---------------------------------------------------------------------------

function sseEvent(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

export function broadcast(state: ServerState, event: SSEEventType, data: Record<string, unknown>, actionId?: string): void {
  const encoded = new TextEncoder().encode(sseEvent(event, data));
  const toRemove: SSEClient[] = [];

  for (const client of state.sseClients) {
    // Per-action filtering: skip if client has a filter and this event doesn't match
    if (client.actionFilter && actionId && client.actionFilter !== actionId) continue;

    try {
      client.controller.enqueue(encoded);
    } catch {
      toRemove.push(client);
    }
  }

  for (const client of toRemove) {
    state.sseClients.delete(client);
  }
}

function startHeartbeat(state: ServerState): ReturnType<typeof setInterval> {
  return setInterval(() => {
    const comment = new TextEncoder().encode(": heartbeat\n\n");
    const toRemove: SSEClient[] = [];

    for (const client of state.sseClients) {
      try {
        client.controller.enqueue(comment);
      } catch {
        toRemove.push(client);
      }
    }

    for (const client of toRemove) {
      state.sseClients.delete(client);
    }
  }, 30_000);
}

// ---------------------------------------------------------------------------
// Route matching
// ---------------------------------------------------------------------------

type RouteHandler = (
  req: Request,
  state: ServerState,
  params: Record<string, string>,
) => Promise<Response> | Response;

interface Route {
  method: string;
  pattern: RegExp;
  paramNames: string[];
  handler: RouteHandler;
}

function defineRoute(
  method: string,
  path: string,
  handler: RouteHandler,
): Route {
  const paramNames: string[] = [];
  const patternStr = path.replace(/:(\w+)/g, (_, name) => {
    paramNames.push(name);
    return "([^/]+)";
  });
  return {
    method,
    pattern: new RegExp(`^${patternStr}$`),
    paramNames,
    handler,
  };
}

// ---------------------------------------------------------------------------
// Route handlers
// ---------------------------------------------------------------------------

// POST /import
async function handleImport(
  req: Request,
  state: ServerState,
): Promise<Response> {
  const body = (await parseBody(req)) as Record<string, unknown> | null;
  if (!body) return jsonError("Invalid JSON body");

  let yamlString: string | undefined;
  let sourceDir: string | undefined;

  if (typeof body.dir === "string") {
    const { readFileSync, existsSync } = await import("fs");
    const { resolve, join } = await import("path");
    const dir = resolve(body.dir as string);
    const specName = (body.spec_path as string) || "project.orca.yaml";
    const specPath = join(dir, specName);
    if (!existsSync(specPath)) return jsonError(`Config not found: ${specPath}`);
    yamlString = readFileSync(specPath, "utf8");
    sourceDir = dir;
  } else if (typeof body.yaml === "string") {
    yamlString = body.yaml;
    sourceDir = typeof body.source_dir === "string" ? body.source_dir : undefined;
  } else if (body.config) {
    const yaml = await import("js-yaml");
    yamlString = yaml.dump(body.config);
  } else if (typeof body.template === "string" && typeof body.project === "string") {
    const resolved = await resolveTemplate(body.project as string, body.template as string, body.tasks as any[], state.db);
    if (typeof resolved === "string") return jsonError(resolved);
    yamlString = resolved.yaml;
  }

  if (!yamlString) return jsonError("Body must include 'dir', 'yaml', 'config', or 'template'+'project'+'tasks'");

  try {
    expandConfig(yamlString, state.db, sourceDir);
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    return jsonError(msg);
  }

  const actions = state.db.listActions();
  const actionIds = actions.map((a) => a.id);

  let edgeCount = 0;
  for (const a of actions) {
    edgeCount += state.db.getEdgesFrom(a.id).length;
  }

  return json({ actions: actionIds, edges: edgeCount });
}

async function resolveTemplate(
  projectId: string,
  templateName: string,
  tasks: Array<{ id: string; prompt: string; actions?: string[]; depends_on?: string[]; tags?: string[] }>,
  db: OrcaDatabase,
): Promise<{ yaml: string } | string> {
  const { readFileSync, existsSync } = await import("fs");
  const { resolve, join } = await import("path");
  const yaml = await import("js-yaml");

  const project = db.getProject(projectId);
  if (!project) return `Project not found: ${projectId}`;

  if (!tasks || !Array.isArray(tasks) || tasks.length === 0) {
    return "Missing or empty 'tasks' array";
  }

  // Read the project's orca yaml to find templates
  const orcaPath = join(resolve(project.project_dir), "project.orca.yaml");
  if (!existsSync(orcaPath)) return `Project config not found: ${orcaPath}`;

  const orcaYaml = readFileSync(orcaPath, "utf8");
  const orcaConfig = yaml.load(orcaYaml) as Record<string, unknown>;
  const templates = orcaConfig.templates as Record<string, unknown> | undefined;

  if (!templates || !templates[templateName]) {
    return `Template "${templateName}" not found in ${orcaPath}`;
  }

  // Tag each task with the template name
  const taggedTasks = tasks.map(t => ({ ...t, template: templateName }));

  const merged = {
    name: projectId,
    project_dir: project.project_dir,
    defaults: orcaConfig.defaults,
    templates,
    tasks: taggedTasks,
  };

  return { yaml: yaml.dump(merged) };
}

// GET /actions
function handleListActions(
  req: Request,
  state: ServerState,
): Response {
  const url = new URL(req.url);
  const tag = url.searchParams.get("tag") ?? undefined;
  const status = url.searchParams.get("status") as ActionStatus | undefined;
  const type = url.searchParams.get("type") ?? undefined;

  const actions = state.db.listActions({
    tag,
    status: status || undefined,
    type: type || undefined,
  });
  return json(actions);
}

// GET /actions/:id
function handleGetAction(
  _req: Request,
  state: ServerState,
  params: Record<string, string>,
): Response {
  const action = state.db.getAction(params.id);
  if (!action) return jsonError("Action not found", 404);

  const edgesFrom = state.db.getEdgesFrom(params.id);
  const edgesTo = state.db.getEdgesTo(params.id);
  const history = state.db.getHistory(params.id);

  return json({
    action,
    edges: { from: edgesFrom, to: edgesTo },
    history,
  });
}

// PATCH /actions/:id
async function handleUpdateAction(
  req: Request,
  state: ServerState,
  params: Record<string, string>,
): Promise<Response> {
  const action = state.db.getAction(params.id);
  if (!action) return jsonError("Action not found", 404);

  const body = (await parseBody(req)) as Record<string, unknown> | null;
  if (!body) return jsonError("Invalid JSON body");

  const updates: Partial<ActionConfig> = {};
  if (body.params !== undefined) updates.params = body.params as Record<string, unknown>;
  if (body.tags !== undefined) updates.tags = body.tags as string[];
  if (body.status !== undefined) updates.status = body.status as ActionStatus;

  state.db.updateAction(params.id, updates);
  const updated = state.db.getAction(params.id)!;
  return json(updated);
}

// DELETE /actions/:id
function handleDeleteAction(
  _req: Request,
  state: ServerState,
  params: Record<string, string>,
): Response {
  const action = state.db.getAction(params.id);
  if (!action) return jsonError("Action not found", 404);

  state.db.deleteAction(params.id);
  return json({ deleted: true });
}

// POST /actions/:id/retry
function handleRetry(
  _req: Request,
  state: ServerState,
  params: Record<string, string>,
): Response {
  const action = state.db.getAction(params.id);
  if (!action) return jsonError("Action not found", 404);

  state.db.updateAction(params.id, {
    status: "pending",
    output: null,
    iteration: action.iteration + 1,
    started_at: null,
    completed_at: null,
  });

  return json({ status: "pending" });
}

// POST /actions/:id/skip
function handleSkip(
  _req: Request,
  state: ServerState,
  params: Record<string, string>,
): Response {
  const action = state.db.getAction(params.id);
  if (!action) return jsonError("Action not found", 404);

  state.db.updateAction(params.id, { status: "skipped" });
  return json({ status: "skipped" });
}

// POST /actions/:id/respond
async function handleRespond(
  req: Request,
  state: ServerState,
  params: Record<string, string>,
): Promise<Response> {
  const action = state.db.getAction(params.id);
  if (!action) return jsonError("Action not found", 404);
  if (action.status !== "waiting") return jsonError("Action is not waiting", 400);

  const body = (await parseBody(req)) as Record<string, unknown> | null;
  if (!body) return jsonError("Invalid JSON body");

  const output = {
    status: (body.status as string) ?? "completed",
    summary: (body.summary as string) ?? "",
    ...(body.notes ? { notes: body.notes as string } : {}),
  };

  let condition: string = "pass";

  if (state.executor) {
    // Use executor to complete the action and follow edges
    condition = state.executor.completeWaitingAction(params.id, output);

    // Signal the executor loop to wake up
    if (state.executor.isIdle()) {
      state.executorState = "running";
      state.executor.resume();
      kickExecutor(state);
    }
  } else {
    // No executor — just update DB directly
    state.db.updateAction(params.id, {
      status: "completed",
      output,
      completed_at: new Date().toISOString(),
    });
  }

  return json({ status: "completed", condition });
}

// PATCH /actions (bulk update by tag)
async function handleBulkUpdate(
  req: Request,
  state: ServerState,
): Promise<Response> {
  const url = new URL(req.url);
  const tag = url.searchParams.get("tag");
  if (!tag) return jsonError("Query param 'tag' is required");

  const body = (await parseBody(req)) as Record<string, unknown> | null;
  if (!body) return jsonError("Invalid JSON body");

  const updates: Partial<ActionConfig> = {};
  if (body.params !== undefined) updates.params = body.params as Record<string, unknown>;
  if (body.tags !== undefined) updates.tags = body.tags as string[];
  if (body.status !== undefined) updates.status = body.status as ActionStatus;

  const count = state.db.updateActionsByTag(tag, updates);
  return json({ updated: count });
}

// POST /edges
async function handleCreateEdge(
  req: Request,
  state: ServerState,
): Promise<Response> {
  const body = (await parseBody(req)) as Record<string, unknown> | null;
  if (!body) return jsonError("Invalid JSON body");

  const from_action = body.from_action as string;
  const to_action = body.to_action as string;
  const condition = body.condition as EdgeCondition;

  if (!from_action || !to_action || !condition) {
    return jsonError("Body must include from_action, to_action, and condition");
  }

  const id = state.db.insertEdge({ from_action, to_action, condition });
  return json({ id, from_action, to_action, condition });
}

// DELETE /edges/:id
function handleDeleteEdge(
  _req: Request,
  state: ServerState,
  params: Record<string, string>,
): Response {
  const id = parseInt(params.id, 10);
  if (isNaN(id)) return jsonError("Invalid edge ID");

  state.db.deleteEdge(id);
  return json({ deleted: true });
}

// GET /defaults
function handleGetDefaults(
  _req: Request,
  state: ServerState,
): Response {
  return json(state.typeDefaults);
}

// PATCH /defaults
async function handleUpdateDefaults(
  req: Request,
  state: ServerState,
): Promise<Response> {
  const body = (await parseBody(req)) as Record<string, unknown> | null;
  if (!body) return jsonError("Invalid JSON body");

  // Merge into existing defaults
  for (const [key, value] of Object.entries(body)) {
    state.typeDefaults[key] = value as ActionTypeDefaults;
  }

  return json(state.typeDefaults);
}

// POST /executor/pause
function handleExecutorPause(
  _req: Request,
  state: ServerState,
): Response {
  if (state.executor) {
    state.executor.pause();
    state.executorState = "paused";
  }
  return json({ state: state.executorState });
}

// POST /executor/resume
function handleExecutorResume(
  _req: Request,
  state: ServerState,
): Response {
  if (state.executor) {
    state.executor.resume();
    state.executorState = "running";
    // Signal the executor loop to wake up — don't call run() here
    kickExecutor(state);
  }
  return json({ state: state.executorState });
}

// GET /executor/status
function handleExecutorStatus(
  _req: Request,
  state: ServerState,
): Response {
  const actions = state.db.listActions();
  const pending = actions.filter((a) => a.status === "pending").length;
  const running = actions.filter((a) => a.status === "running");
  const activeAction = running.length > 0 ? running[0].id : null;

  return json({
    state: state.executorState,
    active_action: activeAction,
    pending,
    total: actions.length,
  });
}

// GET /health
function buildStats(state: ServerState) {
  const actions = state.db.listActions();
  const statusCounts: Record<string, number> = {};
  let totalCost = 0;
  for (const a of actions) {
    statusCounts[a.status] = (statusCounts[a.status] ?? 0) + 1;
    totalCost += a.cost_usd;
  }

  return {
    version: "2.0.0",
    uptime: Math.floor((Date.now() - state.startTime) / 1000),
    executor: state.executorState,
    actions: {
      total: actions.length,
      ...statusCounts,
    },
    total_cost_usd: Math.round(totalCost * 100) / 100,
  };
}

function handleHealth(
  _req: Request,
  state: ServerState,
): Response {
  return json(buildStats(state));
}

// GET / — placeholder (dashboard served by separate web package)
function handleRoot(): Response {
  return new Response(
    `<html><body style="background:#0d1117;color:#e6edf3;font-family:monospace;padding:40px">
      <h1>Orca v2 API</h1>
      <p>API is running. Dashboard is served separately.</p>
      <p><a href="/health" style="color:#58a6ff">/health</a></p>
    </body></html>`,
    { headers: { "Content-Type": "text/html; charset=utf-8", ...CORS_HEADERS } },
  );
}

// GET /events — global SSE stream
function handleSSE(
  _req: Request,
  state: ServerState,
): Response {
  const stream = new ReadableStream({
    start(controller) {
      const client: SSEClient = { controller };
      state.sseClients.add(client);
      // Send initial connection event
      controller.enqueue(new TextEncoder().encode(sseEvent("connected", { timestamp: new Date().toISOString() })));
    },
    cancel() {
      // Client disconnected — cleanup happens on next broadcast write failure
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
      ...CORS_HEADERS,
    },
  });
}

// GET /actions/:id/events — per-action SSE stream
function handleActionSSE(
  _req: Request,
  state: ServerState,
  params: Record<string, string>,
): Response {
  const actionId = params.id;
  const action = state.db.getAction(actionId);
  if (!action) return jsonError("Action not found", 404);

  const stream = new ReadableStream({
    start(controller) {
      const client: SSEClient = { controller, actionFilter: actionId };
      state.sseClients.add(client);
      controller.enqueue(new TextEncoder().encode(sseEvent("connected", { action_id: actionId, timestamp: new Date().toISOString() })));
    },
    cancel() {
      // cleanup on next write failure
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
      ...CORS_HEADERS,
    },
  });
}

// ---------------------------------------------------------------------------
// Route table
// ---------------------------------------------------------------------------

const routes: Route[] = [
  defineRoute("POST", "/import", handleImport),
  defineRoute("GET", "/events", handleSSE),
  defineRoute("GET", "/actions", handleListActions),
  defineRoute("PATCH", "/actions", handleBulkUpdate),
  defineRoute("GET", "/actions/:id/events", handleActionSSE),
  defineRoute("GET", "/actions/:id", handleGetAction),
  defineRoute("PATCH", "/actions/:id", handleUpdateAction),
  defineRoute("DELETE", "/actions/:id", handleDeleteAction),
  defineRoute("POST", "/actions/:id/retry", handleRetry),
  defineRoute("POST", "/actions/:id/skip", handleSkip),
  defineRoute("POST", "/actions/:id/respond", handleRespond),
  defineRoute("POST", "/edges", handleCreateEdge),
  defineRoute("DELETE", "/edges/:id", handleDeleteEdge),
  defineRoute("GET", "/defaults", handleGetDefaults),
  defineRoute("PATCH", "/defaults", handleUpdateDefaults),
  defineRoute("POST", "/executor/pause", handleExecutorPause),
  defineRoute("POST", "/executor/resume", handleExecutorResume),
  defineRoute("GET", "/executor/status", handleExecutorStatus),
  defineRoute("GET", "/health", handleHealth),
];

// ---------------------------------------------------------------------------
// Executor run loop — runs independently of HTTP request lifecycle
// ---------------------------------------------------------------------------

let executorRunning = false;

async function runExecutorLoop(state: ServerState) {
  if (executorRunning || !state.executor) return;
  executorRunning = true;
  try {
    await state.executor.run();
  } finally {
    executorRunning = false;
    state.executorState = "idle";
  }
}

function kickExecutor(state: ServerState) {
  if (executorRunning) return;
  queueMicrotask(() => runExecutorLoop(state));
}

// ---------------------------------------------------------------------------
// Server
// ---------------------------------------------------------------------------

export function startServer(options: ServerOptions = {}) {
  const port = options.port ?? 7072;
  const db = options.db ?? new OrcaDatabase(options.dbPath ?? ":memory:");

  const sseClients = new Set<SSEClient>();

  let executor: Executor | null = options.executor ?? null;
  let executorState: "running" | "paused" | "idle" = "idle";

  const state: ServerState = {
    db,
    executor,
    executorState,
    typeDefaults: {},
    startTime: Date.now(),
    sseClients,
  };

  if (!options.noExecutor && !executor) {
    executor = new Executor(db, {
      projectDir: ".",
      runActionFn: runAction,
      onActionStart: (action) => {
        broadcast(state, "action_started", { action_id: action.id, type: action.type }, action.id);
        broadcast(state, "stats", buildStats(state));
      },
      onActionEnd: (action, result) => {
        broadcast(state, "action_completed", {
          action_id: action.id,
          condition: result.condition,
          cost_usd: result.cost_usd,
        }, action.id);
        broadcast(state, "stats", buildStats(state));
      },
      onActionWaiting: (action) => {
        broadcast(state, "action_waiting", { action_id: action.id }, action.id);
      },
      onEdgeTraversed: (from, to, condition) => {
        broadcast(state, "edge_traversed", { from, to, condition });
      },
      onIdle: () => {
        broadcast(state, "executor_state", { state: "idle", pending_count: 0 });
        broadcast(state, "stats", buildStats(state));
      },
    });
    state.executor = executor;
    // Start executor loop on next tick — fully decoupled from server startup
    executorState = "running";
    kickExecutor(state);
  }

  // Make executorState a proxy via getter/setter
  Object.defineProperty(state, "executorState", {
    get: () => executorState,
    set: (v: string) => { executorState = v as "running" | "paused" | "idle"; },
    enumerable: true,
  });

  const heartbeatInterval = startHeartbeat(state);

  const server = Bun.serve({
    port,
    fetch: async (req) => {
      // Handle CORS preflight
      if (req.method === "OPTIONS") {
        return new Response(null, { status: 204, headers: CORS_HEADERS });
      }

      const url = new URL(req.url);
      const path = url.pathname;

      // Root
      if (path === "/" && req.method === "GET") {
        return handleRoot();
      }

      // Match routes
      for (const route of routes) {
        if (req.method !== route.method) continue;
        const match = path.match(route.pattern);
        if (!match) continue;

        const params: Record<string, string> = {};
        for (let i = 0; i < route.paramNames.length; i++) {
          params[route.paramNames[i]] = decodeURIComponent(match[i + 1]);
        }

        try {
          return await route.handler(req, state, params);
        } catch (e: unknown) {
          const msg = e instanceof Error ? e.message : String(e);
          return jsonError(msg, 500);
        }
      }

      return jsonError("Not found", 404);
    },
  });

  return { server, db, state, heartbeatInterval };
}

// ---------------------------------------------------------------------------
// CLI entry point
// ---------------------------------------------------------------------------

if (import.meta.main) {
  const args = process.argv.slice(2);
  let port = 7072;
  const home = process.env.HOME || process.env.USERPROFILE || ".";
  let dbPath = `${home}/.orca/orca.db`;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--port" && args[i + 1]) {
      port = parseInt(args[i + 1], 10);
      i++;
    } else if (args[i] === "--db" && args[i + 1]) {
      dbPath = args[i + 1];
      i++;
    }
  }

  const { server } = startServer({ port, dbPath });
  console.log(`Orca v2 server listening on http://localhost:${server.port}`);
}
