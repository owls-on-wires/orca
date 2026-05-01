/**
 * Integration tests for orca serve — HTTP endpoints and SSE streaming.
 *
 * Each test starts a real server on a random port, hits real endpoints,
 * and verifies responses. No mocks.
 */

import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { startServer, type ServeOptions } from "./server";

// Suppress signal handlers and console output in tests
process.env.ORCA_TEST = "1";

let dataDir: string;
let server: ReturnType<typeof startServer>;
let baseUrl: string;

function createFixtureRepo(parentDir: string): string {
  const repoDir = join(parentDir, "fixture-repo");
  mkdirSync(repoDir, { recursive: true });

  // Init a minimal git repo
  Bun.spawnSync(["git", "init"], { cwd: repoDir, stdout: "pipe", stderr: "pipe" });
  Bun.spawnSync(["git", "config", "user.email", "test@test"], { cwd: repoDir, stdout: "pipe", stderr: "pipe" });
  Bun.spawnSync(["git", "config", "user.name", "Test"], { cwd: repoDir, stdout: "pipe", stderr: "pipe" });

  writeFileSync(join(repoDir, "README.md"), "test");
  writeFileSync(join(repoDir, "project.orca.yaml"), [
    "name: test-build",
    "project_dir: .",
    "model: sonnet",
    "eval:",
    '  command: "true"',
    "  parser: exit_code",
    "workflow:",
    "  loop: [eval]",
    "budget:",
    "  max_iterations: 1",
    "  max_cost: 1.0",
    "tasks:",
    "  list:",
    "    - id: t1",
    '      title: "Test task"',
    "      depends_on: []",
  ].join("\n"));

  Bun.spawnSync(["git", "add", "-A"], { cwd: repoDir, stdout: "pipe", stderr: "pipe" });
  Bun.spawnSync(["git", "commit", "-m", "init"], { cwd: repoDir, stdout: "pipe", stderr: "pipe" });

  return repoDir;
}

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), "orca-server-test-"));
  server = startServer({ port: 0, dataDir });
  baseUrl = `http://localhost:${server.server.port}`;
});

afterEach(async () => {
  if (server) await server.shutdown();
  if (dataDir) rmSync(dataDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Health
// ---------------------------------------------------------------------------

describe("GET /health", () => {
  test("returns ok with version", async () => {
    const res = await fetch(`${baseUrl}/health`);
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.status).toBe("ok");
    expect(body.version).toBe("0.2.0");
    expect(typeof body.builds).toBe("number");
    expect(typeof body.uptime).toBe("number");
  });
});

// ---------------------------------------------------------------------------
// Dashboard
// ---------------------------------------------------------------------------

describe("GET /", () => {
  test("serves HTML dashboard", async () => {
    const res = await fetch(`${baseUrl}/`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
    const body = await res.text();
    expect(body).toContain("<!DOCTYPE html>");
  });
});

// ---------------------------------------------------------------------------
// Builds CRUD
// ---------------------------------------------------------------------------

describe("GET /builds", () => {
  test("returns empty array initially", async () => {
    const res = await fetch(`${baseUrl}/builds`);
    expect(res.status).toBe(200);
    const body = await res.json() as any[];
    expect(body).toEqual([]);
  });
});

describe("POST /builds", () => {
  test("returns 400 without repo or dir", async () => {
    const res = await fetch(`${baseUrl}/builds`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
    const body = await res.json() as any;
    expect(body.error).toContain("repo or dir");
  });

  test("returns 400 with invalid JSON", async () => {
    const res = await fetch(`${baseUrl}/builds`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "not json",
    });
    expect(res.status).toBe(400);
  });

  test("creates a build with valid repo", async () => {
    const repoDir = createFixtureRepo(dataDir);
    const res = await fetch(`${baseUrl}/builds`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ repo: repoDir, name: "test-build" }),
    });
    expect(res.status).toBe(201);
    const body = await res.json() as any;
    expect(body.id).toBeDefined();
    expect(body.name).toBe("test-build");
    expect(body.status).toBe("cloning");
  });

  test("build appears in list after creation", async () => {
    const repoDir = createFixtureRepo(dataDir);
    const createRes = await fetch(`${baseUrl}/builds`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ repo: repoDir, name: "listed-build" }),
    });
    const { id } = await createRes.json() as any;

    const listRes = await fetch(`${baseUrl}/builds`);
    const builds = await listRes.json() as any[];
    expect(builds.length).toBe(1);
    expect(builds[0].id).toBe(id);
  });

  test("creates a build with dir (in-place, no clone)", async () => {
    const repoDir = createFixtureRepo(dataDir);
    const res = await fetch(`${baseUrl}/builds`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ dir: repoDir, name: "dir-build" }),
    });
    expect(res.status).toBe(201);
    const body = await res.json() as any;
    expect(body.id).toBeDefined();
    expect(body.name).toBe("dir-build");
    expect(body.status).toBe("starting");
  });

  test("returns 400 for nonexistent dir", async () => {
    const res = await fetch(`${baseUrl}/builds`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ dir: "/tmp/nonexistent-dir-orca-test" }),
    });
    expect(res.status).toBe(400);
    const body = await res.json() as any;
    expect(body.error).toContain("not found");
  });
});

