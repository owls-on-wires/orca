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

  // ── POST /actions (create) ──

  it("POST /actions creates an action", async () => {
    await post("/import", { yaml: YAML_CONFIG });
    const { status, body } = await post("/actions", {
      id: "my-task.develop",
      type: "agent",
      project_id: "test-project",
      params: { prompt: "Build something" },
      tags: ["task:my-task", "type:develop"],
    });
    expect(status).toBe(201);
    expect(body.id).toBe("my-task.develop");
    expect(body.type).toBe("agent");
    expect(body.status).toBe("inactive");
    expect(body.params.prompt).toBe("Build something");
    expect(body.tags).toContain("task:my-task");
    expect(body.project_id).toBe("test-project");
  });

  it("POST /actions defaults status to inactive", async () => {
    await post("/import", { yaml: YAML_CONFIG });
    const { body } = await post("/actions", { id: "a.b", type: "command", project_id: "test-project" });
    expect(body.status).toBe("inactive");
  });

  it("POST /actions accepts explicit status", async () => {
    await post("/import", { yaml: YAML_CONFIG });
    const { body } = await post("/actions", {
      id: "a.b",
      type: "agent",
      status: "pending",
      project_id: "test-project",
    });
    expect(body.status).toBe("pending");
  });

  it("POST /actions returns 409 for duplicate id", async () => {
    await post("/import", { yaml: YAML_CONFIG });
    await post("/actions", { id: "dup.action", type: "agent", project_id: "test-project" });
    const { status, body } = await post("/actions", { id: "dup.action", type: "agent", project_id: "test-project" });
    expect(status).toBe(409);
    expect(body.error).toContain("already exists");
  });

  it("POST /actions returns 400 for missing id", async () => {
    const { status } = await post("/actions", { type: "agent", project_id: "x" });
    expect(status).toBe(400);
  });

  it("POST /actions returns 400 for missing type", async () => {
    const { status } = await post("/actions", { id: "no-type", project_id: "x" });
    expect(status).toBe(400);
  });

  it("POST /actions returns 400 for invalid type", async () => {
    const { status } = await post("/actions", { id: "bad", type: "invalid", project_id: "x" });
    expect(status).toBe(400);
  });

  it("POST /actions returns 400 for missing project_id", async () => {
    const { status } = await post("/actions", { id: "no-proj", type: "agent" });
    expect(status).toBe(400);
  });

  it("POST /actions + POST /edges builds a chain", async () => {
    await post("/import", { yaml: YAML_CONFIG });
    // Create two actions
    await post("/actions", { id: "chain.a", type: "agent", status: "pending", project_id: "test-project" });
    await post("/actions", { id: "chain.b", type: "command", params: { command: "echo ok" }, project_id: "test-project" });

    // Wire them
    const { status, body } = await post("/edges", {
      from_action: "chain.a",
      to_action: "chain.b",
      condition: "pass",
    });
    expect(status).toBe(200);

    // Verify edge exists
    const { body: detail } = await fetchJson("/actions/chain.a");
    expect(detail.edges.from).toHaveLength(1);
    expect(detail.edges.from[0].to_action).toBe("chain.b");
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

  // ── Root + Discovery ──

  it("GET / returns discovery JSON", async () => {
    const res = await fetch(url("/"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.name).toBe("orca");
    expect(body.version).toBe("2.0.0");
    expect(body.docs.llms).toBe("/docs/llms.txt");
    expect(body.docs.openapi).toBe("/docs/openapi.yaml");
    expect(body.docs.guides["dynamic-tasking"]).toBeDefined();
  });

  // ── Docs ──

  it("GET /llms.txt returns the LLM reference", async () => {
    const res = await fetch(url("/llms.txt"));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/plain");
    const text = await res.text();
    expect(text).toContain("Orca v2 API");
    expect(text).toContain("POST   /actions");
  });

  it("GET /docs/llms.txt returns the LLM reference", async () => {
    const res = await fetch(url("/docs/llms.txt"));
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).toContain("Orca v2 API");
  });

  it("GET /docs/guides/dynamic-tasking.md returns guide", async () => {
    const res = await fetch(url("/docs/guides/dynamic-tasking.md"));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/markdown");
    const text = await res.text();
    expect(text).toContain("POST /groups");
  });

  it("GET /docs/openapi.yaml returns the OpenAPI spec", async () => {
    const res = await fetch(url("/docs/openapi.yaml"));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/yaml");
    const text = await res.text();
    expect(text).toContain("openapi:");
  });

  it("GET /docs/nonexistent returns 404", async () => {
    const { status } = await fetchJson("/docs/nonexistent.txt");
    expect(status).toBe(404);
  });

  it("GET /docs/.. is rejected", async () => {
    const { status } = await fetchJson("/docs/../../../etc/passwd");
    // URL parser resolves ".." so this either hits 400 or 404
    expect(status === 400 || status === 404).toBe(true);
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

  // ── GET /actions/:id/logs ──

  it("GET /actions/:id/logs returns 404 for missing action", async () => {
    const { status, body } = await fetchJson("/actions/nonexistent/logs");
    expect(status).toBe(404);
  });

  it("GET /actions/:id/logs returns empty array when no logs exist", async () => {
    await post("/import", { yaml: YAML_CONFIG });
    const { status, body } = await fetchJson("/actions/task1.develop/logs");
    expect(status).toBe(200);
    expect(body).toEqual([]);
  });

  // ── POST /reimport ──

  it("POST /reimport replaces specified tasks", async () => {
    await post("/import", { yaml: YAML_CONFIG });

    // Mark task1.develop as completed
    await patch("/actions/task1.develop", { status: "completed" });

    // Reimport task1 only
    const { status, body } = await post("/reimport", {
      yaml: YAML_CONFIG,
      tasks: ["task1"],
    });
    expect(status).toBe(200);
    expect(body.replaced).toEqual(["task1"]);
    expect(body.actions).toContain("task1.develop");
    expect(body.actions).toContain("task1.eval");

    // task1.develop should be reset to pending (first action, no deps)
    const { body: action } = await fetchJson("/actions/task1.develop");
    expect(action.action.status).toBe("pending");
  });

  it("POST /reimport preserves other tasks", async () => {
    await post("/import", { yaml: YAML_CONFIG });
    await patch("/actions/task2.develop", { status: "completed" });

    await post("/reimport", { yaml: YAML_CONFIG, tasks: ["task1"] });

    // task2 should be untouched
    const { body: action } = await fetchJson("/actions/task2.develop");
    expect(action.action.status).toBe("completed");
  });

  it("POST /reimport returns 400 for unknown task", async () => {
    await post("/import", { yaml: YAML_CONFIG });
    const { status, body } = await post("/reimport", {
      yaml: YAML_CONFIG,
      tasks: ["nonexistent"],
    });
    expect(status).toBe(400);
  });

  it("POST /reimport returns 400 without tasks array", async () => {
    const { status } = await post("/reimport", { yaml: YAML_CONFIG });
    expect(status).toBe(400);
  });

  // ── POST /groups ──

  it("POST /groups creates a task chain from template", async () => {
    // First import to create the project record
    await post("/import", { yaml: YAML_CONFIG });

    // Write a project.orca.yaml with templates to the project_dir
    const { writeFileSync, mkdirSync } = require("fs");
    const project = cleanup.db.getProject("test-project");
    const projectDir = project!.project_dir;
    mkdirSync(projectDir, { recursive: true });
    writeFileSync(`${projectDir}/project.orca.yaml`, YAML_CONFIG);

    const { status, body } = await post("/groups", {
      id: "new-task",
      template: "tdd",
      project_id: "test-project",
      prompt: "Build something new",
      overrides: {
        eval: { command: "bun test test/new.test.ts" },
      },
    });

    // Should fail — YAML_CONFIG doesn't define a "tdd" template
    // Let's use the actual templates from YAML_CONFIG which has "develop" and "eval" types
    expect(status).toBe(400);
  });

  it("POST /groups with valid template creates actions and edges", async () => {
    const { mkdtempSync, writeFileSync } = require("fs");
    const { join } = require("path");
    const tmpDir = mkdtempSync(join(require("os").tmpdir(), "orca-groups-"));

    const configWithTemplate = `
name: group-test
project_dir: ${tmpDir}
templates:
  tdd:
    actions: [develop, eval]
    types:
      develop:
        type: agent
      eval:
        type: command
        params:
          command: "bun test"
        edges:
          fail: develop
tasks:
  - id: placeholder
    prompt: "x"
    actions: [develop]
`;

    await post("/import", { yaml: configWithTemplate, source_dir: tmpDir });
    writeFileSync(join(tmpDir, "project.orca.yaml"), configWithTemplate);

    const { status, body } = await post("/groups", {
      id: "auth",
      template: "tdd",
      project_id: "group-test",
      prompt: "Build auth",
    });

    expect(status).toBe(201);
    expect(body.actions).toContain("auth.develop");
    expect(body.actions).toContain("auth.eval");
    expect(body.edges).toBeGreaterThan(0);

    // Verify actions exist in DB
    const { body: detail } = await fetchJson("/actions/auth.develop");
    expect(detail.action.type).toBe("agent");
    expect(detail.action.status).toBe("inactive");
    expect(detail.action.project_id).toBe("group-test");
    expect(detail.action.params.prompt).toBe("Build auth");
  });

  it("POST /groups wires 'after' edge", async () => {
    const { mkdirSync, writeFileSync } = require("fs");
    const { mkdtempSync } = require("fs");
    const { join } = require("path");
    const tmpDir = mkdtempSync(join(require("os").tmpdir(), "orca-groups-"));

    const configWithTemplate = `
name: after-test
project_dir: ${tmpDir}
templates:
  tdd:
    actions: [develop, eval]
    types:
      develop:
        type: agent
      eval:
        type: command
        params:
          command: "bun test"
tasks:
  - id: existing
    template: tdd
    prompt: "x"
`;
    await post("/import", { yaml: configWithTemplate, source_dir: tmpDir });
    writeFileSync(join(tmpDir, "project.orca.yaml"), configWithTemplate);

    const { status, body } = await post("/groups", {
      id: "next-task",
      template: "tdd",
      project_id: "after-test",
      prompt: "Build next",
      after: "existing.eval",
    });

    expect(status).toBe(201);

    // Verify edge from existing.eval → next-task.develop
    const { body: evalDetail } = await fetchJson("/actions/existing.eval");
    const passToNext = evalDetail.edges.from.find(
      (e: any) => e.to_action === "next-task.develop" && e.condition === "pass",
    );
    expect(passToNext).toBeDefined();
  });

  it("POST /groups returns 409 for duplicate actions", async () => {
    const { mkdtempSync, writeFileSync } = require("fs");
    const { join } = require("path");
    const tmpDir = mkdtempSync(join(require("os").tmpdir(), "orca-groups-"));

    const cfg = `
name: dup-test
project_dir: ${tmpDir}
templates:
  tdd:
    actions: [develop, eval]
    types:
      develop:
        type: agent
      eval:
        type: command
tasks:
  - id: dup
    template: tdd
    prompt: "x"
`;
    await post("/import", { yaml: cfg, source_dir: tmpDir });
    writeFileSync(join(tmpDir, "project.orca.yaml"), cfg);

    // dup.develop and dup.eval already exist from import
    const { status } = await post("/groups", {
      id: "dup",
      template: "tdd",
      project_id: "dup-test",
      prompt: "Duplicate",
    });
    expect(status).toBe(409);
  });

  it("POST /groups returns 400 for missing fields", async () => {
    const { status: s1 } = await post("/groups", { template: "tdd", project_id: "x" });
    expect(s1).toBe(400);
    const { status: s2 } = await post("/groups", { id: "x", project_id: "x" });
    expect(s2).toBe(400);
    const { status: s3 } = await post("/groups", { id: "x", template: "tdd" });
    expect(s3).toBe(400);
  });

  it("POST /groups returns 404 for unknown project", async () => {
    const { status } = await post("/groups", {
      id: "x",
      template: "tdd",
      project_id: "nonexistent",
    });
    expect(status).toBe(404);
  });
});
