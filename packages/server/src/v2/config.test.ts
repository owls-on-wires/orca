import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { OrcaDatabase } from "./db";
import { expandConfig } from "./config";

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
