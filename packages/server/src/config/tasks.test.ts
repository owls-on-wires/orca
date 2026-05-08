import { describe, expect, test } from "bun:test";
import { resolveExecutionOrder, filterTasks, validateDependencies } from "./tasks";
import type { ResolvedTask } from "./schema";

/** Helper to create a minimal resolved task. */
function task(id: string, deps: string[] = [], tags: string[] = []): ResolvedTask {
  return {
    id,
    title: id,
    tags,
    depends_on: deps,
    eval: {},
    budget: {},
    variables: {},
  };
}

describe("validateDependencies", () => {
  test("no errors for valid dependencies", () => {
    const tasks = [task("a"), task("b", ["a"]), task("c", ["a", "b"])];
    expect(validateDependencies(tasks)).toEqual([]);
  });

  test("detects missing dependency", () => {
    const tasks = [task("a"), task("b", ["missing"])];
    const errors = validateDependencies(tasks);
    expect(errors.length).toBeGreaterThan(0);
    expect(errors[0]).toContain("missing");
  });

  test("detects cycle: A → B → A", () => {
    const tasks = [task("a", ["b"]), task("b", ["a"])];
    const errors = validateDependencies(tasks);
    expect(errors.length).toBeGreaterThan(0);
    // Should mention cycle
    expect(errors.some(e => e.toLowerCase().includes("cycle"))).toBe(true);
  });

  test("detects self-dependency", () => {
    const tasks = [task("a", ["a"])];
    const errors = validateDependencies(tasks);
    expect(errors.length).toBeGreaterThan(0);
  });

  test("detects longer cycle: A → B → C → A", () => {
    const tasks = [task("a", ["c"]), task("b", ["a"]), task("c", ["b"])];
    const errors = validateDependencies(tasks);
    expect(errors.length).toBeGreaterThan(0);
  });

  test("no dependencies = no errors", () => {
    const tasks = [task("a"), task("b"), task("c")];
    expect(validateDependencies(tasks)).toEqual([]);
  });

  test("empty task list = no errors", () => {
    expect(validateDependencies([])).toEqual([]);
  });

  test("detects duplicate task IDs", () => {
    const tasks = [task("a"), task("a")];
    const errors = validateDependencies(tasks);
    expect(errors.length).toBeGreaterThan(0);
    expect(errors.some(e => e.toLowerCase().includes("duplicate"))).toBe(true);
  });
});

describe("resolveExecutionOrder", () => {
  test("linear chain: a → b → c", () => {
    const tasks = [task("c", ["b"]), task("a"), task("b", ["a"])];
    const order = resolveExecutionOrder(tasks);
    const ids = order.map(t => t.id);
    expect(ids.indexOf("a")).toBeLessThan(ids.indexOf("b"));
    expect(ids.indexOf("b")).toBeLessThan(ids.indexOf("c"));
  });

  test("diamond: a → b, a → c, b+c → d", () => {
    const tasks = [
      task("d", ["b", "c"]),
      task("b", ["a"]),
      task("c", ["a"]),
      task("a"),
    ];
    const order = resolveExecutionOrder(tasks);
    const ids = order.map(t => t.id);
    expect(ids.indexOf("a")).toBeLessThan(ids.indexOf("b"));
    expect(ids.indexOf("a")).toBeLessThan(ids.indexOf("c"));
    expect(ids.indexOf("b")).toBeLessThan(ids.indexOf("d"));
    expect(ids.indexOf("c")).toBeLessThan(ids.indexOf("d"));
  });

  test("no dependencies preserves original order", () => {
    const tasks = [task("x"), task("y"), task("z")];
    const order = resolveExecutionOrder(tasks);
    expect(order.map(t => t.id)).toEqual(["x", "y", "z"]);
  });

  test("single task", () => {
    const tasks = [task("only")];
    const order = resolveExecutionOrder(tasks);
    expect(order.map(t => t.id)).toEqual(["only"]);
  });

  test("empty list", () => {
    expect(resolveExecutionOrder([])).toEqual([]);
  });

  test("parallel-eligible tasks both appear after their dependency", () => {
    // a → b, a → c (b and c can be parallel)
    const tasks = [task("a"), task("b", ["a"]), task("c", ["a"])];
    const order = resolveExecutionOrder(tasks);
    const ids = order.map(t => t.id);
    expect(ids[0]).toBe("a");
    // b and c both after a, order between them doesn't matter
    expect(ids).toContain("b");
    expect(ids).toContain("c");
  });
});

describe("filterTasks", () => {
  const tasks = [
    task("a", [], ["prereq", "infra"]),
    task("b", [], ["prereq"]),
    task("c", [], ["feature", "ai"]),
    task("d", [], ["feature"]),
    task("e", [], []),
  ];

  test("include filters to matching tags", () => {
    const result = filterTasks(tasks, ["prereq"]);
    expect(result.map(t => t.id)).toEqual(["a", "b"]);
  });

  test("include with multiple tags = OR", () => {
    const result = filterTasks(tasks, ["prereq", "ai"]);
    expect(result.map(t => t.id)).toEqual(["a", "b", "c"]);
  });

  test("exclude removes matching tags", () => {
    const result = filterTasks(tasks, undefined, ["ai"]);
    expect(result.map(t => t.id)).toEqual(["a", "b", "d", "e"]);
  });

  test("include + exclude combined", () => {
    const result = filterTasks(tasks, ["feature"], ["ai"]);
    expect(result.map(t => t.id)).toEqual(["d"]);
  });

  test("no filters returns all", () => {
    const result = filterTasks(tasks);
    expect(result.length).toBe(5);
  });

  test("untagged tasks excluded by include filter", () => {
    const result = filterTasks(tasks, ["prereq"]);
    expect(result.map(t => t.id)).not.toContain("e");
  });

  test("untagged tasks kept by exclude filter", () => {
    const result = filterTasks(tasks, undefined, ["prereq"]);
    expect(result.map(t => t.id)).toContain("e");
  });
});
