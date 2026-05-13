import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, writeFileSync, readFileSync, mkdirSync, existsSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import {
  readTool,
  writeTool,
  editTool,
  bashTool,
  globTool,
  grepTool,
  getTool,
  getToolDefinitions,
} from "./tools";
import type { ToolContext } from "./types";

let tmpDir: string;
let ctx: ToolContext;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "harness-tools-"));
  ctx = { cwd: tmpDir };
});

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

describe("tool registry", () => {
  test("all 6 tools are registered", () => {
    const defs = getToolDefinitions();
    const names = defs.map((d) => d.name).sort();
    expect(names).toEqual(["Bash", "Edit", "Glob", "Grep", "Read", "Write"]);
  });

  test("getTool returns registered tool", () => {
    const tool = getTool("Read");
    expect(tool).toBeDefined();
    expect(tool!.definition.name).toBe("Read");
  });

  test("getTool returns undefined for unknown", () => {
    expect(getTool("NonExistent")).toBeUndefined();
  });

  test("all definitions have input_schema with required", () => {
    for (const def of getToolDefinitions()) {
      expect(def.input_schema).toBeDefined();
      expect((def.input_schema as any).type).toBe("object");
      expect((def.input_schema as any).required).toBeDefined();
    }
  });
});

// ---------------------------------------------------------------------------
// Read
// ---------------------------------------------------------------------------

describe("Read tool", () => {
  test("reads entire file with line numbers", async () => {
    writeFileSync(join(tmpDir, "hello.txt"), "line one\nline two\nline three");
    const result = await readTool({ file_path: join(tmpDir, "hello.txt") }, ctx);

    expect(result.isError).toBeFalsy();
    expect(result.output).toContain("1\tline one");
    expect(result.output).toContain("2\tline two");
    expect(result.output).toContain("3\tline three");
  });

  test("reads with offset and limit", async () => {
    writeFileSync(join(tmpDir, "lines.txt"), "a\nb\nc\nd\ne");
    const result = await readTool({ file_path: join(tmpDir, "lines.txt"), offset: 2, limit: 2 }, ctx);

    expect(result.output).toContain("2\tb");
    expect(result.output).toContain("3\tc");
    expect(result.output).not.toContain("1\ta");
    expect(result.output).not.toContain("4\td");
  });

  test("returns error for missing file", async () => {
    const result = await readTool({ file_path: join(tmpDir, "nope.txt") }, ctx);
    expect(result.isError).toBe(true);
    expect(result.output).toContain("Error reading");
  });

  test("resolves relative paths from cwd", async () => {
    writeFileSync(join(tmpDir, "rel.txt"), "content");
    const result = await readTool({ file_path: "rel.txt" }, { cwd: tmpDir });
    expect(result.isError).toBeFalsy();
    expect(result.output).toContain("content");
  });
});

// ---------------------------------------------------------------------------
// Write
// ---------------------------------------------------------------------------

describe("Write tool", () => {
  test("creates file with content", async () => {
    const path = join(tmpDir, "new.txt");
    const result = await writeTool({ file_path: path, content: "hello\nworld" }, ctx);

    expect(result.isError).toBeFalsy();
    expect(result.output).toContain("2 lines");
    expect(readFileSync(path, "utf8")).toBe("hello\nworld");
  });

  test("creates parent directories", async () => {
    const path = join(tmpDir, "a", "b", "deep.txt");
    const result = await writeTool({ file_path: path, content: "deep" }, ctx);

    expect(result.isError).toBeFalsy();
    expect(readFileSync(path, "utf8")).toBe("deep");
  });

  test("overwrites existing file", async () => {
    const path = join(tmpDir, "exist.txt");
    writeFileSync(path, "old");
    await writeTool({ file_path: path, content: "new" }, ctx);
    expect(readFileSync(path, "utf8")).toBe("new");
  });
});

// ---------------------------------------------------------------------------
// Edit
// ---------------------------------------------------------------------------

describe("Edit tool", () => {
  test("replaces unique string", async () => {
    const path = join(tmpDir, "edit.txt");
    writeFileSync(path, "hello world");
    const result = await editTool({
      file_path: path,
      old_string: "world",
      new_string: "earth",
    }, ctx);

    expect(result.isError).toBeFalsy();
    expect(readFileSync(path, "utf8")).toBe("hello earth");
  });

  test("errors on non-unique string without replace_all", async () => {
    const path = join(tmpDir, "dup.txt");
    writeFileSync(path, "aaa bbb aaa");
    const result = await editTool({
      file_path: path,
      old_string: "aaa",
      new_string: "ccc",
    }, ctx);

    expect(result.isError).toBe(true);
    expect(result.output).toContain("not unique");
    // File unchanged
    expect(readFileSync(path, "utf8")).toBe("aaa bbb aaa");
  });

  test("replace_all replaces all occurrences", async () => {
    const path = join(tmpDir, "all.txt");
    writeFileSync(path, "aaa bbb aaa");
    const result = await editTool({
      file_path: path,
      old_string: "aaa",
      new_string: "ccc",
      replace_all: true,
    }, ctx);

    expect(result.isError).toBeFalsy();
    expect(readFileSync(path, "utf8")).toBe("ccc bbb ccc");
  });

  test("errors when old_string not found", async () => {
    const path = join(tmpDir, "miss.txt");
    writeFileSync(path, "hello");
    const result = await editTool({
      file_path: path,
      old_string: "nope",
      new_string: "yes",
    }, ctx);

    expect(result.isError).toBe(true);
    expect(result.output).toContain("not found");
  });

  test("errors on missing file", async () => {
    const result = await editTool({
      file_path: join(tmpDir, "nope.txt"),
      old_string: "a",
      new_string: "b",
    }, ctx);

    expect(result.isError).toBe(true);
  });

  test("handles multiline replacements", async () => {
    const path = join(tmpDir, "multi.txt");
    writeFileSync(path, "function foo() {\n  return 1;\n}");
    const result = await editTool({
      file_path: path,
      old_string: "function foo() {\n  return 1;\n}",
      new_string: "function foo() {\n  return 2;\n}",
    }, ctx);

    expect(result.isError).toBeFalsy();
    expect(readFileSync(path, "utf8")).toBe("function foo() {\n  return 2;\n}");
  });
});

