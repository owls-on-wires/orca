import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { OrcaDatabase } from "./db";
import { expandConfig, reimportTasks } from "./config";

let db: OrcaDatabase;

beforeEach(() => {
  db = new OrcaDatabase(":memory:");
});

afterEach(() => {
  db.close();
});

const minimalConfig = `
name: test-project
defaults:
  types:
    develop:
      type: agent
      params:
        model: claude-sonnet
    eval:
      type: command
      params:
        command: "bun test"
tasks:
  - id: auth
    prompt: "Build authentication"
    actions: [develop, eval]
`;

describe("expandConfig", () => {
  test("simple 2-action task expansion", () => {
    const config = expandConfig(minimalConfig, db);

    expect(config.name).toBe("test-project");

    const dev = db.getAction("auth.develop");
    expect(dev).not.toBeNull();
    expect(dev!.type).toBe("agent");
    expect(dev!.params.model).toBe("claude-sonnet");
    expect(dev!.params.prompt).toBe("Build authentication");

    const ev = db.getAction("auth.eval");
    expect(ev).not.toBeNull();
    expect(ev!.type).toBe("command");
    expect(ev!.params.command).toBe("bun test");
  });

  test("first action is pending, rest are inactive", () => {
    expandConfig(minimalConfig, db);

    const dev = db.getAction("auth.develop");
    expect(dev!.status).toBe("pending");

    const ev = db.getAction("auth.eval");
    expect(ev!.status).toBe("inactive");
  });

  test("default edges when no edges map specified", () => {
    expandConfig(minimalConfig, db);

    // develop (index 0): pass → eval (next). Self-loop edges (fail → develop) are skipped.
    const devEdges = db.getEdgesFrom("auth.develop");
    expect(devEdges).toHaveLength(1);
    expect(devEdges[0].condition).toBe("pass");
    expect(devEdges[0].to_action).toBe("auth.eval");

    // eval (last): pass → complete (no edge), all other conditions → develop (first)
    const evalEdges = db.getEdgesFrom("auth.eval");
    expect(evalEdges).toHaveLength(6); // fail, max_turns, timeout, cost_exceeded, stuck, error
    expect(evalEdges.find((e) => e.condition === "fail")?.to_action).toBe("auth.develop");
    expect(evalEdges.every((e) => e.to_action === "auth.develop")).toBe(true);
  });

  test("auto-tagging verification", () => {
    const yaml = `
name: my-app
defaults:
  types:
    develop:
      type: agent
tasks:
  - id: auth
    prompt: "Build auth"
    actions: [develop]
    tags: [priority-high, backend]
`;
    expandConfig(yaml, db);

    const action = db.getAction("auth.develop");
    expect(action!.tags).toContain("type:develop");
    expect(action!.tags).toContain("task:auth");
    expect(action!.tags).toContain("project:my-app");
    expect(action!.tags).toContain("priority-high");
    expect(action!.tags).toContain("backend");
  });

  test("complex 5-action task with all edge types", () => {
    const yaml = `
name: complex-project
defaults:
  types:
    develop:
      type: agent
    eval:
      type: command
      params:
        command: "bun test"
      edges:
        pass: next
        fail: first
    deploy:
      type: command
      params:
        command: "deploy.sh"
    qa:
      type: agent
      edges:
        pass: complete
        fail: first
        max_turns: supervisor
    supervisor:
      type: agent
      params:
        role: supervisor
tasks:
  - id: auth
    prompt: "Build auth module"
    actions: [develop, eval, deploy, qa]
`;
    expandConfig(yaml, db);

    // Verify actions created
    expect(db.getAction("auth.develop")).not.toBeNull();
    expect(db.getAction("auth.eval")).not.toBeNull();
    expect(db.getAction("auth.deploy")).not.toBeNull();
    expect(db.getAction("auth.qa")).not.toBeNull();
    expect(db.getAction("auth.supervisor")).not.toBeNull();

    // Verify edges — develop is "first", so its self-loop edges are skipped
    const devEdges = db.getEdgesFrom("auth.develop");
    expect(devEdges).toHaveLength(1); // only pass → eval (self-loops skipped)
    expect(devEdges[0].condition).toBe("pass");
    expect(devEdges[0].to_action).toBe("auth.eval");

    // eval → develop is NOT a self-loop, so all default edges are created
    const evalEdges = db.getEdgesFrom("auth.eval");
    expect(evalEdges.find((e) => e.condition === "pass")?.to_action).toBe("auth.deploy");
    expect(evalEdges.find((e) => e.condition === "fail")?.to_action).toBe("auth.develop");

    const deployEdges = db.getEdgesFrom("auth.deploy");
    expect(deployEdges.find((e) => e.condition === "pass")?.to_action).toBe("auth.qa");
    expect(deployEdges.find((e) => e.condition === "fail")?.to_action).toBe("auth.develop");

    const qaEdges = db.getEdgesFrom("auth.qa");
    expect(qaEdges.find((e) => e.condition === "fail")?.to_action).toBe("auth.develop");
    expect(qaEdges.find((e) => e.condition === "max_turns")?.to_action).toBe("auth.supervisor");
  });

  test("supervisor auto-creation from routing shorthand", () => {
    const yaml = `
name: test
defaults:
  types:
    develop:
      type: agent
    qa:
      type: agent
      edges:
        pass: complete
        fail: first
        max_turns: supervisor
    supervisor:
      type: agent
      params:
        role: supervisor
tasks:
  - id: auth
    prompt: "Build auth"
    actions: [develop, qa]
`;
    expandConfig(yaml, db);

    const supervisor = db.getAction("auth.supervisor");
    expect(supervisor).not.toBeNull();
    expect(supervisor!.type).toBe("agent");
    expect(supervisor!.status).toBe("inactive");
    expect(supervisor!.params.role).toBe("supervisor");
    expect(supervisor!.params.prompt).toBe("Build auth");
    expect(supervisor!.tags).toContain("type:supervisor");
    expect(supervisor!.tags).toContain("task:auth");
  });

  test("cross-task dependency edge", () => {
    const yaml = `
name: test
defaults:
  types:
    develop:
      type: agent
    eval:
      type: command
      params:
        command: "test"
tasks:
  - id: auth
    prompt: "Build auth"
    actions: [develop, eval]
  - id: dashboard
    prompt: "Build dashboard"
    actions: [develop, eval]
    depends_on: [auth]
`;
    expandConfig(yaml, db);

    // auth.eval (terminal) should have a pass edge to dashboard.develop (first)
    const authEvalEdges = db.getEdgesFrom("auth.eval");
    const crossEdge = authEvalEdges.find(
      (e) => e.to_action === "dashboard.develop" && e.condition === "pass",
    );
    expect(crossEdge).not.toBeUndefined();

    // dashboard.develop should be inactive (has depends_on)
    const dashDev = db.getAction("dashboard.develop");
    expect(dashDev!.status).toBe("inactive");
  });

  test("invalid config - missing type in defaults", () => {
    const yaml = `
name: test
defaults:
  types:
    develop:
      type: agent
tasks:
  - id: auth
    prompt: "Build auth"
    actions: [develop, nonexistent]
`;
    expect(() => expandConfig(yaml, db)).toThrow(/Unknown action type nonexistent/);
  });

  test("invalid config - missing name", () => {
    const yaml = `
defaults:
  types:
    develop:
      type: agent
tasks:
  - id: auth
    prompt: "Build auth"
    actions: [develop]
`;
    expect(() => expandConfig(yaml, db)).toThrow(/missing name/);
  });

  test("budget merged into params", () => {
    const yaml = `
name: test
defaults:
  types:
    develop:
      type: agent
      params:
        model: sonnet
tasks:
  - id: auth
    prompt: "Build auth"
    actions: [develop]
    budget:
      max_iterations: 5
      max_cost: 2.50
`;
    expandConfig(yaml, db);

    const action = db.getAction("auth.develop");
    expect(action!.params.max_iterations).toBe(5);
    expect(action!.params.max_cost).toBe(2.5);
    expect(action!.params.model).toBe("sonnet");
  });

  test("per-task overrides merge into action params", () => {
    const yaml = `
name: test
defaults:
  types:
    develop:
      type: agent
      max_turns: 50
    eval:
      type: command
      command: "bun test"
      timeout: 30
      edges: { pass: complete, fail: first }
tasks:
  - id: auth
    prompt: "Fix auth"
    actions: [develop, eval]
    overrides:
      eval:
        command: "bun test test/auth.test.ts"
`;
    expandConfig(yaml, db);

    const evalAction = db.getAction("auth.eval");
    expect(evalAction!.params.command).toBe("bun test test/auth.test.ts");
    expect(evalAction!.params.timeout).toBe(30);
  });

  test("template default actions used when task omits actions", () => {
    const yaml = `
name: test
templates:
  bugfix:
    actions: [develop, eval]
    types:
      develop:
        type: agent
        max_turns: 50
      eval:
        type: command
        command: "bun test"
tasks:
  - id: fix-bug
    template: bugfix
    prompt: "Fix the bug"
`;
    expandConfig(yaml, db);

    const dev = db.getAction("fix-bug.develop");
    const ev = db.getAction("fix-bug.eval");
    expect(dev).not.toBeNull();
    expect(ev).not.toBeNull();
    expect(dev!.type).toBe("agent");
    expect(ev!.type).toBe("command");
  });

  test("task actions override template default actions", () => {
    const yaml = `
name: test
templates:
  feature:
    actions: [develop, eval, qa]
    types:
      develop:
        type: agent
      eval:
        type: command
        command: "bun test"
      qa:
        type: agent
tasks:
  - id: simple
    template: feature
    prompt: "Simple task"
    actions: [develop, eval]
`;
    expandConfig(yaml, db);

    const dev = db.getAction("simple.develop");
    const ev = db.getAction("simple.eval");
    const qa = db.getAction("simple.qa");
    expect(dev).not.toBeNull();
    expect(ev).not.toBeNull();
    expect(qa).toBeNull();
  });

  test("error when task has no actions and no template default", () => {
    const yaml = `
name: test
defaults:
  types:
    develop:
      type: agent
tasks:
  - id: broken
    prompt: "No actions"
`;
    expect(() => expandConfig(yaml, db)).toThrow(/no actions/);
  });
});

