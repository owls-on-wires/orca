# Fixture Changes — Pending TODO Implementation

Changes to make to the `link-board` fixture once the items in `todo.md` are implemented.

## Prerequisites (from todo.md)

1. **`POST /groups`** — create a task chain from a template in one API call
2. **Optional `prompt` on tasks** — template's `params.prompt` used when task omits it
3. **Global fallback supervisor** — executor routes unhandled failures to `type:supervisor` action
4. **"unknown" output → `error` condition** — malformed agent output classified as error, not fail

## Changes to project.orca.yaml

### Planner prompt lives in the template

No `PLANNER-PROMPT.md`, no prompt duplication. The planner template defines the prompt once in `params.prompt`. All planner actions (initial + dynamically created) inherit it automatically:

```yaml
templates:
  planner:
    actions: [plan]
    types:
      plan:
        type: agent
        max_turns: 40
        toolset: all
        params:
          prompt: >
            You are a build planner for "link-board"...
            [full planner instructions]
```

Tasks reference the template without a prompt field:

```yaml
tasks:
  - id: plan-epic-1
    template: planner
    # no prompt — template provides it
```

### Single initial planner, not five

Only `plan-epic-1` is defined in the YAML. Each planner creates the next one via `POST /groups` with `template: "planner"`. Since the prompt is in the template, the new planner inherits it automatically. No need to pre-define all 5.

### Planner creates tasks via POST /groups

Instead of 6-8 curl calls per task (3 actions + 3+ edges), the planner makes 1 call:

```bash
curl -X POST http://localhost:7072/groups -d '{
  "id": "auth-models",
  "template": "tdd",
  "prompt": "Implement user model...",
  "after": "plan-epic-1.plan",
  "overrides": {
    "write-tests": {"prompt": "Write tests for user model..."},
    "eval": {"command": "bun test test/auth-models.test.ts"}
  }
}'
```

Template expansion handles all action creation, edge wiring (including fail→develop for all conditions), and predecessor connection.

### Supervisor defined in YAML

A single supervisor action sits inactive until the global fallback activates it:

```yaml
defaults:
  types:
    supervisor:
      type: agent
      max_turns: 40
      toolset: all
      tags: ["type:supervisor"]
      params:
        prompt: >
          You are a supervisor for the link-board project.
          An action has failed with no recovery edge.
          Check params.failed_action and params.failed_condition.
          Use the orca API (http://localhost:7072) to:
          1. Read the failed action's output and history
          2. Diagnose why it failed
          3. Fix the issue (update prompt, add edges, fix code)
          4. Retry the action via POST /actions/:id/retry
          Read ORCA-API.yaml for the full API reference.

tasks:
  - id: supervisor
    template: supervisor
    # no prompt — template provides it
```

No explicit edges from any action to the supervisor. The executor's global fallback routes to it automatically when any action fails with no matching outgoing edge.

### Sprint QA → Planner loop

Each epic follows this flow:

```
planner-N → [task chains] → sprint-qa-N → planner-N+1
```

After all tasks in an epic complete, a **sprint QA** action runs — an agent that starts the server and performs a full integration test covering everything built in that sprint. It reports pass/fail with detailed notes on what's broken.

The sprint QA's output flows to the **next planner** as predecessor context. If QA found issues, the planner adds fix tasks to the upcoming sprint before creating new feature tasks. If QA passed, the planner proceeds to the next epic.

The sprint QA template:

```yaml
templates:
  sprint-qa:
    actions: [qa]
    types:
      qa:
        type: agent
        max_turns: 30
        toolset: all
        params:
          prompt: >
            You are a QA engineer. Start the server, run integration
            tests covering all functionality built so far...
```

The planner creates the sprint QA via `POST /groups` after the last task in the epic, then wires the next planner after it:

```
last-task.eval → sprint-qa-N.qa [pass]
sprint-qa-N.qa → planner-N+1.plan [pass]
sprint-qa-N.qa → planner-N+1.plan [fail]  (planner sees failure context)
```

Both pass AND fail route to the next planner — the planner always runs, but its predecessor output tells it whether QA passed or failed, so it can plan fix tasks if needed.

### Final planner

The last planner in the pipeline (after the final sprint QA) should check if all epics are complete and all QA passed. If everything is done, it reports `status: "passed"` and does not create any additional tasks. The graph terminates naturally.

### Planner prompt is simpler

The planner prompt no longer needs to document:
- How to create individual actions (`POST /actions`)
- How to wire edges (`POST /edges`)
- Edge patterns for each template (tdd, tdd-qa, dev)
- How to activate the first task
- How to reproduce its own prompt for the next planner

It only needs to document:
- How to read the graph (`GET /actions`)
- How to create tasks (`POST /groups` with template + prompt + after + overrides)
- Which template to pick for each type of work
- How to wire the last task to the next planner

## Files

| File | Change |
|------|--------|
| `project.orca.yaml` | Rewrite: planner prompt in template, supervisor action, simplified task list |
| `PLANNER-PROMPT.md` | Not needed (prompt in template) |
| `SUPERVISOR-PROMPT.md` | Not needed (prompt in template) |
| `EPICS.md` | No change |
| `ORCA-API.yaml` | Update to include POST /groups endpoint |
| `src/server.ts` | No change |
