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
      "develop": { "prompt": "Implement user model in src/models/user.ts..." },
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

## Writing per-stage overrides

Always provide separate prompts for each agent stage via `overrides`.
A single `prompt` shared across write-tests, develop, and qa is too
vague and leads to agents doing the wrong thing for their stage.

### write-tests overrides

Tell the agent what to test, not what to build:
```json
"write-tests": {
  "prompt": "Write tests for user authentication in test/auth.test.ts.\n\nTest cases:\n1. POST /register creates user (201)\n2. POST /register rejects duplicate (409)\n3. POST /login returns JWT (200)\n4. POST /login rejects bad password (401)\n5. GET /me returns profile with valid JWT\n6. GET /me returns 401 without JWT\n\nImport server from '../src/server'. Port 3458.\nUse beforeEach(() => resetDb()).\nDo NOT implement source code."
}
```

### develop overrides

Tell the agent what to implement and where to put it:
```json
"develop": {
  "prompt": "Implement user authentication.\nRead src/server.ts first for routing conventions.\n\nCreate/modify:\n- src/auth.ts: createUser, loginUser, verifyToken functions\n- Wire POST /register, POST /login, GET /me in server.ts\n\nUse Bun.password.hash/verify. Simple HMAC-SHA256 JWT.\nOnly implement what test/auth.test.ts requires — nothing more."
}
```

### eval overrides

Always scope to this task's tests:
```json
"eval": { "command": "bun test test/auth.test.ts" }
```

Using `bun test` (all tests) means the develop agent wastes turns
retrying on failures from OTHER tasks' tests.

### qa overrides (for tdd-qa template)

Specify how to test live functionality:
```json
"qa": {
  "prompt": "Test auth endpoints on a live server.\n\n1. Kill port 3458: kill $(lsof -ti:3458 -sTCP:LISTEN) 2>/dev/null\n2. Start server: bun run src/server.ts &\n3. Wait 2s\n\nTest with curl:\n- POST /register with username/email/password → 201\n- POST /register duplicate → 409\n- POST /login → extract JWT from response\n- GET /me with Authorization: Bearer {jwt} → username in response\n- GET /me without auth → 401\n\nKill server when done.\nReport passed if all work. Report failed only for unexpected errors.\nSkip 500s (stubs, not failures)."
}
```

For frontend testing, if a browser MCP tool is available:
```json
"qa": {
  "prompt": "Test the web UI using the Playwright browser tools.\n\nNavigate to http://localhost:3000.\nTest: login form → dashboard → create item → edit → delete.\nVerify page content after each action.\nTake a screenshot if anything fails.\nKill server when done."
}
```

## Prompt scoping rules for planners

When a planner creates tasks, the prompts it writes must be tightly
scoped to each task's work. This is the most common source of problems
in dynamic pipelines.

Rules for planner-generated prompts:
- Do NOT tell agents to read roadmap/epic files
- Do NOT describe features beyond the current task
- DO name specific files, functions, and endpoints
- DO tell the agent to read existing source for conventions
- DO specify the test file path in write-tests prompts
- DO specify the test command in eval overrides

Bad prompt: "Implement the links feature. Read EPICS.md for requirements."
Good prompt: "Implement POST /links and GET /links in src/routes/links.ts.
Read src/server.ts for routing conventions. Only build what
test/links.test.ts requires."

## The `after` field

Wires a pass edge from an existing action to the first action in
the new group. Use this to chain tasks sequentially:

```bash
# Task B starts after Task A's eval passes
curl -X POST /groups -d '{
  "id": "task-b", "template": "tdd", "project_id": "p",
  "prompt": "...", "after": "task-a.commit"
}'
```

## The `depends_on` field

Array of action IDs. Wires pass edges from each to the first action.
Use for diamond dependencies (task depends on multiple predecessors):

```bash
curl -X POST /groups -d '{
  "id": "integration", "template": "tdd", "project_id": "p",
  "prompt": "...", "depends_on": ["auth.commit", "posts.commit"]
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
  "after": "auth-endpoints.commit"
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
The planner reads QA's output as predecessor context and can plan
fix tasks if QA failed:

```bash
# Create sprint QA
curl -X POST /groups -d '{
  "id": "sprint-qa-1", "template": "sprint-qa", "project_id": "p",
  "after": "last-task.commit"
}'

# Wire QA to next planner (both pass and fail)
curl -X POST /edges -d '{"from_action":"sprint-qa-1.qa","to_action":"plan-epic-2.plan","condition":"pass"}'
curl -X POST /edges -d '{"from_action":"sprint-qa-1.qa","to_action":"plan-epic-2.plan","condition":"fail"}'
```

Sprint QA prompts should:
- Run ALL tests (`bun test`), not just one file
- Test cross-feature interactions
- Read src/ to know what's actually implemented (not EPICS.md)
- Skip 500 responses (stubs, not failures)
- Report failures only for implemented features that don't work

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
| tdd | write-tests → develop → eval → commit | Data layer, models, utilities |
| tdd-qa | write-tests → develop → eval → commit → qa | HTTP endpoints, user-facing API, frontend |
| dev | develop → eval → commit | Config changes, refactors, documentation |
| planner | plan | Planning/decomposition agents |
| sprint-qa | qa | Integration testing between epics |
| notify | send | Fire-and-forget notification (ntfy, slack, etc.) |
