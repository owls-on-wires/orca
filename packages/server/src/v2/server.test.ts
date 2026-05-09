import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { startServer } from "./server";
import type { Server } from "bun";

let server: Server;
let baseUrl: string;
let cleanup: { server: Server; db: import("./db").OrcaDatabase };

const YAML_CONFIG = `
name: test-project
defaults:
  types:
    develop:
      type: agent
      params:
        prompt_template: "Implement the feature"
    eval:
      type: command
      params:
        command: "bun test"
tasks:
  - id: task1
    prompt: "Build feature X"
    actions: [develop, eval]
    tags: [frontend]
  - id: task2
    prompt: "Build feature Y"
    actions: [develop]
    tags: [backend]
    depends_on: [task1]
`;

function url(path: string): string {
  return `${baseUrl}${path}`;
}

async function fetchJson(path: string, init?: RequestInit) {
  const res = await fetch(url(path), init);
  return { status: res.status, body: await res.json() };
}

async function post(path: string, data: unknown) {
  return fetchJson(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(data),
  });
}

async function patch(path: string, data: unknown) {
  return fetchJson(path, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(data),
  });
}

async function del(path: string) {
  return fetchJson(path, { method: "DELETE" });
}

describe("v2 server", () => {
  beforeEach(() => {
    cleanup = startServer({ port: 0, noExecutor: true });
    server = cleanup.server;
    baseUrl = `http://localhost:${server.port}`;
  });

  afterEach(() => {
    clearInterval(cleanup.heartbeatInterval);
    server.stop(true);
    cleanup.db.close();
  });

  // ── POST /import ──

  it("POST /import creates actions and edges", async () => {
    const { status, body } = await post("/import", { yaml: YAML_CONFIG });
    expect(status).toBe(200);
    expect(body.actions).toBeArray();
    expect(body.actions.length).toBeGreaterThan(0);
    expect(body.edges).toBeGreaterThan(0);
    // Should include task1.develop, task1.eval, task2.develop
    expect(body.actions).toContain("task1.develop");
    expect(body.actions).toContain("task1.eval");
    expect(body.actions).toContain("task2.develop");
  });

  // ── GET /actions with filters ──

  it("GET /actions returns all actions", async () => {
    await post("/import", { yaml: YAML_CONFIG });
    const { status, body } = await fetchJson("/actions");
    expect(status).toBe(200);
    expect(body.length).toBeGreaterThanOrEqual(3);
  });

  it("GET /actions?tag=frontend filters by tag", async () => {
    await post("/import", { yaml: YAML_CONFIG });
    const { body } = await fetchJson("/actions?tag=frontend");
    for (const action of body) {
      expect(action.tags).toContain("frontend");
    }
    expect(body.length).toBe(2); // task1.develop + task1.eval
  });

  it("GET /actions?status=pending filters by status", async () => {
    await post("/import", { yaml: YAML_CONFIG });
    const { body } = await fetchJson("/actions?status=pending");
    for (const action of body) {
      expect(action.status).toBe("pending");
    }
  });

  it("GET /actions?type=command filters by type", async () => {
    await post("/import", { yaml: YAML_CONFIG });
    const { body } = await fetchJson("/actions?type=command");
    for (const action of body) {
      expect(action.type).toBe("command");
    }
  });

  // ── GET /actions/:id ──

  it("GET /actions/:id returns action with edges and history", async () => {
    await post("/import", { yaml: YAML_CONFIG });
    const { status, body } = await fetchJson("/actions/task1.develop");
    expect(status).toBe(200);
    expect(body.action.id).toBe("task1.develop");
    expect(body.edges).toBeDefined();
    expect(body.edges.from).toBeArray();
    expect(body.edges.to).toBeArray();
    expect(body.history).toBeArray();
  });

  it("GET /actions/:id returns 404 for missing action", async () => {
    const { status, body } = await fetchJson("/actions/nonexistent");
    expect(status).toBe(404);
    expect(body.error).toBeDefined();
  });

  // ── PATCH /actions/:id ──

  it("PATCH /actions/:id updates params", async () => {
    await post("/import", { yaml: YAML_CONFIG });
    const { status, body } = await patch("/actions/task1.develop", {
      params: { custom: "value" },
    });
    expect(status).toBe(200);
    expect(body.params.custom).toBe("value");
  });

  it("PATCH /actions/:id updates tags", async () => {
    await post("/import", { yaml: YAML_CONFIG });
    const { body } = await patch("/actions/task1.develop", {
      tags: ["new-tag"],
    });
    expect(body.tags).toContain("new-tag");
  });

  it("PATCH /actions/:id returns 404 for missing action", async () => {
    const { status } = await patch("/actions/nonexistent", { params: {} });
    expect(status).toBe(404);
  });

  // ── DELETE /actions/:id ──

  it("DELETE /actions/:id deletes action", async () => {
    await post("/import", { yaml: YAML_CONFIG });
    const { status, body } = await del("/actions/task1.develop");
    expect(status).toBe(200);
    expect(body.deleted).toBe(true);

    // Verify gone
    const { status: getStatus } = await fetchJson("/actions/task1.develop");
    expect(getStatus).toBe(404);
  });

  it("DELETE /actions/:id cascades to edges", async () => {
    await post("/import", { yaml: YAML_CONFIG });

    // Get edges before delete
    const { body: before } = await fetchJson("/actions/task1.eval");
    const hadIncomingEdges = before.edges.to.length > 0;
    expect(hadIncomingEdges).toBe(true);

    // Delete task1.develop — edges from it should be removed
    await del("/actions/task1.develop");

    // task1.eval should have no incoming edges from task1.develop
    const { body: after } = await fetchJson("/actions/task1.eval");
    const fromDeleted = after.edges.to.filter(
      (e: { from_action: string }) => e.from_action === "task1.develop",
    );
    expect(fromDeleted.length).toBe(0);
  });

  // ── POST /actions/:id/retry ──

  it("POST /actions/:id/retry resets action", async () => {
    await post("/import", { yaml: YAML_CONFIG });
    // First set it to completed
    await patch("/actions/task1.develop", { status: "completed" });

    const { status, body } = await post("/actions/task1.develop/retry", {});
    expect(status).toBe(200);
    expect(body.status).toBe("pending");

    // Verify iteration incremented
    const { body: action } = await fetchJson("/actions/task1.develop");
    expect(action.action.iteration).toBe(1);
    expect(action.action.output).toBeNull();
  });

  // ── POST /actions/:id/skip ──

  it("POST /actions/:id/skip marks action as skipped", async () => {
    await post("/import", { yaml: YAML_CONFIG });
    const { status, body } = await post("/actions/task1.develop/skip", {});
    expect(status).toBe(200);
    expect(body.status).toBe("skipped");
  });

  // ── POST /actions/:id/respond ──

  it("POST /actions/:id/respond completes waiting action", async () => {
    await post("/import", { yaml: YAML_CONFIG });
    // Set action to waiting
    await patch("/actions/task1.develop", { status: "waiting" });

    const { status, body } = await post("/actions/task1.develop/respond", {
      status: "approved",
      summary: "Looks good",
      notes: "Minor fix needed",
    });
    expect(status).toBe(200);
    expect(body.status).toBe("completed");

    // Verify output was set
    const { body: action } = await fetchJson("/actions/task1.develop");
    expect(action.action.output.status).toBe("approved");
    expect(action.action.output.summary).toBe("Looks good");
    expect(action.action.output.notes).toBe("Minor fix needed");
  });

  it("POST /actions/:id/respond returns 400 for non-waiting action", async () => {
    await post("/import", { yaml: YAML_CONFIG });
    const { status, body } = await post("/actions/task1.develop/respond", {
      status: "approved",
      summary: "test",
    });
    expect(status).toBe(400);
    expect(body.error).toContain("not waiting");
  });

  // ── PATCH /actions?tag=X (bulk) ──

  it("PATCH /actions?tag=frontend bulk updates", async () => {
    await post("/import", { yaml: YAML_CONFIG });
    const { status, body } = await patch("/actions?tag=frontend", {
      params: { bulk_key: "bulk_value" },
    });
    expect(status).toBe(200);
    expect(body.updated).toBe(2); // task1.develop + task1.eval

    // Verify individual actions
    const { body: action } = await fetchJson("/actions/task1.develop");
    expect(action.action.params.bulk_key).toBe("bulk_value");
  });

  it("PATCH /actions without tag returns 400", async () => {
    const { status, body } = await patch("/actions", { params: {} });
    expect(status).toBe(400);
    expect(body.error).toContain("tag");
  });

  // ── Edge CRUD ──

  it("POST /edges creates edge", async () => {
    await post("/import", { yaml: YAML_CONFIG });
    const { status, body } = await post("/edges", {
      from_action: "task1.develop",
      to_action: "task2.develop",
      condition: "fail",
    });
    expect(status).toBe(200);
    expect(body.id).toBeDefined();
    expect(body.from_action).toBe("task1.develop");
    expect(body.condition).toBe("fail");
  });

  it("POST /edges returns 400 for missing fields", async () => {
    const { status } = await post("/edges", { from_action: "a" });
    expect(status).toBe(400);
  });

  it("DELETE /edges/:id removes edge", async () => {
    await post("/import", { yaml: YAML_CONFIG });
    // Create an edge
    const { body: created } = await post("/edges", {
      from_action: "task1.develop",
      to_action: "task2.develop",
      condition: "error",
    });
    const { status, body } = await del(`/edges/${created.id}`);
    expect(status).toBe(200);
    expect(body.deleted).toBe(true);
  });

  // ── Executor pause/resume ──

  it("POST /executor/pause pauses executor", async () => {
    const { status, body } = await post("/executor/pause", {});
    expect(status).toBe(200);
    expect(body.state).toBeDefined();
  });

  it("POST /executor/resume resumes executor", async () => {
    await post("/executor/pause", {});
    const { status, body } = await post("/executor/resume", {});
    expect(status).toBe(200);
    expect(body.state).toBeDefined();
  });

  it("GET /executor/status returns status", async () => {
    const { status, body } = await fetchJson("/executor/status");
    expect(status).toBe(200);
    expect(body.state).toBeDefined();
    expect(body.total).toBeDefined();
    expect(body.pending).toBeDefined();
  });

  // ── Defaults ──

  it("GET /defaults returns empty defaults initially", async () => {
    const { status, body } = await fetchJson("/defaults");
    expect(status).toBe(200);
    expect(body).toEqual({});
  });

  it("PATCH /defaults merges defaults", async () => {
    await patch("/defaults", {
      custom_type: { type: "agent", params: { foo: "bar" } },
    });
    const { body } = await fetchJson("/defaults");
    expect(body.custom_type.params.foo).toBe("bar");
  });

  // ── Health ──

  it("GET /health returns server info", async () => {
    const { status, body } = await fetchJson("/health");
    expect(status).toBe(200);
    expect(body.version).toBe("2.0.0");
    expect(body.uptime).toBeDefined();
    expect(body.actions.total).toBeDefined();
  });

  // ── Root ──

  it("GET / returns HTML", async () => {
    const res = await fetch(url("/"));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
  });

  // ── 404 ──

  it("returns 404 for unknown routes", async () => {
    const { status, body } = await fetchJson("/nonexistent");
    expect(status).toBe(404);
    expect(body.error).toBeDefined();
  });

  // ── 400 for invalid body ──

  it("POST /import returns 400 for invalid body", async () => {
    const res = await fetch(url("/import"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "not json",
    });
    expect(res.status).toBe(400);
  });

  // ── CORS ──

  it("OPTIONS returns CORS headers", async () => {
    const res = await fetch(url("/actions"), { method: "OPTIONS" });
    expect(res.status).toBe(204);
    expect(res.headers.get("access-control-allow-origin")).toBe("*");
  });
});
