---
name: test-design
description: Guidelines for designing tests in orca task definitions and writing eval commands. Activates when editing test definitions or eval configuration.
user-invocable: false
paths:
  - "**/tasks.yaml"
  - "**/features.yaml"
  - "**/roadmap.yaml"
  - "**/stages/**/write_tests*"
  - "**/stages/**/develop*"
---

# Test & Eval Design Rules

## Test Definitions (in task variables)

**Include negative tests.** Every transform task must have at least one test verifying the code does NOT produce false positives:
```yaml
tests:
  - name: test_rename_no_string_modification
    description: "Verify string literals containing the old name are NOT modified"
```

**No fragile comparisons.** For formatting/preservation tests, assert specific known-unchanged lines exist in the output. Do NOT use line-by-line diff comparison — transforms insert and remove lines.

**Validate assertions against fixtures.** After writing tests, verify that asserted substrings exist in the fixture data. A test asserting a string not present in the fixture will always fail — this is the most common test bug.

**Tests must compile without implementation.** Write tests that compile even before the feature exists. Use stubs, conditional compilation, or feature flags.

**Each test is independent.** No shared mutable state between tests. Each test sets up its own data and cleans up.

## Eval Commands

**Test the eval command manually first.** Run it, verify the output for both passing and failing cases. An eval bug corrupts every task.

**For cargo test:** Use `parser: cargo_test`. Handles multi-file output (multiple `test result:` lines), compile errors, and individual test names.
```yaml
eval:
  command: "cargo test --test {task_id} 2>&1"
  parser: cargo_test
```

**For pytest:** Use `parser: pytest`. Handles `X passed, Y failed, Z errors` summary.
```yaml
eval:
  command: "python -m pytest tests/test_{task_id}.py -v 2>&1"
  parser: pytest
```

**For custom metrics:** Use `parser: json`. Your command must output JSON with at minimum `{"all_passed": bool}`.
```yaml
eval:
  command: "python -m tests.eval_{task_id} --json"
  parser: json
```

**For simple pass/fail:** Use `parser: exit_code`. Exit 0 = pass, anything else = fail.

## The Escalation Escape Hatch

The develop stage's default schema includes an `escalation` object. When the agent believes a test is wrong, the environment is broken, or requirements conflict, it returns:
```json
{
  "status": "failed",
  "escalation": {
    "cause": "test_bug",
    "diagnosis": "The test asserts 'user_' but the fixture has 'user_{}'",
    "evidence": "tests/test_rename.rs:45",
    "suggested_fix": "Change assertion to match fixture"
  }
}
```

The supervisor investigates and can fix the test, revert changes, clear the session, or escalate to human. This prevents stuck loops where the agent correctly diagnoses a test bug but can't fix it.

## Prompt Design for Tests

Tell the agent what it CAN'T change, but provide the escape hatch:
- "Do NOT modify test files. If you believe a test is wrong, return an escalation with cause 'test_bug'."
- "Do NOT modify files outside src/. If you need a fixture change, describe it in your escalation."

State the core design principle at the top of the develop prompt:
- "All operations use typed AST nodes. Never fall back to string matching."
- "All endpoints use the middleware chain. Never handle auth directly."
