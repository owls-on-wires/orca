import { describe, expect, test } from "bun:test";
import { mergeTasks, validateConfig } from "./loader";
import type { Task, TaskDefaults, ResolvedTask } from "./schema";

describe("validateConfig", () => {
  test("accepts minimal valid config", () => {
    const config = {
      name: "test",
      tasks: { list: [{ id: "hello" }] },
      workflow: { loop: ["eval"] },
    };
    expect(validateConfig(config)).toBe(true);
  });

  test("accepts full config", () => {
    const config = {
      name: "henry",
      project_dir: ".",
      model: "opus",
      tasks: {
        file: "features.yaml",
        defaults: {
          budget: { max_iterations: 10 },
          variables: { principle: "test" },
        },
      },
      eval: { command: "cargo test", parser: "cargo_test", timeout: 300 },
      workflow: { setup: "setup", pre: ["understand"], loop: ["eval", "develop"], post: ["regression"] },
      stages: { develop: { toolset: "all", max_turns: 150, escalation: true, supervisor: true } },
      git: { enabled: true, snapshot_before: "develop", commit_after: "loop" },
      scope: { writable: ["src/**"], readable: ["**"] },
      budget: { max_iterations: 10, max_cost: 80, stuck_window: 3 },
      supervisor: { model: "opus", toolset: "all", max_turns: 40 },
      notifications: { on_escalation: true, channels: [{ type: "command", run: "echo '{message}'" }] },
      orca: { max_iterations: 10, max_cost: 80 },
    };
    expect(validateConfig(config)).toBe(true);
  });

  test("rejects missing name", () => {
    expect(validateConfig({ tasks: { list: [] }, workflow: { loop: ["e"] } })).toBe(false);
  });

  test("rejects missing workflow", () => {
    expect(validateConfig({ name: "t", tasks: { list: [] } })).toBe(false);
  });

  test("rejects missing tasks", () => {
    expect(validateConfig({ name: "t", workflow: { loop: ["e"] } })).toBe(false);
  });

  test("rejects invalid parser", () => {
    const config = {
      name: "t",
      tasks: { list: [{ id: "x" }] },
      workflow: { loop: ["e"] },
      eval: { parser: "invalid_parser" },
    };
    expect(validateConfig(config)).toBe(false);
  });

  test("rejects invalid toolset", () => {
    const config = {
      name: "t",
      tasks: { list: [{ id: "x" }] },
      workflow: { loop: ["e"] },
      stages: { develop: { toolset: "invalid" } },
    };
    expect(validateConfig(config)).toBe(false);
  });

  test("rejects invalid task id pattern", () => {
    const config = {
      name: "t",
      tasks: { list: [{ id: "Invalid-ID" }] },
      workflow: { loop: ["e"] },
    };
    expect(validateConfig(config)).toBe(false);
  });

  test("accepts valid task id patterns", () => {
    const config = {
      name: "t",
      tasks: { list: [{ id: "dev_socket" }, { id: "auto-reload" }, { id: "a123" }] },
      workflow: { loop: ["e"] },
    };
    expect(validateConfig(config)).toBe(true);
  });

  test("rejects empty loop", () => {
    const config = {
      name: "t",
      tasks: { list: [{ id: "x" }] },
      workflow: { loop: [] },
    };
    expect(validateConfig(config)).toBe(false);
  });

  test("rejects unknown top-level keys", () => {
    const config = {
      name: "t",
      tasks: { list: [{ id: "x" }] },
      workflow: { loop: ["e"] },
      unknown_key: true,
    };
    expect(validateConfig(config)).toBe(false);
  });
});

describe("mergeTasks", () => {
  const baseTask: Task = { id: "dev_socket" };

  test("no defaults produces resolved task with empty defaults", () => {
    const resolved = mergeTasks(undefined, baseTask);
    expect(resolved.id).toBe("dev_socket");
    expect(resolved.title).toBe("dev_socket"); // falls back to id
    expect(resolved.tags).toEqual([]);
    expect(resolved.depends_on).toEqual([]);
    expect(resolved.variables).toEqual({});
  });

  test("defaults fill missing task fields", () => {
    const defaults: TaskDefaults = {
      tags: ["core"],
      budget: { max_iterations: 10, max_cost: 50 },
      variables: { principle: "Follow patterns." },
    };
    const resolved = mergeTasks(defaults, baseTask);
    expect(resolved.tags).toEqual(["core"]);
    expect(resolved.budget.max_iterations).toBe(10);
    expect(resolved.variables.principle).toBe("Follow patterns.");
  });

  test("task values override defaults for scalars", () => {
    const defaults: TaskDefaults = {
      budget: { max_iterations: 10, max_cost: 50 },
    };
    const task: Task = {
      id: "x",
      budget: { max_iterations: 20 },
    };
    const resolved = mergeTasks(defaults, task);
    expect(resolved.budget.max_iterations).toBe(20);
    // max_cost should inherit from defaults
    expect(resolved.budget.max_cost).toBe(50);
  });

  test("task tags replace default tags", () => {
    const defaults: TaskDefaults = { tags: ["default"] };
    const task: Task = { id: "x", tags: ["custom"] };
    const resolved = mergeTasks(defaults, task);
    expect(resolved.tags).toEqual(["custom"]);
  });

  test("task depends_on replaces default depends_on", () => {
    const defaults: TaskDefaults = { depends_on: ["a"] };
    const task: Task = { id: "x", depends_on: ["b", "c"] };
    const resolved = mergeTasks(defaults, task);
    expect(resolved.depends_on).toEqual(["b", "c"]);
  });

  test("variables are deep merged (task extends defaults)", () => {
    const defaults: TaskDefaults = {
      variables: { principle: "Follow patterns.", shared: "value" },
    };
    const task: Task = {
      id: "x",
      variables: { description: "A feature", principle: "Override." },
    };
    const resolved = mergeTasks(defaults, task);
    expect(resolved.variables.principle).toBe("Override."); // task wins
    expect(resolved.variables.shared).toBe("value"); // inherited
    expect(resolved.variables.description).toBe("A feature"); // task-only
  });

  test("stages are deep merged per stage", () => {
    const defaults: TaskDefaults = {
      stages: {
        develop: { max_turns: 100, toolset: "all" },
        analyze: { max_turns: 40 },
      },
    };
    const task: Task = {
      id: "x",
      stages: { develop: { max_turns: 200 } },
    };
    const resolved = mergeTasks(defaults, task);
    expect(resolved.stages!.develop.max_turns).toBe(200); // task wins
    expect(resolved.stages!.develop.toolset).toBe("all"); // inherited
    expect(resolved.stages!.analyze.max_turns).toBe(40); // inherited
  });

  test("task title falls back to id", () => {
    const resolved = mergeTasks(undefined, { id: "my_task" });
    expect(resolved.title).toBe("my_task");
  });

  test("task title is preserved when set", () => {
    const resolved = mergeTasks(undefined, { id: "x", title: "My Task" });
    expect(resolved.title).toBe("My Task");
  });
});
