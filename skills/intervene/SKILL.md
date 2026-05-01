---
name: intervene
description: Handle an orca build intervention request. The build is paused waiting for human input — read the diagnosis, discuss with the user, make fixes, and write the response to resume.
user-invocable: true
argument-hint: "<project-dir>"
allowed-tools:
  - Bash
  - Read
  - Write
  - Edit
  - Glob
  - Grep
---

# /orca:intervene

Handle a paused build that needs human input.

## When This Triggers

An orca build pauses when the supervisor agent escalates to human. The build writes `.orca/intervention.json` and waits.

## Process

### Local builds (file-based)

1. **Read the request:**
   ```bash
   cat .orca/intervention.json
   ```
   Fields: `taskId`, `cause` (test_bug/environment_problem/bad_requirements), `diagnosis`, `evidence`, `suggestedFix`, `supervisorReasoning`.

2. **Investigate:** Read the referenced files, eval results (`.orca/runs/.../*.json`), and source code.

3. **Discuss with the user** what the right action is.

4. **Fix the issue** — edit code, tests, config, or environment as needed.

5. **Write the response:**
   ```bash
   echo '{"action": "continue", "note": "Fixed the test assertion on line 45"}' > .orca/intervention_response.json
   ```

### Remote builds (serve mode REST API)

If the build is running via `orca serve`, respond via the API:

```bash
curl -X POST http://localhost:7070/builds/<id>/intervene \
  -H "Content-Type: application/json" \
  -d '{"action": "continue", "note": "Fixed the test assertion on line 45"}'
```

The dashboard at `http://localhost:7070/` also shows an intervention banner when a build is paused.

## Response Actions

| Action | Effect |
|--------|--------|
| `continue` | Resume the build (you've fixed the issue) |
| `skip` | Skip this task, move to the next one |
| `abort` | Stop the entire build |

The build process polls for the response file every 10 seconds and resumes automatically.

## Common Intervention Patterns

**test_bug:** The test assertion is wrong. Read the test, understand the fixture, fix the assertion. Respond with `continue`.

**environment_problem:** Missing dependency, broken service. Install the dep, restart the service. Respond with `continue`.

**bad_requirements:** The spec contradicts itself. Discuss with user, make a decision, update the task variables or spec. Respond with `continue`.

**stuck (auto-detected):** The agent produced identical output 3 times. Usually means a deeper issue. Read the eval results and the agent's analysis to understand why it's spinning. Often a test bug or a constraint that prevents progress.
