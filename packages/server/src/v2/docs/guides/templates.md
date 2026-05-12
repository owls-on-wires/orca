# Templates

Templates define reusable task patterns — the action chain, types,
edges, and default parameters.

## Defining templates in project.orca.yaml

```yaml
templates:
  tdd:
    actions: [write-tests, develop, eval, commit]
    types:
      write-tests:
        type: agent
        max_turns: 40
        toolset: all
      develop:
        type: agent
        max_turns: 80
        toolset: all
      eval:
        type: command
        timeout: 30
        edges:
          fail: develop
          stuck: develop
          error: develop
          timeout: develop
          cost_exceeded: develop
          max_turns: develop
      commit:
        type: command
        params:
          command: "git add -A && git commit -m 'feat: update' --allow-empty"
          timeout: 10
```

## Template structure

- `actions`: Ordered list of action type names. Defines the chain.
- `types`: Map of action type name → definition:
  - `type`: "agent" or "command"
  - `params`: Default params (prompt, command, timeout, etc.)
  - `edges`: Custom edge routing (overrides defaults)
  - Top-level keys (max_turns, toolset) merge into params

## How prompts work

Agent actions get their prompt from (in priority order):
1. Task-level `overrides.{action-type}.prompt`
2. Task-level `prompt` (applies to all agent actions in the task)
3. Template type's `params.prompt`

If no prompt is found from any source, config expansion throws an error.

### Per-stage prompts are strongly recommended

Each stage in a pipeline serves a different purpose. Using a single
`prompt` for all stages produces vague, unfocused agents. Instead,
use `overrides` to give each stage its own tailored prompt:

```yaml
tasks:
  - id: auth
    template: tdd-qa
    overrides:
      write-tests:
        prompt: |
          Write tests for auth in test/auth.test.ts.
          Test cases: register, login, JWT validation, error handling.
          Import from "../src/server". Port 3458.
          Do NOT implement source code.
      develop:
        prompt: |
          Implement auth endpoints. Read src/server.ts for conventions.
          Create src/auth.ts with createUser, loginUser, verifyToken.
          Wire routes in server.ts.
          Only implement what test/auth.test.ts requires.
      eval:
        command: "bun test test/auth.test.ts"
      qa:
        prompt: |
          Test auth endpoints with curl against a live server on port 3458.
          Kill port, start server, wait 2s, test register → login → /me.
          Kill server when done.
```

### Why per-stage prompts matter

**write-tests** defines the contract. It tells the develop agent exactly
what to implement by specifying the test cases and expected API surface.
Without specific write-tests prompts, the agent invents its own API
which downstream consumers can't predict.

**develop** needs to know where to put code and what conventions to
follow. It should read existing source for patterns. A vague "implement
auth" prompt leads to scope creep — the agent builds auth plus
session management plus user profiles plus password reset.

**eval** should run only this task's tests. Using `bun test` (all tests)
means a develop agent retries on failures from other tasks' tests,
wasting turns on code it didn't write.

**qa** needs step-by-step instructions for how to test. Without them,
the agent may skip server startup, forget to kill the process, or test
endpoints that don't exist yet.

### Specifying tools and methods per stage

Different stages benefit from different tools and approaches:

**write-tests**: Only needs Read (to check existing code) and Write
(to create test files). Tell the agent not to use Bash for running
tests — that's eval's job.

**develop**: Needs Read, Write, Edit, Bash (for running tests during
development). May also need Glob to find files. Tell the agent which
test command to run for quick feedback.

**qa**: Specify the testing method based on what's available:
- **REST API testing**: Use Bash with curl commands. Specify exact
  requests and expected responses.
- **Browser testing**: If an MCP browser tool (like Playwright) is
  available, tell the agent to use it:
  ```yaml
  qa:
    prompt: |
      Test the web UI using the browser MCP tools.
      Navigate to http://localhost:3000.
      Test: login form submits, dashboard loads, create/edit/delete work.
      Take screenshots of failures.
  ```
- **Database verification**: Tell the agent to query the database
  directly to verify data integrity after API operations.
- **CLI testing**: For command-line tools, specify the exact commands
  and expected output.

## Default edges

Every action gets default edges for all 7 conditions:
- `pass` → next action in the chain (or complete if last)
- `fail`, `error`, `stuck`, `timeout`, `cost_exceeded`, `max_turns`
  → first action in the task

Self-loop edges (action → itself) are automatically skipped.

Template edges override these defaults:
```yaml
eval:
  edges:
    fail: develop     # override: fail goes to develop, not first
```

Always define edges for all failure conditions on critical actions.
Missing edges cause the executor to stall or escalate to the
supervisor. Explicit edges give you predictable retry behavior.

## Overrides

Per-task overrides let you customize specific actions:

```yaml
tasks:
  - id: auth
    template: tdd
    overrides:
      write-tests:
        prompt: "Write auth tests..."
      develop:
        prompt: "Implement auth..."
      eval:
        command: "bun test test/auth.test.ts"
      commit:
        command: "git add -A && git commit -m 'feat: auth' --allow-empty"
```

The override merges into the action's params, winning over both
the template default and the task-level prompt.

## Built-in patterns

### tdd (write-tests → develop → eval [→ commit])
For data layer, models, utilities. The write-tests agent creates
tests first, defining the API contract. Then develop implements to
pass them. Include a commit action to checkpoint progress in git.

### tdd-qa (write-tests → develop → eval → commit → qa)
For HTTP endpoints and user-facing features. Same as tdd, plus a
QA agent that starts the server and tests live functionality. QA
should use curl for API testing or browser tools for frontend testing.

### dev (develop → eval [→ commit])
For config changes, package.json, simple refactors, documentation.
No test-writing — the develop agent works directly.

### planner (plan)
For dynamic task decomposition. The planner agent reads project state,
decomposes work into tasks, and creates them via the API. Planner
prompts should live in the template so new planners inherit them.

### sprint-qa (qa)
Integration testing at milestone boundaries. Unlike task-level qa,
sprint-qa runs ALL tests (`bun test`, not `bun test test/one.test.ts`)
and tests cross-feature interactions.

## Using templates with POST /groups

```bash
curl -X POST /groups -d '{
  "id": "auth",
  "template": "tdd",
  "project_id": "my-project",
  "prompt": "Build auth",
  "overrides": {
    "write-tests": { "prompt": "Write auth tests in test/auth.test.ts..." },
    "develop": { "prompt": "Implement auth in src/auth.ts..." },
    "eval": { "command": "bun test test/auth.test.ts" }
  }
}'
```

The server reads `project.orca.yaml` from the project's directory,
finds the template, and expands it into actions + edges.

## Git commit strategy

Include a `commit` action after eval in your templates:

```yaml
commit:
  type: command
  params:
    command: "git add -A && git commit -m 'feat: ${TASK_ID:-update}' --allow-empty"
    timeout: 10
```

Benefits:
- Progress is preserved between tasks (bisectable history)
- Later tasks can `git log` to see what was built
- `--allow-empty` prevents failures when nothing changed
- Task-level overrides can set descriptive commit messages
