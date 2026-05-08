/**
 * Exit code parser — simplest possible eval.
 */

import type { EvalResult } from "../config/schema";

export function parseExitCode(exitCode: number): EvalResult {
  return {
    all_passed: exitCode === 0,
    total: 1,
    passed: exitCode === 0 ? 1 : 0,
    failed: exitCode === 0 ? 0 : 1,
  };
}
