import { describe, expect, test } from "bun:test";
import { parseCargoTest } from "./cargo";

describe("parseCargoTest", () => {
  test("all passing", () => {
    const output = [
      "running 3 tests",
      "test test_parse_basic ... ok",
      "test test_parse_nested ... ok",
      "test test_parse_empty ... ok",
      "",
      "test result: ok. 3 passed; 0 failed; 0 ignored; 0 measured",
    ].join("\n");

    const r = parseCargoTest(output, 0);
    expect(r.all_passed).toBe(true);
    expect(r.total).toBe(3);
    expect(r.passed).toBe(3);
    expect(r.failed).toBe(0);
    expect(r.passed_tests).toEqual(["test_parse_basic", "test_parse_nested", "test_parse_empty"]);
    expect(r.failed_tests).toEqual([]);
    expect(r.compile_error).toBe(false);
  });

  test("partial failure", () => {
    const output = [
      "running 3 tests",
      "test test_a ... ok",
      "test test_b ... FAILED",
      "test test_c ... ok",
      "",
      "test result: FAILED. 2 passed; 1 failed; 0 ignored",
    ].join("\n");

    const r = parseCargoTest(output, 1);
    expect(r.all_passed).toBe(false);
    expect(r.total).toBe(3);
    expect(r.passed).toBe(2);
    expect(r.failed).toBe(1);
    expect(r.failed_tests).toEqual(["test_b"]);
  });

  test("all failing", () => {
    const output = [
      "running 2 tests",
      "test test_a ... FAILED",
      "test test_b ... FAILED",
      "",
      "test result: FAILED. 0 passed; 2 failed; 0 ignored",
    ].join("\n");

    const r = parseCargoTest(output, 1);
    expect(r.all_passed).toBe(false);
    expect(r.total).toBe(2);
    expect(r.passed).toBe(0);
    expect(r.failed).toBe(2);
  });

  test("multi-file output aggregates across result lines", () => {
    const output = [
      "running 2 tests",
      "test test_a ... ok",
      "test test_b ... ok",
      "test result: ok. 2 passed; 0 failed; 0 ignored",
      "",
      "running 3 tests",
      "test test_c ... ok",
      "test test_d ... FAILED",
      "test test_e ... ok",
      "test result: FAILED. 2 passed; 1 failed; 0 ignored",
    ].join("\n");

    const r = parseCargoTest(output, 1);
    expect(r.all_passed).toBe(false);
    expect(r.total).toBe(5);
    expect(r.passed).toBe(4);
    expect(r.failed).toBe(1);
    expect(r.failed_tests).toEqual(["test_d"]);
  });

  test("compile error", () => {
    const output = [
      "error[E0308]: mismatched types",
      "  --> src/lib.rs:42:5",
      "could not compile `my_project`",
    ].join("\n");

    const r = parseCargoTest(output, 101);
    expect(r.all_passed).toBe(false);
    expect(r.compile_error).toBe(true);
    expect(r.compile_errors!.length).toBeGreaterThan(0);
    expect(r.compile_errors![0]).toContain("E0308");
  });

  test("no tests found", () => {
    const r = parseCargoTest("no tests to run\n", 0);
    expect(r.all_passed).toBe(false);
    expect(r.total).toBe(0);
  });

  test("empty output", () => {
    const r = parseCargoTest("", 1);
    expect(r.all_passed).toBe(false);
  });

  test("exit code non-zero even with passing tests", () => {
    const output = [
      "test test_a ... ok",
      "test result: ok. 1 passed; 0 failed; 0 ignored",
    ].join("\n");

    // exit code 1 despite ok results = still failed (e.g., post-test hook failure)
    const r = parseCargoTest(output, 1);
    expect(r.all_passed).toBe(false);
  });

  test("output is truncated to last 5000 chars", () => {
    const longOutput = "x".repeat(10000) + "\ntest result: ok. 1 passed; 0 failed; 0 ignored\n";
    const r = parseCargoTest(longOutput, 0);
    expect(r.output!.length).toBeLessThanOrEqual(5000);
  });
});
