# Dynamic Tasking

How to create tasks at runtime using the orca API.

## Overview

A planner agent reads a goal (e.g., an epic list), decomposes it into
tasks, creates them via the API, and wires them into the execution graph.
The executor runs the tasks automatically.

## Creating tasks with POST /groups

One API call creates a full task chain from a template:

```bash
curl -X POST http://localhost:7072/groups \
  -H 'Content-Type: application/json' \
  -d '{
    "id": "auth-models",
    "template": "tdd",
    "project_id": "my-project",
    "prompt": "Implement user model with password hashing...",
    "after": "plan-epic-1.plan",
    "overrides": {
      "write-tests": { "prompt": "Write tests for user model..." },
      "eval": { "command": "bun test test/auth-models.test.ts" }
    }
  }'
```

This creates:
- `auth-models.write-tests` (agent)
- `auth-models.develop` (agent)
- `auth-models.eval` (command)

With edges: write-tests → develop [pass], develop → eval [pass],
eval → develop [fail/error/stuck/etc].

Plus a pass edge from `plan-epic-1.plan` → `auth-models.write-tests`.

## The `after` field

Wires a pass edge from an existing action to the first action in
the new group. Use this to chain tasks sequentially:

```bash
# Task B starts after Task A's eval passes
curl -X POST /groups -d '{
  "id": "task-b", "template": "tdd", "project_id": "p",
  "prompt": "...", "after": "task-a.eval"
}'
```

## The `depends_on` field

Array of action IDs. Wires pass edges from each to the first action.
Use for diamond dependencies (task depends on multiple predecessors):

```bash
curl -X POST /groups -d '{
  "id": "integration", "template": "tdd", "project_id": "p",
  "prompt": "...", "depends_on": ["auth.eval", "posts.eval"]
}'
```

## Chaining planners

The planner creates tasks for one epic, then creates the next planner
to run after the last task completes:

```
plan-epic-1 → [auth tasks] → plan-epic-2 → [posts tasks] → ...
```

To create the next planner:

```bash
# Create next planner action
curl -X POST /groups -d '{
  "id": "plan-epic-2", "template": "planner", "project_id": "p",
  "after": "auth-endpoints.eval"
}'
```

If the planner's prompt is in the template's `params.prompt`, the
new planner inherits it automatically.

## Sprint QA pattern

After all tasks in an epic, run integration QA before the next planner:

```
[tasks] → sprint-qa → next-planner
```

Wire both pass AND fail from QA to the planner so it always runs.
The planner reads QA's output as predecessor context:

```bash
# Create sprint QA
curl -X POST /groups -d '{
  "id": "sprint-qa-1", "template": "sprint-qa", "project_id": "p",
  "after": "last-task.eval"
}'

# Wire QA to next planner (both pass and fail)
curl -X POST /edges -d '{"from_action":"sprint-qa-1.qa","to_action":"plan-epic-2.plan","condition":"pass"}'
curl -X POST /edges -d '{"from_action":"sprint-qa-1.qa","to_action":"plan-epic-2.plan","condition":"fail"}'
```

## Activating the first task

Actions created by POST /groups start as `inactive`. The `after`
field wires a pass edge, but doesn't activate. To start execution,
either:

1. The predecessor action completes and the executor follows the edge
2. Manually activate: `curl -X PATCH /actions/first.action -d '{"status":"pending"}'`

## Reading graph state

Before planning, check what already exists:

```bash
# All actions with status
curl /actions | jq '[.[] | {id, status}]'

# Specific action detail
curl /actions/auth-models.eval | jq .

# Executor state
curl /executor/status | jq .
```

## Template selection guide

| Template | Actions | Use for |
|----------|---------|---------|
| tdd | write-tests → develop → eval | Data layer, models, utilities |
| tdd-qa | write-tests → develop → eval → qa | HTTP endpoints, user-facing API |
| dev | develop → eval | Config changes, refactors |
| planner | plan | Planning/decomposition agents |
| sprint-qa | qa | Integration testing between epics |
