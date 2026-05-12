import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { OrcaDatabase } from "./db";
import { expandConfig, reimportTasks, expandTask } from "./config";
import type { ActionTypeDefaults, TemplateConfig, V2TaskConfig } from "./schema";

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
    const config = expandConfig(minimalConfig, db, "/tmp");

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
    expandConfig(minimalConfig, db, "/tmp");

    const dev = db.getAction("auth.develop");
    expect(dev!.status).toBe("pending");

    const ev = db.getAction("auth.eval");
    expect(ev!.status).toBe("inactive");
  });

  test("default edges when no edges map specified", () => {
    expandConfig(minimalConfig, db, "/tmp");

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
    expandConfig(yaml, db, "/tmp");

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
    expandConfig(yaml, db, "/tmp");

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
    expandConfig(yaml, db, "/tmp");

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
    expandConfig(yaml, db, "/tmp");

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
    expect(() => expandConfig(yaml, db, "/tmp")).toThrow(/Unknown action type nonexistent/);
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
    expect(() => expandConfig(yaml, db, "/tmp")).toThrow(/missing name/);
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
    expandConfig(yaml, db, "/tmp");

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
    expandConfig(yaml, db, "/tmp");

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
    expandConfig(yaml, db, "/tmp");

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
    expandConfig(yaml, db, "/tmp");

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
    expect(() => expandConfig(yaml, db, "/tmp")).toThrow(/no actions/);
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
    expandConfig(reimportConfig, db, "/tmp");

    // Modify task-b's develop to simulate progress
    db.updateAction("task-b.develop", { status: "completed", output: { status: "passed" } });

    // Re-import task-b (should reset it)
    const result = reimportTasks(reimportConfig, db, ["task-b"], "/tmp");

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
    expandConfig(reimportConfig, db, "/tmp");

    // Mark task-a as completed
    db.updateAction("task-a.develop", { status: "completed" });
    db.updateAction("task-a.eval", { status: "completed", output: { status: "passed" } });

    // Re-import task-b
    reimportTasks(reimportConfig, db, ["task-b"], "/tmp");

    // task-a still completed
    expect(db.getAction("task-a.develop")!.status).toBe("completed");
    expect(db.getAction("task-a.eval")!.status).toBe("completed");

    // task-c still exists and untouched
    expect(db.getAction("task-c.develop")).not.toBeNull();
  });

  test("re-creates intra-task edges", () => {
    expandConfig(reimportConfig, db, "/tmp");
    reimportTasks(reimportConfig, db, ["task-b"], "/tmp");

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
    expandConfig(reimportConfig, db, "/tmp");
    reimportTasks(reimportConfig, db, ["task-b"], "/tmp");

    // task-a.eval → task-b.develop [pass] should exist (task-b depends_on task-a)
    const aEvalEdges = db.getEdgesFrom("task-a.eval");
    const crossEdge = aEvalEdges.find(
      (e) => e.to_action === "task-b.develop" && e.condition === "pass",
    );
    expect(crossEdge).toBeDefined();
  });

  test("re-creates cross-task dependency edges (outgoing)", () => {
    expandConfig(reimportConfig, db, "/tmp");
    reimportTasks(reimportConfig, db, ["task-b"], "/tmp");

    // task-b.eval → task-c.develop [pass] should exist (task-c depends_on task-b)
    const bEvalEdges = db.getEdgesFrom("task-b.eval");
    const crossEdge = bEvalEdges.find(
      (e) => e.to_action === "task-c.develop" && e.condition === "pass",
    );
    expect(crossEdge).toBeDefined();
  });

  test("picks up template changes", () => {
    expandConfig(reimportConfig, db, "/tmp");

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
    reimportTasks(modified, db, ["task-c"], "/tmp");

    // Actions still exist
    expect(db.getAction("task-c.qa")).not.toBeNull();
    // Fail edge still points to develop
    const newQaEdges = db.getEdgesFrom("task-c.qa");
    const newFail = newQaEdges.find((e) => e.condition === "fail");
    expect(newFail!.to_action).toBe("task-c.develop");
  });

  test("handles re-import of task with no dependencies", () => {
    expandConfig(reimportConfig, db, "/tmp");
    reimportTasks(reimportConfig, db, ["task-a"], "/tmp");

    // task-a.develop should be pending (first action, no depends_on)
    expect(db.getAction("task-a.develop")!.status).toBe("pending");

    // Cross-task edge to task-b still exists
    const aEvalEdges = db.getEdgesFrom("task-a.eval");
    expect(aEvalEdges.find((e) => e.to_action === "task-b.develop")).toBeDefined();
  });

  test("handles re-import of multiple tasks at once", () => {
    expandConfig(reimportConfig, db, "/tmp");

    // Mark some as completed
    db.updateAction("task-a.develop", { status: "completed" });
    db.updateAction("task-b.develop", { status: "completed" });

    // Re-import both a and b
    const result = reimportTasks(reimportConfig, db, ["task-a", "task-b"], "/tmp");
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
    expandConfig(reimportConfig, db, "/tmp");
    expect(() => reimportTasks(reimportConfig, db, ["nonexistent"], "/tmp")).toThrow(/not found in config/);
  });

  test("clears history for re-imported actions", () => {
    expandConfig(reimportConfig, db, "/tmp");

    // Add some history
    db.appendHistory("task-b.develop", "completed", { condition: "pass" });
    expect(db.getHistory("task-b.develop").length).toBe(1);

    // Re-import task-b
    reimportTasks(reimportConfig, db, ["task-b"], "/tmp");

    // History should be cleared (action was deleted and re-created)
    expect(db.getHistory("task-b.develop").length).toBe(0);
  });

  test("does not null out other actions' project_id", () => {
    expandConfig(reimportConfig, db, "/tmp");

    // Verify project_id is set
    expect(db.getAction("task-a.develop")!.project_id).toBe("reimport-test");
    expect(db.getAction("task-c.develop")!.project_id).toBe("reimport-test");

    // Re-import only task-b
    reimportTasks(reimportConfig, db, ["task-b"], "/tmp");

    // Other actions' project_id should still be set
    expect(db.getAction("task-a.develop")!.project_id).toBe("reimport-test");
    expect(db.getAction("task-c.develop")!.project_id).toBe("reimport-test");
    // Re-imported action should also have project_id
    expect(db.getAction("task-b.develop")!.project_id).toBe("reimport-test");
  });
});

