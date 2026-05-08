/**
 * Pytest output parser.
 */

import type { EvalResult } from "../config/schema";

export function parsePytest(output: string, exitCode: number): EvalResult {
  // Parse "X passed, Y failed, Z errors" summary line
  const summary = output.match(/(\d+) passed(?:, (\d+) failed)?(?:, (\d+) error)?/);
  const passed = summary ? parseInt(summary[1]) : 0;
  const failed = summary ? parseInt(summary[2] ?? "0") : 0;
  const errors = summary ? parseInt(summary[3] ?? "0") : 0;
  const total = passed + failed + errors;

  return {
    all_passed: exitCode === 0 && failed === 0 && errors === 0 && total > 0,
    total,
    passed,
    failed: failed + errors,
    output: output.slice(-5000),
  };
}
