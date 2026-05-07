/**
 * Action-centric HTTP server — Bun.serve() with REST endpoints.
 * Standalone: bun run src/v2/server.ts --port 7072 --db /path/to/db
 */

import { OrcaDatabase } from "./db";
import { expandConfig } from "./config";
import { Executor, type ExecutorOptions } from "./executor";
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

interface ServerState {
  db: OrcaDatabase;
  executor: Executor | null;
  executorState: "running" | "paused" | "idle";
  typeDefaults: Record<string, ActionTypeDefaults>;
  startTime: number;
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
  if (typeof body.yaml === "string") {
    yamlString = body.yaml;
  } else if (body.config) {
    // Serialize config object to YAML-like JSON — expandConfig expects YAML
    // but accepts anything js-yaml can parse, so we pass it as YAML via JSON
    const yaml = await import("js-yaml");
    yamlString = yaml.dump(body.config);
  }

  if (!yamlString) return jsonError("Body must include 'yaml' string or 'config' object");

  try {
    expandConfig(yamlString, state.db);
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    return jsonError(msg);
  }

  const actions = state.db.listActions();
  const actionIds = actions.map((a) => a.id);

  // Count edges
  let edgeCount = 0;
  for (const a of actions) {
    edgeCount += state.db.getEdgesFrom(a.id).length;
  }

  return json({ actions: actionIds, edges: edgeCount });
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

  state.db.updateAction(params.id, {
    status: "completed",
    output,
    completed_at: new Date().toISOString(),
  });

  return json({ status: "completed" });
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
    // Re-start the executor loop in background
    state.executor.run().then(() => {
      state.executorState = "idle";
    });
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
function handleHealth(
  _req: Request,
  state: ServerState,
): Response {
  const actions = state.db.listActions();
  const statusCounts: Record<string, number> = {};
  for (const a of actions) {
    statusCounts[a.status] = (statusCounts[a.status] ?? 0) + 1;
  }

  return json({
    version: "2.0.0",
    uptime: Math.floor((Date.now() - state.startTime) / 1000),
    actions: {
      total: actions.length,
      ...statusCounts,
    },
  });
}

// GET /
function handleRoot(): Response {
  const html = `<!DOCTYPE html>
<html><head><title>Orca v2</title></head>
<body><h1>Orca v2 Server</h1><p>API server running.</p></body>
</html>`;
  return new Response(html, {
    headers: { "Content-Type": "text/html", ...CORS_HEADERS },
  });
}

// ---------------------------------------------------------------------------
// Route table
// ---------------------------------------------------------------------------

const routes: Route[] = [
  defineRoute("POST", "/import", handleImport),
  defineRoute("GET", "/actions", handleListActions),
  defineRoute("PATCH", "/actions", handleBulkUpdate),
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
// Server
// ---------------------------------------------------------------------------

export function startServer(options: ServerOptions = {}) {
  const port = options.port ?? 7072;
  const db = options.db ?? new OrcaDatabase(options.dbPath ?? ":memory:");

  let executor: Executor | null = options.executor ?? null;
  let executorState: "running" | "paused" | "idle" = "idle";

  if (!options.noExecutor && !executor) {
    executor = new Executor(db, {
      projectDir: ".",
      runActionFn: async () => ({
        condition: "pass" as EdgeCondition,
        output: { status: "pass", summary: "noop" },
        cost_usd: 0,
        duration_ms: 0,
        num_turns: 0,
      }),
    });
    // Start executor loop in background
    executorState = "running";
    executor.run().then(() => {
      executorState = "idle";
    });
  }

  const state: ServerState = {
    db,
    executor,
    executorState,
    typeDefaults: {},
    startTime: Date.now(),
  };

  // Make executorState a proxy via getter/setter
  Object.defineProperty(state, "executorState", {
    get: () => executorState,
    set: (v: string) => { executorState = v as "running" | "paused" | "idle"; },
    enumerable: true,
  });

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

  return { server, db, state };
}

// ---------------------------------------------------------------------------
// CLI entry point
// ---------------------------------------------------------------------------

if (import.meta.main) {
  const args = process.argv.slice(2);
  let port = 7072;
  let dbPath = ".orca/orca.db";

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
