# Orca QA Stage Bug — Structured Output Not Recognized

> Documented 2026-05-06. Affects all builds using `post: [qa]`.

## Summary

The built-in `qa` stage reports "FAILED: no structured output returned" even when the QA agent successfully runs, performs real work, and correctly invokes `StructuredOutput` with the expected schema. This creates an infinite loop: eval passes → QA runs → orca ignores the output → loop restarts.

## Key Finding

**The agent DOES call `StructuredOutput` correctly.** Evidence from JSONL logs:

```
admin-ui-config-dropdowns/qa.jsonl (46 events):
  - Agent uses Playwright to test dropdowns, click configs, verify content
  - Calls StructuredOutput: {"status": "passed", "summary": "Verified all config dropdowns..."}
  - Result written to qa.json: {"status": "passed", "summary": "..."}

admin-ui-live-builds/qa.jsonl (514 events):
  - Agent uses Playwright, checks docker logs, inspects Redis
  - Calls StructuredOutput: {"status": "failed", "summary": "The SSE live build progress feature does not work..."}
  - Includes detailed diagnosis of withCredentials bug
```

Yet orca reports: `[qa] done ($0.00, 0s) — FAILED: no structured output returned`

## Observed Behavior

### Build Log Pattern

```
[eval] done ($0.00, 0s) — PASS
[eval] PASS
[qa] running...
[qa] done ($0.00, 0s) — done
[qa] done ($0.00, 0s) — FAILED: no structured output returned
[eval] POST_FAIL
```

### What Actually Happens (from JSONL)

The QA agent runs for 46-514 tool calls, uses Playwright for visual testing, checks docker logs, and correctly invokes `StructuredOutput` with `{status, summary}`. The `$0.00` cost in the build log is incorrect — the agent clearly executes substantial work.

### Build Configuration Tried

```yaml
# All of these produce the same failure:

# 1. read_only toolset
stages:
  qa:
    toolset: read_only

# 2. all toolset
stages:
  qa:
    toolset: all

# 3. With custom inline prompt
prompts:
  stages:
    qa: "... You MUST return structured output as JSON ..."

# 4. With custom stage file
stages/qa.prompt.txt

# 5. Built-in only (no custom config)
```

### Builds Affected

| Build ID | Task | QA Agent Worked? | Orca Recognized? |
|----------|------|-----------------|-----------------|
| `8b94651d` | admin-ui-live-builds | Unknown (early builds) | No |
| `a630469a` | admin-ui-config-dropdowns | Yes (46 events, passed) | No |
| `a630469a` | admin-ui-live-builds | Yes (514 events, found real bug) | No |
| `a377c835` | admin-ui-live-builds | Yes (used Playwright) | No |

## Root Cause

**Orca does not read the `StructuredOutput` tool result from the QA stage.** The agent correctly invokes the tool, the result is stored in `qa.json`, but orca's post-stage processing does not pick it up. The disconnect is between the Claude agent's tool invocation and orca's result collection.

Possible specifics:
1. Orca checks for structured output before the agent finishes writing it
2. Orca looks for the output in a different location than where the agent writes it
3. The `qa.json` file exists and has correct content, but orca reads a different file or field
4. Race condition: orca reports "done" and checks for output before the JSONL is flushed

The `$0.00` cost reporting is a separate bug — the agent clearly runs (hundreds of tool calls) but the cost isn't reflected in the build log.

## Impact

Any build with `post: [qa]` loops indefinitely on every task. The QA agent does real, valuable work (it found a `withCredentials` bug in the SSE implementation) but orca throws away the result.

## Workaround

Disable QA in the workflow:

```yaml
workflow:
  loop: [write_tests, develop, eval]
  # post: [qa]
```

QA instructions are preserved in task variables (`qa_instructions`) for manual review or future automated use.

## Questions for Orca

1. Where does orca look for QA structured output? Is it `qa.json` in the task directory?
2. The agent invokes `StructuredOutput` tool — is this the correct tool name? Or does orca expect a different tool?
3. Why does the build log show `$0.00` cost when the JSONL shows 500+ tool calls?
4. Is there a known working example of `post: [qa]` in any orca project?
