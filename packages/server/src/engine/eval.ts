/**
 * Eval runner — executes eval commands and parses output.
 */

import type { EvalConfig, EvalResult, EvalParser } from "../config/schema";
import { parseCargoTest } from "../parsers/cargo";
import { parsePytest } from "../parsers/pytest";
import { parseJsonOutput } from "../parsers/json";
import { parseExitCode } from "../parsers/exit_code";
import { writeFileSync, mkdirSync } from "fs";
import { dirname } from "path";

export async function runEval(
  config: EvalConfig,
  taskId: string,
  projectDir: string,
  templateVars: Record<string, string>,
): Promise<EvalResult> {
  if (!config.command) {
    return { all_passed: false, error: "No eval command configured" };
  }

  // Interpolate template variables in command
  let command = config.command;
  command = command.replaceAll("{task_id}", taskId);
  for (const [key, value] of Object.entries(templateVars)) {
    command = command.replaceAll(`{${key}}`, value);
  }

  const timeout = (config.timeout ?? 300) * 1000; // to ms
  const parser = config.parser ?? "exit_code";

  try {
    const proc = Bun.spawn(["sh", "-c", command], {
      cwd: projectDir,
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env, TERM: "dumb" },
    });

    // Wait with timeout
    const timeoutPromise = new Promise<"timeout">((resolve) =>
      setTimeout(() => resolve("timeout"), timeout),
    );
    const exitPromise = proc.exited.then(code => ({ code, timedOut: false }));
    const race = await Promise.race([exitPromise, timeoutPromise]);

    if (race === "timeout") {
      proc.kill();
      return { all_passed: false, error: `Eval timeout after ${config.timeout}s` };
    }

    const stdout = await new Response(proc.stdout).text();
    const stderr = await new Response(proc.stderr).text();
    const output = stdout + "\n" + stderr;
    const exitCode = race.code;

    const result = dispatch(parser, output, exitCode);

    // Write to results_file if configured
    if (config.results_file) {
      const resultsPath = config.results_file.replaceAll("{task_id}", taskId);
      try {
        mkdirSync(dirname(resultsPath), { recursive: true });
      } catch {}
      writeFileSync(resultsPath, JSON.stringify(result, null, 2));
    }

    return result;
  } catch (e: any) {
    return { all_passed: false, error: e.message ?? String(e) };
  }
}

function dispatch(parser: EvalParser, output: string, exitCode: number): EvalResult {
  switch (parser) {
    case "cargo_test":
      return parseCargoTest(output, exitCode);
    case "pytest":
      return parsePytest(output, exitCode);
    case "json":
      return parseJsonOutput(output);
    case "exit_code":
      return parseExitCode(exitCode);
  }
}

export { parseCargoTest, parsePytest, parseJsonOutput as parseJson, parseExitCode };

export function evalSummary(result: EvalResult): string {
  if (result.compile_error) {
    const first = result.compile_errors?.[0];
    return first ? `Compile error. ${first}` : "Compile error.";
  }
  if (result.total === undefined || result.total === 0) {
    return "No tests found.";
  }
  const passed = result.passed ?? 0;
  if (result.all_passed) {
    return `All ${result.total} tests passing.`;
  }
  const failedNames = result.failed_tests ?? [];
  const failureSuffix = failedNames.length > 0 ? ` Failures: ${failedNames.join(", ")}.` : "";
  return `${passed}/${result.total} tests passing.${failureSuffix}`;
}

export function formatEvalSummary(result: EvalResult): string {
  if (result.compile_error) return "COMPILE ERROR";
  if (result.error) return `ERROR: ${result.error.slice(0, 80)}`;
  if (!result.total) return "no tests";
  const status = result.all_passed ? "PASS" : "FAIL";
  return `${status} (${result.passed ?? 0}/${result.total})`;
}
