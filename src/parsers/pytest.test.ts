import { describe, expect, test } from "bun:test";
import { parsePytest } from "./pytest";

describe("parsePytest", () => {
  test("all passing", () => {
    const output = "===== 5 passed in 0.12s =====";
    const r = parsePytest(output, 0);
    expect(r.all_passed).toBe(true);
    expect(r.total).toBe(5);
    expect(r.passed).toBe(5);
    expect(r.failed).toBe(0);
  });

  test("partial failure", () => {
    const output = "===== 3 passed, 2 failed in 1.5s =====";
    const r = parsePytest(output, 1);
    expect(r.all_passed).toBe(false);
    expect(r.total).toBe(5);
    expect(r.passed).toBe(3);
    expect(r.failed).toBe(2);
  });

  test("with errors", () => {
    const output = "===== 3 passed, 1 failed, 1 error in 2.0s =====";
    const r = parsePytest(output, 1);
    expect(r.all_passed).toBe(false);
    expect(r.passed).toBe(3);
    // failed + errors combined
    expect(r.failed).toBe(2);
  });

  test("no output", () => {
    const r = parsePytest("", 1);
    expect(r.all_passed).toBe(false);
    expect(r.total).toBe(0);
  });

  test("only passed", () => {
    const output = "1 passed";
    const r = parsePytest(output, 0);
    expect(r.all_passed).toBe(true);
    expect(r.passed).toBe(1);
  });
});
