import { describe, expect, test } from "bun:test";
import {
  extractEscalation,
  detectStuck,
  shouldRetry,
  shouldStop,
  type Escalation,
  type SupervisorDecision,
} from "./supervisor";

describe("extractEscalation", () => {
  test("extracts valid escalation from output", () => {
    const output = {
      status: "failed",
      escalation: {
        cause: "test_bug",
        diagnosis: "The test asserts X but fixture has Y",
        evidence: "tests/rename.rs:45",
        suggested_fix: "Change the assertion",
      },
    };
    const esc = extractEscalation(output);
    expect(esc).not.toBeNull();
    expect(esc!.cause).toBe("test_bug");
    expect(esc!.diagnosis).toBe("The test asserts X but fixture has Y");
    expect(esc!.evidence).toBe("tests/rename.rs:45");
    expect(esc!.suggestedFix).toBe("Change the assertion");
  });

  test("extracts environment_problem", () => {
    const output = {
      status: "failed",
      escalation: {
        cause: "environment_problem",
        diagnosis: "Cargo build fails with missing library",
      },
    };
    const esc = extractEscalation(output);
    expect(esc).not.toBeNull();
    expect(esc!.cause).toBe("environment_problem");
  });

  test("extracts bad_requirements", () => {
    const output = {
      status: "failed",
      escalation: {
        cause: "bad_requirements",
        diagnosis: "The spec contradicts itself",
      },
    };
    const esc = extractEscalation(output);
    expect(esc).not.toBeNull();
    expect(esc!.cause).toBe("bad_requirements");
  });

  test("returns null for no escalation", () => {
    expect(extractEscalation({ status: "completed", summary: "done" })).toBeNull();
  });

  test("returns null for null output", () => {
    expect(extractEscalation(null)).toBeNull();
  });

  test("returns null for invalid cause", () => {
    const output = {
      escalation: { cause: "invalid_cause", diagnosis: "text" },
    };
    expect(extractEscalation(output)).toBeNull();
  });

  test("returns null when escalation is not an object", () => {
    expect(extractEscalation({ escalation: "string" })).toBeNull();
    expect(extractEscalation({ escalation: true })).toBeNull();
    expect(extractEscalation({ escalation: 42 })).toBeNull();
  });

  test("returns null when escalation is missing cause", () => {
    const output = { escalation: { diagnosis: "text" } };
    expect(extractEscalation(output)).toBeNull();
  });

  test("optional fields can be missing", () => {
    const output = {
      escalation: { cause: "test_bug", diagnosis: "text" },
    };
    const esc = extractEscalation(output);
    expect(esc).not.toBeNull();
    expect(esc!.evidence).toBeUndefined();
    expect(esc!.suggestedFix).toBeUndefined();
  });
});

describe("detectStuck", () => {
  test("not stuck with fewer hashes than window", () => {
    expect(detectStuck(["a", "a"], 3)).toBe(false);
    expect(detectStuck([], 3)).toBe(false);
  });

  test("stuck when last N hashes are identical", () => {
    expect(detectStuck(["a", "b", "c", "c", "c"], 3)).toBe(true);
  });

  test("not stuck when hashes differ", () => {
    expect(detectStuck(["a", "b", "c"], 3)).toBe(false);
  });

  test("only considers the last N hashes", () => {
    // Last 3 are identical even though earlier ones differ
    expect(detectStuck(["x", "y", "z", "z", "z"], 3)).toBe(true);
  });

  test("window of 2", () => {
    expect(detectStuck(["a", "a"], 2)).toBe(true);
    expect(detectStuck(["a", "b"], 2)).toBe(false);
  });

  test("all identical", () => {
    expect(detectStuck(["x", "x", "x", "x"], 3)).toBe(true);
  });
});

describe("shouldRetry", () => {
  const retryActions = [
    "fix_test",
    "fix_environment",
    "resolve_requirements",
    "revert",
    "clear_session",
  ] as const;

  for (const action of retryActions) {
    test(`${action} → retry`, () => {
      expect(shouldRetry({ action, reasoning: "test" })).toBe(true);
    });
  }

  test("escalate_human → no retry", () => {
    expect(shouldRetry({ action: "escalate_human", reasoning: "test" })).toBe(false);
  });

  test("continue → no retry", () => {
    expect(shouldRetry({ action: "continue", reasoning: "test" })).toBe(false);
  });
});

describe("shouldStop", () => {
  test("escalate_human → stop", () => {
    expect(shouldStop({ action: "escalate_human", reasoning: "test" })).toBe(true);
  });

  test("other actions → don't stop", () => {
    const nonStop = [
      "fix_test", "fix_environment", "resolve_requirements",
      "revert", "clear_session", "continue",
    ] as const;
    for (const action of nonStop) {
      expect(shouldStop({ action, reasoning: "test" })).toBe(false);
    }
  });
});
