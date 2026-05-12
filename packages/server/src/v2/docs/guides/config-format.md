# Config Format

Reference for `project.orca.yaml`.

## Top-level fields

```yaml
name: my-project              # Required. Project ID.
project_dir: .                # Project root (resolved relative to YAML location)
model: sonnet                 # Default model for agent actions
scope:
  writable: ["src/**", "test/**"]   # Glob patterns agents can write to
  readable: ["**"]                   # Glob patterns agents can read
git:
  snapshot: true              # Git snapshot before each action
```

## Templates

Reusable task patterns. Define the action chain and types:

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
          command: "git add -A && git commit -m 'feat: ${TASK_ID:-update}' --allow-empty"
          timeout: 10
```

See /docs/guides/templates.md for full template documentation.

## Tasks

Each task produces a chain of actions based on its template:

```yaml
tasks:
  - id: auth                   # Required. Unique task ID.
    template: tdd              # Template to use
    prompt: "Build auth..."    # Shared prompt (optional if template or overrides provide one)
    depends_on: [setup-schema] # Wait for these tasks to complete
    tags: [epic:1, backend]    # Extra tags added to all actions
    budget:
      max_iterations: 5        # Max retries per action
      max_cost: 2.50           # Max cost per task (USD)
    overrides:                 # Per-action-type param overrides
      write-tests:
        prompt: "Write auth tests..."
      develop:
        prompt: "Implement auth..."
      eval:
        command: "bun test test/auth.test.ts"
```

## Writing effective prompts

The most important part of a pipeline config is the prompts. Each
agent action (write-tests, develop, qa, etc.) should get its own
tailored prompt via `overrides`. A single `prompt` shared across all
stages is almost always too vague.

### Per-stage prompt guidelines

**write-tests** — Tell the agent exactly what to test, not what to build:
- Specify the test file path (`test/auth.test.ts`)
- List the exact test cases (registration, login, error handling)
- Name the imports and API surface (`import { createUser } from "../src/auth"`)
- Specify test patterns (`use beforeEach(() => resetDb())`)
- State explicitly: "Do NOT implement source code — only write tests"

**develop** — Tell the agent what to implement and where:
- Name the files to create or modify (`src/auth.ts`, `src/db.ts`)
- Specify the functions/endpoints to build
- Tell agent to read existing source first (`Read src/server.ts for conventions`)
- Scope strictly: "Only implement what test/auth.test.ts requires — nothing more"
- If the project has a nix environment, remind the agent of available tools

**eval** — Use a scoped test command, not `bun test` or `pytest`:
- `bun test test/auth.test.ts` — only this task's tests
- `uv run pytest tests/test_auth.py -v` — only this task's tests
- Save `bun test` (run all) for sprint QA at milestone boundaries

**qa** — Tell the agent how to test live functionality:
- Kill any existing process on the port first
- Start the server, wait for it
- List specific requests to make and expected responses
- If a browser MCP tool is available, tell the agent to use it for
  frontend testing (navigate, click, assert content)
- If only curl is available, specify curl commands explicitly
- Kill the server when done
- Skip endpoints that return 500 (stubs, not failures)

**commit** — Usually a command, not an agent:
- `git add -A && git commit -m 'feat: auth' --allow-empty`
- The `--allow-empty` prevents failures when nothing changed

### Prompt scoping rules

Agents will use every piece of context they receive. If you mention
the full project roadmap, they will try to build the roadmap.

- Do NOT tell agents to read roadmap/epic files
- Do NOT describe future tasks or features beyond the current one
- DO reference existing source files the agent should read for conventions
- DO specify the exact scope of work in the prompt
- DO put design docs in files agents can read on demand, rather than
  inlining long explanations in the prompt

### Example: well-scoped task with per-stage prompts

```yaml
- id: user-auth
  template: tdd-qa
  depends_on: [db-setup]
  overrides:
    write-tests:
      prompt: |
        Write tests for user authentication in test/auth.test.ts.

        Test cases:
        1. POST /register creates a user with hashed password
        2. POST /register rejects duplicate username (409)
        3. POST /login returns JWT for valid credentials
        4. POST /login returns 401 for invalid password
        5. GET /me returns user profile with valid JWT
        6. GET /me returns 401 without JWT

        Import the server from "../src/server". Port 3458.
        Use beforeEach(() => resetDb()) to clean state.
        Do NOT implement any source code.
    develop:
      prompt: |
        Implement user authentication.
        Read src/server.ts and src/db.ts first for conventions.

        Create/modify:
        - src/auth.ts: createUser, loginUser, verifyToken
        - Wire POST /register, POST /login, GET /me in server.ts

        Use Bun.password.hash/verify for passwords.
        Use HMAC-SHA256 JWT (no external libraries).
        Only implement what test/auth.test.ts requires.
    eval:
      command: "bun test test/auth.test.ts"
    qa:
      prompt: |
        Test the auth endpoints with curl against a live server.

        1. Kill any process on port 3458:
           kill $(lsof -ti:3458 -sTCP:LISTEN) 2>/dev/null
        2. Start server: bun run src/server.ts &
        3. Wait 2 seconds

        Test:
        - Register a user, verify 201
        - Register duplicate, verify 409
        - Login, extract JWT from response
        - GET /me with JWT, verify username in response
        - GET /me without JWT, verify 401

        Kill the server when done.
        Report "passed" if all tests pass.
        Report "failed" only for unexpected errors on implemented endpoints.
        Skip any endpoint that returns 500 (not implemented yet).
```

## Action IDs

Actions are named `{task-id}.{action-type}`:
- `auth.write-tests`
- `auth.develop`
- `auth.eval`

## Auto-generated tags

Every action gets:
- `type:{action-type}` (e.g., `type:develop`)
- `task:{task-id}` (e.g., `task:auth`)
- `project:{project-name}` (e.g., `project:my-project`)
- Plus any tags from the task's `tags` field

## Dependencies

`depends_on` creates pass edges from each dependency's terminal
action to this task's first action:

```yaml
tasks:
  - id: api
    depends_on: [models, tags]  # api starts after both complete
```

This creates:
- `models.eval` → `api.write-tests` [pass]
- `tags.eval` → `api.write-tests` [pass]

## Edge conditions

Every action gets default edges for all 7 conditions:
- `pass` → next action (or complete if last)
- `fail`, `error`, `stuck`, `timeout`, `cost_exceeded`, `max_turns` →
  first action in the task

Template edges override defaults. Always define failure edges
explicitly — missing edges cause the graph to stall silently.
Use a supervisor as a global fallback for unhandled conditions.

## Scope enforcement

```yaml
scope:
  writable: ["src/**", "test/**"]
  readable: ["**"]
```

Agents get denied if they try to write outside writable paths.
For projects where agents build from scratch, use `writable: ["**"]`.

## Budget and iteration limits

```yaml
budget:
  max_iterations: 10    # Safety rail — not a performance target
  max_cost: 5.00        # Max USD spent on this task
```

Practical values:
- `max_iterations: 5-10` for simple tasks (CRUD, config)
- `max_iterations: 10-20` for complex tasks (algorithms, hard bugs)
- `max_turns: 40-50` for write-tests (just writing test files)
- `max_turns: 80-100` for develop (implement + debug)
- `max_turns: 30` for qa (run curl commands)

A task that needs 20 iterations probably needs a better prompt, not
a higher limit.