describe("GET /builds/:id", () => {
  test("returns 404 for unknown build", async () => {
    const res = await fetch(`${baseUrl}/builds/nonexistent`);
    expect(res.status).toBe(404);
  });

  test("returns build detail after creation", async () => {
    const repoDir = createFixtureRepo(dataDir);
    const createRes = await fetch(`${baseUrl}/builds`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ repo: repoDir, name: "detail-build" }),
    });
    const { id } = await createRes.json() as any;

    const detailRes = await fetch(`${baseUrl}/builds/${id}`);
    expect(detailRes.status).toBe(200);
    const body = await detailRes.json() as any;
    expect(body.id).toBe(id);
    expect(body.name).toBe("detail-build");
    expect(body.repoUrl).toBe(repoDir);
    expect(body.startedAt).toBeDefined();
  });
});

describe("DELETE /builds/:id", () => {
  test("returns 404 for unknown build", async () => {
    const res = await fetch(`${baseUrl}/builds/nonexistent`, { method: "DELETE" });
    expect(res.status).toBe(404);
  });

  test("stops a build", async () => {
    const repoDir = createFixtureRepo(dataDir);
    const createRes = await fetch(`${baseUrl}/builds`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ repo: repoDir, name: "stop-build" }),
    });
    const { id } = await createRes.json() as any;

    const deleteRes = await fetch(`${baseUrl}/builds/${id}`, { method: "DELETE" });
    expect(deleteRes.status).toBe(200);
    const body = await deleteRes.json() as any;
    expect(body.status).toBe("stopping");
  });
});

// ---------------------------------------------------------------------------
// Logs
// ---------------------------------------------------------------------------

describe("GET /builds/:id/logs", () => {
  test("returns 404 for unknown build", async () => {
    const res = await fetch(`${baseUrl}/builds/nonexistent/logs`);
    expect(res.status).toBe(404);
  });

  test("returns stdout and stderr arrays", async () => {
    const repoDir = createFixtureRepo(dataDir);
    const createRes = await fetch(`${baseUrl}/builds`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ repo: repoDir, name: "logs-build" }),
    });
    const { id } = await createRes.json() as any;

    const logsRes = await fetch(`${baseUrl}/builds/${id}/logs`);
    expect(logsRes.status).toBe(200);
    const body = await logsRes.json() as any;
    expect(Array.isArray(body.stdout)).toBe(true);
    expect(Array.isArray(body.stderr)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Intervention
// ---------------------------------------------------------------------------

describe("POST /builds/:id/intervene", () => {
  test("returns 404 for unknown build", async () => {
    const res = await fetch(`${baseUrl}/builds/nonexistent/intervene`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "continue" }),
    });
    expect(res.status).toBe(404);
  });

  test("returns 400 for invalid action", async () => {
    const repoDir = createFixtureRepo(dataDir);
    const createRes = await fetch(`${baseUrl}/builds`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ repo: repoDir, name: "intervene-build" }),
    });
    const { id } = await createRes.json() as any;

    const res = await fetch(`${baseUrl}/builds/${id}/intervene`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "invalid" }),
    });
    expect(res.status).toBe(400);
  });

  test("accepts valid intervention", async () => {
    const repoDir = createFixtureRepo(dataDir);
    const createRes = await fetch(`${baseUrl}/builds`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ repo: repoDir, name: "intervene-ok" }),
    });
    const { id } = await createRes.json() as any;

    // Wait for clone to finish so .orca dir can be created
    await Bun.sleep(2000);

    const res = await fetch(`${baseUrl}/builds/${id}/intervene`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "continue", note: "test note" }),
    });
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.action).toBe("continue");
  });
});

// ---------------------------------------------------------------------------
// SSE
// ---------------------------------------------------------------------------

describe("GET /builds/:id/events", () => {
  test("returns 404 for unknown build", async () => {
    const res = await fetch(`${baseUrl}/builds/nonexistent/events`);
    expect(res.status).toBe(404);
  });

  test("returns SSE stream with initial status event", async () => {
    const repoDir = createFixtureRepo(dataDir);
    const createRes = await fetch(`${baseUrl}/builds`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ repo: repoDir, name: "sse-build" }),
    });
    const { id } = await createRes.json() as any;

    const res = await fetch(`${baseUrl}/builds/${id}/events`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/event-stream");
    expect(res.headers.get("cache-control")).toBe("no-cache");

    // Read the first chunk — should contain an initial status event
    const reader = res.body!.getReader();
    const { value } = await reader.read();
    const text = new TextDecoder().decode(value);
    expect(text).toContain("event: status");
    expect(text).toContain("data:");

    // Cancel the stream
    reader.cancel();
  });
});

// ---------------------------------------------------------------------------
// CORS
// ---------------------------------------------------------------------------

describe("OPTIONS (CORS)", () => {
  test("returns 204 with CORS headers", async () => {
    const res = await fetch(`${baseUrl}/builds`, { method: "OPTIONS" });
    expect(res.status).toBe(204);
    expect(res.headers.get("access-control-allow-origin")).toBe("*");
    expect(res.headers.get("access-control-allow-methods")).toContain("POST");
  });
});

// ---------------------------------------------------------------------------
// 404
// ---------------------------------------------------------------------------

describe("Unknown routes", () => {
  test("returns 404 for unknown path", async () => {
    const res = await fetch(`${baseUrl}/unknown`);
    expect(res.status).toBe(404);
  });
});
