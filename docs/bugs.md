# Known Bugs

## invoke.ts discards results when SDK subtype is not "success"

**Status:** Open
**Severity:** Critical — silently breaks post-stages, loses cost tracking
**Reported:** 2026-05-06 (see also docs/ORCA-QA-BUG.md)
**Issue:** https://github.com/owls-on-wires/orca/issues/1

### Problem

`src/engine/invoke.ts:215` only extracts result data when `resultMsg.subtype === "success"`:

```typescript
if (resultMsg.subtype === "success") {
    resultCost = resultMsg.total_cost_usd ?? 0;
    resultNumTurns = resultMsg.num_turns ?? 0;
    structuredOutput = resultMsg.structured_output;
    // ...
}
```

The Claude Agent SDK has two result variants (from `SDKResultMessage`):

1. `subtype: "success"` — has `structured_output`, `result`, `session_id`
2. `subtype: "error_max_turns" | "error_during_execution" | "error_max_budget_usd"
   | "error_max_structured_output_retries"` — has `errors[]`, `total_cost_usd`,
   `num_turns`, `duration_ms`, but NO `structured_output`

When the agent hits maxTurns (common for QA stages doing Playwright testing), the
SDK returns `subtype: "error_max_turns"`. Orca ignores the entire message:

- `total_cost_usd` is lost → reported as $0.00
- `num_turns` is lost → reported as 0
- `structured_output` doesn't exist on the error variant, so even if orca read it,
  it would be undefined
- No `invoke_end` event is written to JSONL

### Symptoms

- Post-stage always reports "FAILED: no structured output returned"
- Build log shows `$0.00` cost even though the agent ran hundreds of tool calls
- The JSONL log shows the agent working (tool_use events ARE logged from assistant
  messages) but there's no invoke_end entry
- Creates an infinite loop: eval passes → QA runs → orca ignores result → POST_FAIL
  → loop restarts → budget exhausted

### Evidence

From ORCA-QA-BUG.md: The QA agent calls StructuredOutput correctly with
`{status: "passed", summary: "..."}` (visible in JSONL tool_use events), but orca
never sees it because the result message has a non-success subtype.

The $0.00 cost confirms the result message is being discarded entirely — not that
the agent didn't run.

### Fix

Two changes needed in `src/engine/invoke.ts`:

1. **Always extract cost/turns/duration from result messages** — both SDK variants
   have `total_cost_usd`, `num_turns`, `duration_ms`. Handle both subtypes:

   ```typescript
   } else if (message.type === "result") {
       const resultMsg = message as SDKResultMessage;
       // Always capture cost and turn data
       resultCost = resultMsg.total_cost_usd ?? 0;
       resultNumTurns = resultMsg.num_turns ?? 0;
       resultDurationMs = resultMsg.duration_ms ?? 0;
       resultIsError = resultMsg.is_error ?? false;

       if (resultMsg.subtype === "success") {
           resultSessionId = resultMsg.session_id;
           structuredOutput = resultMsg.structured_output;
       }
       // Always write invoke_end
       log.write("invoke_end", { ... });
   }
   ```

2. **Fallback for structured output on non-success results**: When the agent called
   StructuredOutput but the SDK terminated with error_max_turns, the output is lost.
   Options:
   a. Parse the JSONL for the last StructuredOutput tool_use event
   b. Check if the agent wrote the output file directly
   c. Accept that maxTurns exhaustion means the task needs more turns (increase budget)

### Workaround

Increase `max_turns` on QA stages so the agent completes within budget:

```yaml
stages:
  qa:
    toolset: all
    max_turns: 80   # not 30 — Playwright testing needs many turns
```
