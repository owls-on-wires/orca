import { describe, expect, test } from "bun:test";
import { parseExitCode } from "./exit_code";

describe("parseExitCode", () => {
  test("exit 0 = passed", () => {
    const r = parseExitCode(0);
    expect(r.all_passed).toBe(true);
    expect(r.total).toBe(1);
    expect(r.passed).toBe(1);
    expect(r.failed).toBe(0);
  });

  test("exit 1 = failed", () => {
    const r = parseExitCode(1);
    expect(r.all_passed).toBe(false);
    expect(r.total).toBe(1);
    expect(r.passed).toBe(0);
    expect(r.failed).toBe(1);
  });

  test("exit 127 = failed", () => {
    const r = parseExitCode(127);
    expect(r.all_passed).toBe(false);
  });

  test("negative exit code = failed", () => {
    const r = parseExitCode(-1);
    expect(r.all_passed).toBe(false);
  });
});
