/**
 * Supervisor — escalation detection and supervisor agent invocation.
 */

import type { SupervisorConfig, ScopeConfig } from "../config/schema";
import type { InvokeResult } from "./invoke";

export interface Escalation {
  cause: "test_bug" | "environment_problem" | "bad_requirements" | "stuck";
  diagnosis: string;
  evidence?: string;
  suggestedFix?: string;
}

export type SupervisorAction =
  | "fix_test"
  | "fix_environment"
  | "resolve_requirements"
  | "revert"
  | "clear_session"
  | "escalate_human"
  | "continue";

export interface SupervisorDecision {
  action: SupervisorAction;
  reasoning: string;
  details?: string;
  escalationMessage?: string;
}

const RETRY_ACTIONS: SupervisorAction[] = [
  "fix_test", "fix_environment", "resolve_requirements", "revert", "clear_session",
];

export function shouldRetry(decision: SupervisorDecision): boolean {
  return RETRY_ACTIONS.includes(decision.action);
}

export function shouldStop(decision: SupervisorDecision): boolean {
  return decision.action === "escalate_human";
}

const VALID_CAUSES = new Set(["test_bug", "environment_problem", "bad_requirements", "stuck"]);

/** Extract an escalation from stage structured output. */
export function extractEscalation(output: Record<string, unknown> | null): Escalation | null {
  if (!output || typeof output !== "object") return null;
  const esc = output.escalation;
  if (!esc || typeof esc !== "object" || Array.isArray(esc)) return null;
  const escalation = esc as Record<string, unknown>;
  const cause = escalation.cause as string | undefined;
  if (!cause || !VALID_CAUSES.has(cause)) return null;
  return {
    cause: cause as Escalation["cause"],
    diagnosis: (escalation.diagnosis as string) ?? "",
    evidence: escalation.evidence as string | undefined,
    suggestedFix: (escalation.suggested_fix ?? escalation.suggestedFix) as string | undefined,
  };
}

/** Check if the last N outputs for a label are identical (stuck detection). */
export function detectStuck(outputHashes: string[], window: number): boolean {
  if (outputHashes.length < window) return false;
  const recent = outputHashes.slice(-window);
  return new Set(recent).size === 1;
}

/** Invoke the supervisor agent. */
export async function invokeSupervisor(
  escalation: Escalation,
  config: SupervisorConfig,
  projectDir: string,
  context?: string,
): Promise<SupervisorDecision> {
  // TODO: build supervisor prompt, invoke claude, parse decision
  throw new Error("Not implemented");
}