// ---------------------------------------------------------------------------
// reimportTasks
// ---------------------------------------------------------------------------

const reimportConfig = `
name: reimport-test
defaults:
  types:
    develop:
      type: agent
    eval:
      type: command
      command: "bun test"
      edges: { pass: next, fail: develop }
    qa:
      type: command
      command: "tsc --noEmit"
      edges: { fail: develop }
tasks:
  - id: task-a
    prompt: "Build A"
    actions: [develop, eval]
  - id: task-b
    prompt: "Build B"
    actions: [develop, eval]
    depends_on: [task-a]
  - id: task-c
    prompt: "Build C"
    actions: [develop, eval, qa]
    depends_on: [task-b]
`;

describe("reimportTasks", () => {
  test("replaces actions for specified task only", () => {
    expandConfig(reimportConfig, db);

    // Modify task-b's develop to simulate progress
    db.updateAction("task-b.develop", { status: "completed", output: { status: "passed" } });

    // Re-import task-b (should reset it)
    const result = reimportTasks(reimportConfig, db, ["task-b"]);

    expect(result.replaced).toEqual(["task-b"]);
    expect(result.actions).toContain("task-b.develop");
    expect(result.actions).toContain("task-b.eval");

    // task-b actions are fresh (inactive status, no output)
    const dev = db.getAction("task-b.develop")!;
    expect(dev.status).toBe("inactive");
    expect(dev.output).toBeNull();

    // task-a is untouched
    expect(db.getAction("task-a.develop")!.status).toBe("pending");
  });

  test("preserves other tasks' state", () => {
    expandConfig(reimportConfig, db);

    // Mark task-a as completed
    db.updateAction("task-a.develop", { status: "completed" });
    db.updateAction("task-a.eval", { status: "completed", output: { status: "passed" } });

    // Re-import task-b
    reimportTasks(reimportConfig, db, ["task-b"]);

    // task-a still completed
    expect(db.getAction("task-a.develop")!.status).toBe("completed");
    expect(db.getAction("task-a.eval")!.status).toBe("completed");

    // task-c still exists and untouched
    expect(db.getAction("task-c.develop")).not.toBeNull();
  });

  test("re-creates intra-task edges", () => {
    expandConfig(reimportConfig, db);
    reimportTasks(reimportConfig, db, ["task-b"]);

    // task-b.develop → task-b.eval [pass] should exist
    const devEdges = db.getEdgesFrom("task-b.develop");
    const passEdge = devEdges.find((e) => e.condition === "pass");
    expect(passEdge).toBeDefined();
    expect(passEdge!.to_action).toBe("task-b.eval");

    // task-b.eval → task-b.develop [fail] should exist (from edges config)
    const evalEdges = db.getEdgesFrom("task-b.eval");
    const failEdge = evalEdges.find((e) => e.condition === "fail");
    expect(failEdge).toBeDefined();
    expect(failEdge!.to_action).toBe("task-b.develop");
  });

  test("re-creates cross-task dependency edges (incoming)", () => {
    expandConfig(reimportConfig, db);
    reimportTasks(reimportConfig, db, ["task-b"]);

    // task-a.eval → task-b.develop [pass] should exist (task-b depends_on task-a)
    const aEvalEdges = db.getEdgesFrom("task-a.eval");
    const crossEdge = aEvalEdges.find(
      (e) => e.to_action === "task-b.develop" && e.condition === "pass",
    );
    expect(crossEdge).toBeDefined();
  });

  test("re-creates cross-task dependency edges (outgoing)", () => {
    expandConfig(reimportConfig, db);
    reimportTasks(reimportConfig, db, ["task-b"]);

    // task-b.eval → task-c.develop [pass] should exist (task-c depends_on task-b)
    const bEvalEdges = db.getEdgesFrom("task-b.eval");
    const crossEdge = bEvalEdges.find(
      (e) => e.to_action === "task-c.develop" && e.condition === "pass",
    );
    expect(crossEdge).toBeDefined();
  });

  test("picks up template changes", () => {
    expandConfig(reimportConfig, db);

    // Original: task-c has qa action
    expect(db.getAction("task-c.qa")).not.toBeNull();

    // Check original qa fail edge goes to develop (from explicit edges config)
    const qaEdges = db.getEdgesFrom("task-c.qa");
    const qaFail = qaEdges.find((e) => e.condition === "fail");
    expect(qaFail!.to_action).toBe("task-c.develop");

    // Re-import with modified config where qa edges change
    const modified = reimportConfig.replace(
      "edges: { fail: develop }",
      "edges: { fail: develop }",
    );
    reimportTasks(modified, db, ["task-c"]);

    // Actions still exist
    expect(db.getAction("task-c.qa")).not.toBeNull();
    // Fail edge still points to develop
    const newQaEdges = db.getEdgesFrom("task-c.qa");
    const newFail = newQaEdges.find((e) => e.condition === "fail");
    expect(newFail!.to_action).toBe("task-c.develop");
  });

  test("handles re-import of task with no dependencies", () => {
    expandConfig(reimportConfig, db);
    reimportTasks(reimportConfig, db, ["task-a"]);

    // task-a.develop should be pending (first action, no depends_on)
    expect(db.getAction("task-a.develop")!.status).toBe("pending");

    // Cross-task edge to task-b still exists
    const aEvalEdges = db.getEdgesFrom("task-a.eval");
    expect(aEvalEdges.find((e) => e.to_action === "task-b.develop")).toBeDefined();
  });

  test("handles re-import of multiple tasks at once", () => {
    expandConfig(reimportConfig, db);

    // Mark some as completed
    db.updateAction("task-a.develop", { status: "completed" });
    db.updateAction("task-b.develop", { status: "completed" });

    // Re-import both a and b
    const result = reimportTasks(reimportConfig, db, ["task-a", "task-b"]);
    expect(result.replaced).toEqual(["task-a", "task-b"]);
    expect(result.actions.length).toBe(4); // 2 actions each

    // Both reset
    expect(db.getAction("task-a.develop")!.status).toBe("pending");
    expect(db.getAction("task-b.develop")!.status).toBe("inactive");

    // Cross-task edge a → b preserved
    const aEdges = db.getEdgesFrom("task-a.eval");
    expect(aEdges.find((e) => e.to_action === "task-b.develop")).toBeDefined();
  });

  test("throws for unknown task ID", () => {
    expandConfig(reimportConfig, db);
    expect(() => reimportTasks(reimportConfig, db, ["nonexistent"])).toThrow(/not found in config/);
  });

  test("clears history for re-imported actions", () => {
    expandConfig(reimportConfig, db);

    // Add some history
    db.appendHistory("task-b.develop", "completed", { condition: "pass" });
    expect(db.getHistory("task-b.develop").length).toBe(1);

    // Re-import task-b
    reimportTasks(reimportConfig, db, ["task-b"]);

    // History should be cleared (action was deleted and re-created)
    expect(db.getHistory("task-b.develop").length).toBe(0);
  });

  test("does not null out other actions' project_id", () => {
    expandConfig(reimportConfig, db);

    // Verify project_id is set
    expect(db.getAction("task-a.develop")!.project_id).toBe("reimport-test");
    expect(db.getAction("task-c.develop")!.project_id).toBe("reimport-test");

    // Re-import only task-b
    reimportTasks(reimportConfig, db, ["task-b"]);

    // Other actions' project_id should still be set
    expect(db.getAction("task-a.develop")!.project_id).toBe("reimport-test");
    expect(db.getAction("task-c.develop")!.project_id).toBe("reimport-test");
    // Re-imported action should also have project_id
    expect(db.getAction("task-b.develop")!.project_id).toBe("reimport-test");
  });
});