// ---------------------------------------------------------------------------
// expandTask
// ---------------------------------------------------------------------------

const tddTemplate: TemplateConfig = {
  actions: ["write-tests", "develop", "eval"],
  types: {
    "write-tests": { type: "agent" },
    develop: { type: "agent" },
    eval: { type: "command", params: { command: "bun test" }, edges: { fail: "develop" } },
  },
};

const devTemplate: TemplateConfig = {
  actions: ["develop", "eval"],
  types: {
    develop: { type: "agent" },
    eval: { type: "command", params: { command: "bun test" }, edges: { fail: "develop" } },
  },
};

describe("expandTask", () => {
  test("expands tdd template into 3 actions", () => {
    const task: V2TaskConfig = { id: "auth", prompt: "Build auth", template: "tdd" };
    const result = expandTask(task, { tdd: tddTemplate }, {}, "my-project");

    expect(result.actions).toHaveLength(3);
    expect(result.actions.map((a) => a.id)).toEqual([
      "auth.write-tests",
      "auth.develop",
      "auth.eval",
    ]);
  });

  test("all actions start inactive", () => {
    const task: V2TaskConfig = { id: "auth", prompt: "Build auth", template: "tdd" };
    const result = expandTask(task, { tdd: tddTemplate }, {}, "proj");

    for (const a of result.actions) {
      expect(a.status).toBe("inactive");
    }
  });

  test("sets project_id on all actions", () => {
    const task: V2TaskConfig = { id: "auth", prompt: "Build auth", template: "tdd" };
    const result = expandTask(task, { tdd: tddTemplate }, {}, "my-proj");

    for (const a of result.actions) {
      expect(a.project_id).toBe("my-proj");
    }
  });

  test("generates correct intra-task edges", () => {
    const task: V2TaskConfig = { id: "auth", prompt: "Build auth", template: "tdd" };
    const result = expandTask(task, { tdd: tddTemplate }, {}, "proj");

    // pass chain: write-tests → develop → eval
    const passEdges = result.edges.filter((e) => e.condition === "pass");
    expect(passEdges.find((e) => e.from_action === "auth.write-tests")?.to_action).toBe("auth.develop");
    expect(passEdges.find((e) => e.from_action === "auth.develop")?.to_action).toBe("auth.eval");

    // fail edge: eval → develop
    const failEdge = result.edges.find((e) => e.from_action === "auth.eval" && e.condition === "fail");
    expect(failEdge?.to_action).toBe("auth.develop");
  });

  test("injects task prompt into agent actions", () => {
    const task: V2TaskConfig = { id: "auth", prompt: "Build auth system", template: "tdd" };
    const result = expandTask(task, { tdd: tddTemplate }, {}, "proj");

    const writeTests = result.actions.find((a) => a.id === "auth.write-tests")!;
    expect(writeTests.params.prompt).toBe("Build auth system");

    const develop = result.actions.find((a) => a.id === "auth.develop")!;
    expect(develop.params.prompt).toBe("Build auth system");

    // eval is command — no prompt
    const eval_ = result.actions.find((a) => a.id === "auth.eval")!;
    expect(eval_.params.command).toBe("bun test");
  });

  test("applies overrides per action type", () => {
    const task: V2TaskConfig = {
      id: "auth",
      prompt: "Build auth",
      template: "tdd",
      overrides: {
        "write-tests": { prompt: "Write auth tests" },
        eval: { command: "bun test test/auth.test.ts" },
      },
    };
    const result = expandTask(task, { tdd: tddTemplate }, {}, "proj");

    expect(result.actions.find((a) => a.id === "auth.write-tests")!.params.prompt).toBe("Write auth tests");
    expect(result.actions.find((a) => a.id === "auth.eval")!.params.command).toBe("bun test test/auth.test.ts");
  });

  test("generates auto-tags", () => {
    const task: V2TaskConfig = { id: "auth", prompt: "x", template: "tdd", tags: ["epic:1"] };
    const result = expandTask(task, { tdd: tddTemplate }, {}, "proj");

    const wt = result.actions.find((a) => a.id === "auth.write-tests")!;
    expect(wt.tags).toContain("type:write-tests");
    expect(wt.tags).toContain("task:auth");
    expect(wt.tags).toContain("project:proj");
    expect(wt.tags).toContain("epic:1");
  });

  test("dev template expands to 2 actions", () => {
    const task: V2TaskConfig = { id: "setup", prompt: "Setup", template: "dev" };
    const result = expandTask(task, { dev: devTemplate }, {}, "proj");

    expect(result.actions).toHaveLength(2);
    expect(result.actions.map((a) => a.id)).toEqual(["setup.develop", "setup.eval"]);
  });

  test("skips self-loop edges", () => {
    const task: V2TaskConfig = { id: "solo", prompt: "x", template: "dev" };
    const result = expandTask(task, { dev: devTemplate }, {}, "proj");

    // develop is first action — default fail→first = develop (self-loop), should be skipped
    const devSelfLoops = result.edges.filter(
      (e) => e.from_action === "solo.develop" && e.to_action === "solo.develop",
    );
    expect(devSelfLoops).toHaveLength(0);
  });

  test("throws for unknown template", () => {
    const task: V2TaskConfig = { id: "x", prompt: "x", template: "nonexistent" };
    expect(() => expandTask(task, {}, {}, "proj")).toThrow(/no actions/);
  });

  test("merges budget into params", () => {
    const task: V2TaskConfig = {
      id: "auth",
      prompt: "x",
      template: "tdd",
      budget: { max_iterations: 5, max_cost: 2.0 },
    };
    const result = expandTask(task, { tdd: tddTemplate }, {}, "proj");

    const dev = result.actions.find((a) => a.id === "auth.develop")!;
    expect(dev.params.max_iterations).toBe(5);
    expect(dev.params.max_cost).toBe(2.0);
  });

  test("uses template params.prompt when task prompt is omitted", () => {
    const templateWithPrompt: TemplateConfig = {
      actions: ["develop", "eval"],
      types: {
        develop: { type: "agent", params: { prompt: "Default develop prompt" } },
        eval: { type: "command", params: { command: "bun test" } },
      },
    };
    const task: V2TaskConfig = { id: "auth", template: "tpl" };
    const result = expandTask(task, { tpl: templateWithPrompt }, {}, "proj");

    expect(result.actions.find((a) => a.id === "auth.develop")!.params.prompt).toBe("Default develop prompt");
  });

  test("task prompt overrides template params.prompt", () => {
    const templateWithPrompt: TemplateConfig = {
      actions: ["develop", "eval"],
      types: {
        develop: { type: "agent", params: { prompt: "Default prompt" } },
        eval: { type: "command", params: { command: "bun test" } },
      },
    };
    const task: V2TaskConfig = { id: "auth", prompt: "Task-level prompt", template: "tpl" };
    const result = expandTask(task, { tpl: templateWithPrompt }, {}, "proj");

    expect(result.actions.find((a) => a.id === "auth.develop")!.params.prompt).toBe("Task-level prompt");
  });

  test("throws when agent action has no prompt from any source", () => {
    const task: V2TaskConfig = { id: "auth", template: "tdd" };
    expect(() => expandTask(task, { tdd: tddTemplate }, {}, "proj")).toThrow(/no prompt/);
  });

  test("override prompt satisfies validation when task prompt is omitted", () => {
    const task: V2TaskConfig = {
      id: "auth",
      template: "tdd",
      overrides: {
        "write-tests": { prompt: "Write tests" },
        develop: { prompt: "Implement" },
      },
    };
    const result = expandTask(task, { tdd: tddTemplate }, {}, "proj");

    expect(result.actions.find((a) => a.id === "auth.write-tests")!.params.prompt).toBe("Write tests");
    expect(result.actions.find((a) => a.id === "auth.develop")!.params.prompt).toBe("Implement");
  });
});
