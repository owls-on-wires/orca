import { describe, expect, test } from "bun:test";
import { globMatch, scopeMatch } from "./matcher";

describe("globMatch", () => {
  describe("** patterns", () => {
    test("src/** matches files under src/", () => {
      expect(globMatch("src/foo.rs", "src/**")).toBe(true);
      expect(globMatch("src/nested/foo.rs", "src/**")).toBe(true);
      expect(globMatch("src/a/b/c/d.rs", "src/**")).toBe(true);
    });

    test("src/** matches the directory itself", () => {
      expect(globMatch("src", "src/**")).toBe(true);
    });

    test("src/** does not match other directories", () => {
      expect(globMatch("tests/foo.rs", "src/**")).toBe(false);
      expect(globMatch("lib/foo.rs", "src/**")).toBe(false);
    });

    test("**/*.rs matches .rs files at any depth", () => {
      expect(globMatch("foo.rs", "**/*.rs")).toBe(true);
      expect(globMatch("src/foo.rs", "**/*.rs")).toBe(true);
      expect(globMatch("src/nested/deep/foo.rs", "**/*.rs")).toBe(true);
    });

    test("**/*.rs does not match non-.rs files", () => {
      expect(globMatch("foo.py", "**/*.rs")).toBe(false);
      expect(globMatch("src/foo.toml", "**/*.rs")).toBe(false);
    });

    test("src/**/*.rs matches .rs files under src/", () => {
      expect(globMatch("src/foo.rs", "src/**/*.rs")).toBe(true);
      expect(globMatch("src/nested/foo.rs", "src/**/*.rs")).toBe(true);
    });

    test("src/**/*.rs does not match .rs outside src/", () => {
      expect(globMatch("tests/foo.rs", "src/**/*.rs")).toBe(false);
    });

    test("src/**/*.rs does not match non-.rs under src/", () => {
      expect(globMatch("src/foo.py", "src/**/*.rs")).toBe(false);
    });

    test("** alone matches everything", () => {
      expect(globMatch("anything/at/all.txt", "**")).toBe(true);
      expect(globMatch("file.rs", "**")).toBe(true);
    });

    test("nested prefix with **", () => {
      expect(globMatch("tmp/builder/output.json", "tmp/builder/**")).toBe(true);
      expect(globMatch("tmp/other/output.json", "tmp/builder/**")).toBe(false);
    });
  });

  describe("simple patterns (no **)", () => {
    test("* matches within path components", () => {
      expect(globMatch("main.py", "*.py")).toBe(true);
      // fnmatch-style: * matches across / in simple mode
      expect(globMatch("src/main.py", "*.py")).toBe(true);
    });

    test("? matches single character", () => {
      expect(globMatch("a.rs", "?.rs")).toBe(true);
      expect(globMatch("ab.rs", "?.rs")).toBe(false);
    });

    test("exact match", () => {
      expect(globMatch("Cargo.toml", "Cargo.toml")).toBe(true);
      expect(globMatch("cargo.toml", "Cargo.toml")).toBe(false);
    });

    test("directory prefix with *", () => {
      expect(globMatch("src/foo.rs", "src/*.rs")).toBe(true);
    });
  });
});

describe("scopeMatch", () => {
  test("matches if any pattern matches", () => {
    expect(scopeMatch("src/foo.rs", ["src/**", "tests/**"])).toBe(true);
    expect(scopeMatch("tests/test.rs", ["src/**", "tests/**"])).toBe(true);
  });

  test("no match if no pattern matches", () => {
    expect(scopeMatch("docs/readme.md", ["src/**", "tests/**"])).toBe(false);
  });

  test("empty patterns match nothing", () => {
    expect(scopeMatch("anything", [])).toBe(false);
  });
});
