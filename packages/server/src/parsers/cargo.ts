/**
 * Cargo test output parser.
 */

import type { EvalResult } from "../config/schema";

export function parseCargoTest(output: string, exitCode: number): EvalResult {
  // Check for compile errors
  let compileError = false;
  const compileErrors: string[] = [];
  if (output.includes("error[E") || output.toLowerCase().includes("could not compile")) {
    compileError = true;
    for (const match of output.matchAll(/error\[E\d+\]: .+/g)) {
      compileErrors.push(match[0]);
    }
  }

  // Parse individual test results
  const passedTests: string[] = [];
  const failedTests: string[] = [];
  for (const match of output.matchAll(/test (\S+) \.\.\. (ok|FAILED)/g)) {
    if (match[2] === "ok") passedTests.push(match[1]);
    else failedTests.push(match[1]);
  }

  // Aggregate across all "test result:" lines
  const resultLines = [...output.matchAll(
    /test result: \w+\. (\d+) passed; (\d+) failed; (\d+) ignored/g,
  )];
  const totalPassed = resultLines.length
    ? resultLines.reduce((sum, m) => sum + parseInt(m[1]), 0)
    : passedTests.length;
  const totalFailed = resultLines.length
    ? resultLines.reduce((sum, m) => sum + parseInt(m[2]), 0)
    : failedTests.length;
  const total = totalPassed + totalFailed;

  return {
    all_passed: exitCode === 0 && !compileError && totalFailed === 0 && total > 0,
    total,
    passed: totalPassed,
    failed: totalFailed,
    compile_error: compileError,
    compile_errors: compileErrors,
    passed_tests: passedTests,
    failed_tests: failedTests,
    output: output.slice(-5000),
  };
}
