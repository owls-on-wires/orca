import { describe, expect, test } from "bun:test";
import { parseJsonOutput } from "./json";

describe("parseJsonOutput", () => {
  test("valid JSON with all_passed true", () => {
    const r = parseJsonOutput('{"all_passed": true, "total": 5, "passed": 5}');
    expect(r.all_passed).toBe(true);
    expect(r.total).toBe(5);
  });

  test("valid JSON with all_passed false", () => {
    const r = parseJsonOutput('{"all_passed": false, "failed": 2, "missing_forms": ["x1*x2"]}');
    expect(r.all_passed).toBe(false);
    expect(r.failed).toBe(2);
    expect(r.missing_forms).toEqual(["x1*x2"]);
  });

  test("extra fields are passed through", () => {
    const r = parseJsonOutput('{"all_passed": true, "dup_rate": 0.087, "custom": "value"}');
    expect(r.all_passed).toBe(true);
    expect(r.dup_rate).toBe(0.087);
    expect(r.custom).toBe("value");
  });

  test("invalid JSON returns error", () => {
    const r = parseJsonOutput("not json at all");
    expect(r.all_passed).toBe(false);
    expect(r.error).toContain("Failed to parse JSON");
  });

  test("empty string returns error", () => {
    const r = parseJsonOutput("");
    expect(r.all_passed).toBe(false);
    expect(r.error).toBeDefined();
  });

  test("all_passed coerced to boolean", () => {
    // Truthy value coerced
    const r = parseJsonOutput('{"all_passed": 1}');
    expect(r.all_passed).toBe(true);

    // Falsy value coerced
    const r2 = parseJsonOutput('{"all_passed": 0}');
    expect(r2.all_passed).toBe(false);

    // Missing = false
    const r3 = parseJsonOutput('{"total": 5}');
    expect(r3.all_passed).toBe(false);
  });

  test("handles leading/trailing whitespace", () => {
    const r = parseJsonOutput('  \n  {"all_passed": true}  \n  ');
    expect(r.all_passed).toBe(true);
  });
});
