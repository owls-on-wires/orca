import { describe, expect, test } from "bun:test";
import { runEval, formatEvalSummary, evalSummary } from "./eval";
import type { EvalConfig, EvalResult } from "../config/schema";

describe("runEval", () => {
  describe("subprocess execution", () => {
    test("runs a command and returns parsed result", async () => {
      const config: EvalConfig = {
        command: 'echo "test result: ok. 3 passed; 0 failed; 0 ignored"',
        parser: "cargo_test",
      };
      const result = await runEval(config, "test_task", ".", {});
      expect(result.all_passed).toBe(true);
      expect(result.passed).toBe(3);
    });

    test("captures exit code for failing command", async () => {
      const config: EvalConfig = {
        command: "exit 1",
        parser: "exit_code",
      };
      const result = await runEval(config, "test_task", ".", {});
      expect(result.all_passed).toBe(false);
    });

    test("handles command that outputs JSON", async () => {
      const config: EvalConfig = {
        command: 'echo \'{"all_passed": true, "total": 7, "forms_found": 7}\'',
        parser: "json",
      };
      const result = await runEval(config, "test_task", ".", {});
      expect(result.all_passed).toBe(true);
      expect(result.total).toBe(7);
    });

    test("exit_code parser: exit 0 = passed", async () => {
      const config: EvalConfig = {
        command: "exit 0",
        parser: "exit_code",
      };
      const result = await runEval(config, "test_task", ".", {});
      expect(result.all_passed).toBe(true);
    });
  });

  describe("template variable interpolation", () => {
    test("replaces {task_id} in command", async () => {
      const config: EvalConfig = {
        command: "echo {task_id}",
        parser: "exit_code",
      };
      const result = await runEval(config, "dev_socket", ".", { task_id: "dev_socket" });
      expect(result.all_passed).toBe(true);
    });

    test("replaces multiple variables", async () => {
      const config: EvalConfig = {
        command: 'echo "{task_id} {project_name}"',
        parser: "exit_code",
      };
      const result = await runEval(config, "x", ".", {
        task_id: "x",
        project_name: "henry",
      });
      expect(result.all_passed).toBe(true);
    });
  });

  describe("parser dispatch", () => {
    test("cargo_test parser is used", async () => {
      const config: EvalConfig = {
        command: 'echo "test test_a ... ok\ntest result: ok. 1 passed; 0 failed; 0 ignored"',
        parser: "cargo_test",
      };
      const result = await runEval(config, "t", ".", {});
      expect(result.passed_tests).toContain("test_a");
    });

    test("pytest parser is used", async () => {
      const config: EvalConfig = {
        command: 'echo "===== 3 passed in 0.5s ====="',
        parser: "pytest",
      };
      const result = await runEval(config, "t", ".", {});
      expect(result.passed).toBe(3);
    });

    test("json parser is used", async () => {
      const config: EvalConfig = {
        command: 'echo \'{"all_passed": false, "failed": 1}\'',
        parser: "json",
      };
      const result = await runEval(config, "t", ".", {});
      expect(result.all_passed).toBe(false);
      expect(result.failed).toBe(1);
    });
  });

  describe("results_file", () => {
    test("writes eval results to results_file when specified", async () => {
      const { mkdtempSync, rmSync, readFileSync, existsSync } = await import("fs");
      const { join } = await import("path");
      const { tmpdir } = await import("os");
      const tempDir = mkdtempSync(join(tmpdir(), "orca-eval-results-"));
      try {
        const resultsPath = join(tempDir, "eval.json");
        const config: EvalConfig = {
          command: 'echo \'{"all_passed": true, "total": 1, "passed": 1}\'',
          parser: "json",
          results_file: resultsPath,
        };
        const result = await runEval(config, "t", ".", {});
        expect(result.all_passed).toBe(true);
        expect(existsSync(resultsPath)).toBe(true);
        const written = JSON.parse(readFileSync(resultsPath, "utf8"));
        expect(written.all_passed).toBe(true);
      } finally {
        rmSync(tempDir, { recursive: true, force: true });
      }
    });
  });

  describe("timeout", () => {
    test("respects timeout and returns error", async () => {
      const config: EvalConfig = {
        command: "sleep 30",
        parser: "exit_code",
        timeout: 1,
      };
      const result = await runEval(config, "t", ".", {});
      expect(result.all_passed).toBe(false);
      expect(result.error).toBeDefined();
      expect(result.error!.toLowerCase()).toContain("timeout");
    });

    test("command that finishes before timeout succeeds", async () => {
      const config: EvalConfig = {
        command: "echo ok",
        parser: "exit_code",
        timeout: 10,
      };
      const result = await runEval(config, "t", ".", {});
      expect(result.all_passed).toBe(true);
    });
  });

  describe("error handling", () => {
    test("nonexistent command returns error", async () => {
      const config: EvalConfig = {
        command: "nonexistent_command_xyz_12345",
        parser: "exit_code",
      };
      const result = await runEval(config, "t", ".", {});
      expect(result.all_passed).toBe(false);
    });

    test("missing command in config returns error", async () => {
      const config: EvalConfig = { parser: "exit_code" };
      const result = await runEval(config, "t", ".", {});
      expect(result.all_passed).toBe(false);
      expect(result.error).toBeDefined();
    });
  });
});

describe("evalSummary", () => {
  test("all passed", () => {
    expect(evalSummary({ all_passed: true, total: 5, passed: 5 })).toBe("All 5 tests passing.");
  });

  test("some failed without names", () => {
    expect(evalSummary({ all_passed: false, total: 5, passed: 3 })).toBe("3/5 tests passing.");
  });

  test("some failed with names", () => {
    expect(evalSummary({ all_passed: false, total: 3, passed: 1, failed_tests: ["test_a", "test_b"] }))
      .toBe("1/3 tests passing. Failures: test_a, test_b.");
  });

  test("compile error without details", () => {
    expect(evalSummary({ all_passed: false, compile_error: true })).toBe("Compile error.");
  });

  test("compile error with first error", () => {
    expect(evalSummary({ all_passed: false, compile_error: true, compile_errors: ["missing semicolon"] }))
      .toBe("Compile error. missing semicolon");
  });

  test("no tests", () => {
    expect(evalSummary({ all_passed: false, total: 0 })).toBe("No tests found.");
  });

  test("no tests when total is undefined", () => {
    expect(evalSummary({ all_passed: false })).toBe("No tests found.");
  });
});

describe("formatEvalSummary", () => {
  test("passing", () => {
    expect(formatEvalSummary({ all_passed: true, total: 5, passed: 5 })).toBe("PASS (5/5)");
  });

  test("failing", () => {
    expect(formatEvalSummary({ all_passed: false, total: 5, passed: 3 })).toBe("FAIL (3/5)");
  });

  test("compile error", () => {
    expect(formatEvalSummary({ all_passed: false, compile_error: true })).toBe("COMPILE ERROR");
  });

  test("no tests", () => {
    expect(formatEvalSummary({ all_passed: false, total: 0 })).toBe("no tests");
  });

  test("error message", () => {
    const summary = formatEvalSummary({ all_passed: false, error: "Timed out after 300s" });
    expect(summary).toContain("Timed out");
  });

  test("missing passed defaults to 0", () => {
    expect(formatEvalSummary({ all_passed: false, total: 3 })).toBe("FAIL (0/3)");
  });
});

