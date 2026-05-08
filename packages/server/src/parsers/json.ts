/**
 * JSON output parser — command outputs JSON directly.
 */

import type { EvalResult } from "../config/schema";

export function parseJsonOutput(output: string): EvalResult {
  try {
    const data = JSON.parse(output.trim());
    return {
      ...data,
      all_passed: Boolean(data.all_passed),
    };
  } catch {
    return {
      all_passed: false,
      error: `Failed to parse JSON: ${output.slice(0, 200)}`,
    };
  }
}