// ---------------------------------------------------------------------------
// Bash
// ---------------------------------------------------------------------------

describe("Bash tool", () => {
  test("runs command and captures stdout", async () => {
    const result = await bashTool({ command: "echo hello" }, ctx);
    expect(result.output).toContain("hello");
    expect(result.isError).toBeFalsy();
  });

  test("captures stderr", async () => {
    const result = await bashTool({ command: "echo err >&2" }, ctx);
    expect(result.output).toContain("STDERR:");
    expect(result.output).toContain("err");
  });

  test("reports exit code on failure", async () => {
    const result = await bashTool({ command: "exit 42" }, ctx);
    expect(result.output).toContain("Exit code: 42");
  });

  test("runs in cwd", async () => {
    writeFileSync(join(tmpDir, "marker.txt"), "found");
    const result = await bashTool({ command: "cat marker.txt" }, ctx);
    expect(result.output).toContain("found");
  });

  test("uses env from context", async () => {
    const result = await bashTool(
      { command: "echo $MY_VAR" },
      { cwd: tmpDir, env: { ...process.env, MY_VAR: "custom_value" } as Record<string, string> },
    );
    expect(result.output).toContain("custom_value");
  });

  test("timeout kills long-running command", async () => {
    const result = await bashTool({ command: "sleep 30", timeout: 0.1 }, ctx);
    // Command should be killed — either no output or error
    // The exit code won't be 0
  }, 5000);

  test("handles command that produces no output", async () => {
    const result = await bashTool({ command: "true" }, ctx);
    expect(result.output).toBe("(no output)");
  });
});

// ---------------------------------------------------------------------------
// Glob
// ---------------------------------------------------------------------------

describe("Glob tool", () => {
  test("finds files by pattern", async () => {
    writeFileSync(join(tmpDir, "a.ts"), "");
    writeFileSync(join(tmpDir, "b.ts"), "");
    writeFileSync(join(tmpDir, "c.js"), "");

    const result = await globTool({ pattern: "*.ts" }, ctx);
    expect(result.output).toContain("a.ts");
    expect(result.output).toContain("b.ts");
    expect(result.output).not.toContain("c.js");
  });

  test("finds nested files", async () => {
    mkdirSync(join(tmpDir, "src"), { recursive: true });
    writeFileSync(join(tmpDir, "src", "index.ts"), "");
    writeFileSync(join(tmpDir, "src", "lib.ts"), "");

    const result = await globTool({ pattern: "**/*.ts" }, ctx);
    expect(result.output).toContain("index.ts");
    expect(result.output).toContain("lib.ts");
  });

  test("returns no matches message", async () => {
    const result = await globTool({ pattern: "*.xyz" }, ctx);
    expect(result.output).toBe("(no matches)");
  });

  test("respects path parameter", async () => {
    mkdirSync(join(tmpDir, "sub"), { recursive: true });
    writeFileSync(join(tmpDir, "top.ts"), "");
    writeFileSync(join(tmpDir, "sub", "deep.ts"), "");

    const result = await globTool({ pattern: "*.ts", path: "sub" }, ctx);
    expect(result.output).toContain("deep.ts");
    expect(result.output).not.toContain("top.ts");
  });
});

// ---------------------------------------------------------------------------
// Grep
// ---------------------------------------------------------------------------

describe("Grep tool", () => {
  test("finds matching files", async () => {
    writeFileSync(join(tmpDir, "a.txt"), "hello world");
    writeFileSync(join(tmpDir, "b.txt"), "goodbye");

    const result = await grepTool({ pattern: "hello", path: tmpDir }, ctx);
    expect(result.output).toContain("a.txt");
    expect(result.output).not.toContain("b.txt");
  });

  test("content mode shows matching lines", async () => {
    writeFileSync(join(tmpDir, "code.ts"), "function foo() {\n  return 42;\n}\n");

    const result = await grepTool({
      pattern: "return",
      path: join(tmpDir, "code.ts"),
      output_mode: "content",
    }, ctx);

    expect(result.output).toContain("return 42");
  });

  test("returns no matches for non-matching pattern", async () => {
    writeFileSync(join(tmpDir, "x.txt"), "hello");
    const result = await grepTool({ pattern: "zzzzz", path: tmpDir }, ctx);
    expect(result.output).toBe("(no matches)");
  });

  test("supports regex patterns", async () => {
    writeFileSync(join(tmpDir, "re.txt"), "foo123bar\nbaz456qux");
    const result = await grepTool({
      pattern: "\\d+",
      path: join(tmpDir, "re.txt"),
      output_mode: "content",
    }, ctx);
    expect(result.output).toContain("123");
    expect(result.output).toContain("456");
  });
});
