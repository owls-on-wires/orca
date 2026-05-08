import { describe, expect, test } from "bun:test";
import { checkToolUse, scopeSystemPrompt } from "./index";
import type { ScopeConfig } from "../config/schema";

const scope: ScopeConfig = {
  writable: ["src/**"],
  readable: ["src/**", "tests/**", "tmp/builder/**"],
};

// Use an absolute-looking path prefix for the project dir
const projectDir = "/project";

describe("checkToolUse", () => {
  describe("Write/Edit (writable scope)", () => {
    test("allows writes to writable paths", () => {
      const v = checkToolUse(scope, "Write", { file_path: "/project/src/main.rs" }, projectDir);
      expect(v).toBeNull();
    });

    test("denies writes outside writable paths", () => {
      const v = checkToolUse(scope, "Write", { file_path: "/project/tests/test.rs" }, projectDir);
      expect(v).not.toBeNull();
      expect(v!.scopeType).toBe("write");
      expect(v!.toolName).toBe("Write");
    });

    test("Edit uses same writable check", () => {
      const v = checkToolUse(scope, "Edit", { file_path: "/project/tests/test.rs" }, projectDir);
      expect(v).not.toBeNull();
      expect(v!.scopeType).toBe("write");
    });

    test("denies writes outside project dir", () => {
      const v = checkToolUse(scope, "Write", { file_path: "/other/file.rs" }, projectDir);
      expect(v).not.toBeNull();
    });
  });

  describe("Read (readable scope)", () => {
    test("allows reads from readable paths", () => {
      expect(checkToolUse(scope, "Read", { file_path: "/project/src/main.rs" }, projectDir)).toBeNull();
      expect(checkToolUse(scope, "Read", { file_path: "/project/tests/test.rs" }, projectDir)).toBeNull();
      expect(checkToolUse(scope, "Read", { file_path: "/project/tmp/builder/out.json" }, projectDir)).toBeNull();
    });

    test("denies reads outside readable paths", () => {
      const v = checkToolUse(scope, "Read", { file_path: "/project/docs/readme.md" }, projectDir);
      expect(v).not.toBeNull();
      expect(v!.scopeType).toBe("read");
    });
  });

  describe("Glob/Grep (readable scope via path param)", () => {
    test("allows search in readable paths", () => {
      const v = checkToolUse(scope, "Grep", { pattern: "fn", path: "/project/src" }, projectDir);
      expect(v).toBeNull();
    });

    test("denies search outside readable paths", () => {
      const v = checkToolUse(scope, "Glob", { pattern: "*.rs", path: "/project/node_modules" }, projectDir);
      expect(v).not.toBeNull();
      expect(v!.scopeType).toBe("read");
    });
  });

  describe("Bash (not checked)", () => {
    test("Bash is never checked", () => {
      const v = checkToolUse(scope, "Bash", { command: "rm -rf /" }, projectDir);
      expect(v).toBeNull();
    });
  });

  describe("missing file_path", () => {
    test("no violation when file_path is missing", () => {
      expect(checkToolUse(scope, "Write", {}, projectDir)).toBeNull();
      expect(checkToolUse(scope, "Read", {}, projectDir)).toBeNull();
    });

    test("no violation when Grep has no path", () => {
      expect(checkToolUse(scope, "Grep", { pattern: "fn" }, projectDir)).toBeNull();
    });
  });

  describe("empty scope = no restriction", () => {
    test("empty writable allows all writes", () => {
      const open: ScopeConfig = { writable: [], readable: ["src/**"] };
      expect(checkToolUse(open, "Write", { file_path: "/project/anywhere" }, projectDir)).toBeNull();
    });

    test("empty readable allows all reads", () => {
      const open: ScopeConfig = { writable: ["src/**"], readable: [] };
      expect(checkToolUse(open, "Read", { file_path: "/project/anywhere" }, projectDir)).toBeNull();
    });

    test("undefined writable allows all writes", () => {
      const open: ScopeConfig = { readable: ["src/**"] };
      expect(checkToolUse(open, "Write", { file_path: "/project/anywhere" }, projectDir)).toBeNull();
    });
  });
});

describe("scopeSystemPrompt", () => {
  test("includes writable patterns", () => {
    const prompt = scopeSystemPrompt(scope);
    expect(prompt).toContain("src/**");
    expect(prompt).toContain("Writable");
  });

  test("includes readable patterns", () => {
    const prompt = scopeSystemPrompt(scope);
    expect(prompt).toContain("tests/**");
    expect(prompt).toContain("Readable");
  });

  test("includes restriction warning", () => {
    const prompt = scopeSystemPrompt(scope);
    expect(prompt).toContain("Do NOT access files outside this scope");
  });

  test("omits writable section when no writable patterns", () => {
    const readOnly: ScopeConfig = { readable: ["**"] };
    const prompt = scopeSystemPrompt(readOnly);
    expect(prompt).not.toContain("Writable");
    expect(prompt).toContain("Readable");
  });

  test("omits readable section when no readable patterns", () => {
    const writeOnly: ScopeConfig = { writable: ["src/**"] };
    const prompt = scopeSystemPrompt(writeOnly);
    expect(prompt).toContain("Writable");
    expect(prompt).not.toContain("Readable");
  });
});
