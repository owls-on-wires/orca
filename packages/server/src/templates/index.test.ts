import { describe, expect, test } from "bun:test";
import { formatVariable, buildTaskVars, applyVars } from "./index";

describe("formatVariable", () => {
  test("strings pass through", () => {
    expect(formatVariable("key", "hello")).toBe("hello");
    expect(formatVariable("key", "")).toBe("");
  });

  test("string arrays become bullet lists", () => {
    expect(formatVariable("items", ["alpha", "beta", "gamma"])).toBe(
      "- alpha\n- beta\n- gamma",
    );
  });

  test("empty arrays become empty string", () => {
    expect(formatVariable("items", [])).toBe("");
  });

  test("objects with name/description become numbered lists", () => {
    const tests = [
      { name: "test_a", description: "Does A" },
      { name: "test_b", description: "Does B" },
    ];
    const result = formatVariable("tests", tests);
    expect(result).toBe("1. **test_a**: Does A\n2. **test_b**: Does B");
  });

  test("objects with name but no description", () => {
    const items = [{ name: "test_a" }];
    const result = formatVariable("tests", items);
    expect(result).toBe("1. **test_a**: ");
  });

  test("description is trimmed", () => {
    const items = [{ name: "t", description: "  spaces  \n  " }];
    const result = formatVariable("tests", items);
    expect(result).toContain("spaces");
    expect(result).not.toContain("  spaces  ");
  });

  test("other types are JSON serialized", () => {
    expect(formatVariable("num", 42)).toBe("42");
    expect(formatVariable("obj", { key: "val" })).toContain('"key"');
    expect(formatVariable("bool", true)).toBe("true");
  });

  test("null is JSON serialized", () => {
    expect(formatVariable("n", null)).toBe("null");
  });
});

describe("buildTaskVars", () => {
  test("sets task_id and task_title", () => {
    const vars = buildTaskVars("dev_socket", "Test Socket", {}, {});
    expect(vars.task_id).toBe("dev_socket");
    expect(vars.task_title).toBe("Test Socket");
  });

  test("includes extras", () => {
    const vars = buildTaskVars("x", "X", {}, { project_dir: "/project", data_dir: ".orca" });
    expect(vars.project_dir).toBe("/project");
    expect(vars.data_dir).toBe(".orca");
  });

  test("formats variables from bag", () => {
    const vars = buildTaskVars("x", "X", {
      description: "A feature",
      understand_focus: ["Event loop", "Editor struct"],
    }, {});
    expect(vars.description).toBe("A feature");
    expect(vars.understand_focus).toBe("- Event loop\n- Editor struct");
  });

  test("tests key produces test_list", () => {
    const vars = buildTaskVars("x", "X", {
      tests: [
        { name: "test_a", description: "Does A" },
        { name: "test_b", description: "Does B" },
      ],
    }, {});
    expect(vars.test_list).toBe("1. **test_a**: Does A\n2. **test_b**: Does B");
    // Also available under its original key
    expect(vars.tests).toBeDefined();
  });

  test("empty variables produce no extra keys", () => {
    const vars = buildTaskVars("x", "X", {}, {});
    expect(Object.keys(vars)).toEqual(["task_id", "task_title"]);
  });
});

describe("applyVars", () => {
  test("replaces orca.* vars in pass 1", () => {
    const result = applyVars("Iteration {orca.iteration}", {
      "orca.iteration": "3",
    });
    expect(result).toBe("Iteration 3");
  });

  test("replaces user vars in pass 2", () => {
    const result = applyVars("Phase: {phase_name}", {
      phase_name: "dev_socket",
    });
    expect(result).toBe("Phase: dev_socket");
  });

  test("both passes work together", () => {
    const result = applyVars("Iter {orca.iteration}, phase {phase_name}", {
      "orca.iteration": "5",
      phase_name: "rename",
    });
    expect(result).toBe("Iter 5, phase rename");
  });

  test("unresolved orca vars are left as-is", () => {
    const result = applyVars("Cost: {orca.total_cost}", {});
    expect(result).toBe("Cost: {orca.total_cost}");
  });

  test("unresolved user vars are left as-is", () => {
    const result = applyVars("Phase: {phase_name}", {});
    expect(result).toBe("Phase: {phase_name}");
  });

  test("replaces all occurrences of user vars", () => {
    const result = applyVars("{x} and {x}", { x: "hello" });
    expect(result).toBe("hello and hello");
  });

  test("orca vars do not interfere with user vars", () => {
    const result = applyVars("{orca.x} {x}", {
      "orca.x": "orca_val",
      x: "user_val",
    });
    expect(result).toBe("orca_val user_val");
  });

  test("empty template", () => {
    expect(applyVars("", { x: "y" })).toBe("");
  });

  test("no vars in template", () => {
    expect(applyVars("plain text", { x: "y" })).toBe("plain text");
  });
});
