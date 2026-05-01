---
name: analyze-build
description: Analyze a running or completed orca build — diagnose stuck tasks, interpret state.json, read eval results, and suggest fixes. Activates when the user asks about build status, failures, or stuck loops.
user-invocable: false
paths:
  - "**/.orca/**/state.json"
  - "**/.orca/**/intervention.json"
---

# Analyzing an Orca Build

When the user asks about a build's status, why a task failed, or how to fix a stuck loop, follow this process.

## 1. Find the State

Read the latest `state.json`:
```
.orca/runs/{build_name}/{latest_timestamp}/state.json
```

Key fields:
- `status` — running, completed, failed, paused
- `tasksCompleted` / `tasksFailed` — which tasks passed/failed
- `currentTaskId` — what's running now
- `totalCostUsd` — total spend
- `tasks.{id}.iteration` — how many develop cycles
- `tasks.{id}.stopReason` — why it stopped (budget, escalation, etc.)
- `tasks.{id}.history` — stage-by-stage records with costs and summaries

## 2. Diagnose Failures

**Budget exhaustion** (`stopReason` contains "iteration" or "cost"):
- The task ran out of iterations or money without passing eval
- Check: is the eval command correct? Is it testing the right thing?
- Check: read the last few eval artifacts — is progress being made, or is it stuck?
- Fix: increase `max_iterations` or `max_cost` in the config, then `orca run` (resumes automatically from prior state)

**Escalation** (`stopReason` contains "escalat"):
- The develop agent couldn't proceed and the supervisor chose `escalate_human`
- Check `.orca/intervention.json` for the diagnosis
- Fix: address the issue (fix test, resolve requirement), write intervention response

**Stuck loop** (same `outputHash` repeating in history):
- The develop agent is making the same changes every iteration
- Common cause: test bug that the agent correctly diagnoses but can't fix
- Fix: read the agent's analysis, fix the test or constraint manually, then resume

**Dependency failure** (`status: "skipped"`, `stopReason: "dependency failed"`):
- A prerequisite task failed, so this task was skipped
- Fix: fix the prerequisite first

## 3. Read Eval Artifacts

Eval results are saved as JSON artifacts:
```
.orca/runs/{name}/{timestamp}/eval_iter{N}.json
```

For cargo_test parser:
```json
{
  "all_passed": false,
  "total": 10,
  "passed": 7,
  "failed": 3,
  "failed_tests": ["test_rename_cross_module", "test_rename_no_string_modification", ...],
  "compile_error": false
}
```

Look for patterns:
- **Same tests failing every iteration** → the agent isn't addressing the root cause, or the test is wrong
- **Different tests failing** → the agent is making progress but introducing regressions
- **Compile errors** → the agent's changes don't compile — check if it's a missing import or type error
- **Decreasing pass count** → regression — the agent's latest changes made things worse

## 4. Read JSONL Logs

Stage logs at `.orca/runs/{name}/{timestamp}/{stage}_iter{N}.jsonl` contain:
- `invoke_start` — prompt length
- `tool_use` — every tool call (Read, Write, Edit, Bash, etc.)
- `scope_violation` — if the agent tried to write outside allowed paths
- `invoke_end` — cost, duration, structured output

## 5. Common Fixes

**Test is wrong:** Edit the test file, write intervention response `{"action": "continue"}`.

**Budget too low:** Edit `project.orca.yaml` → `orca:` section → increase `max_iterations`. The build picks this up on the next iteration (live reload).

**Agent stuck in a rut:** The supervisor should detect this (3 identical outputs → `clear_session`). If it doesn't, manually clear the session by stopping and resuming the build.

**Eval command wrong:** The eval command doesn't test what the task implements. Fix the `eval.command` in the config or task definition.

**Scope too restrictive:** The agent needs to modify a file outside the writable scope. Update `scope.writable` in the config.

## 6. Live Adjustments

The `orca:` section at the bottom of `project.orca.yaml` is re-read every iteration:
```yaml
orca:
  max_iterations: 20   # bump this while the build is running
  max_cost: 100.0      # or increase the budget
```

Save the file — the running build picks up the change on the next iteration.
