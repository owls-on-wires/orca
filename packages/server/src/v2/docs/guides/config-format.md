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
    actions: [write-tests, develop, eval]
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
        command: "bun test"
        timeout: 30
        edges:
          fail: develop
```

See /docs/guides/templates.md for full template documentation.

## Tasks

Each task produces a chain of actions based on its template:

```yaml
tasks:
  - id: auth                   # Required. Unique task ID.
    template: tdd              # Template to use
    prompt: "Build auth..."    # Prompt for agent actions (optional if template provides one)
    depends_on: [setup-schema] # Wait for these tasks to complete
    tags: [epic:1, backend]    # Extra tags added to all actions
    budget:
      max_iterations: 5        # Max retries per action
      max_cost: 2.50           # Max cost per task (USD)
    overrides:                 # Per-action-type param overrides
      write-tests:
        prompt: "Write auth tests..."
      eval:
        command: "bun test test/auth.test.ts"
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

## Scope enforcement

The `scope` section restricts what files agents can access:

```yaml
scope:
  writable: ["src/**", "test/**"]
  readable: ["**"]
```

Agents get a 403-style denial if they try to write outside writable
paths or read outside readable paths.

## Full example

```yaml
name: bookmark-api
project_dir: .
model: sonnet
scope:
  writable: ["**"]
  readable: ["**"]

templates:
  tdd:
    actions: [write-tests, develop, eval]
    types:
      write-tests: { type: agent, max_turns: 40, toolset: all }
      develop: { type: agent, max_turns: 80, toolset: all }
      eval:
        type: command
        command: "bun test"
        timeout: 30
        edges: { fail: develop }

tasks:
  - id: setup-schema
    template: tdd
    prompt: "Create database schema..."
    overrides:
      eval: { command: "bun test test/schema.test.ts" }

  - id: impl-bookmarks
    template: tdd
    prompt: "Implement bookmark CRUD..."
    depends_on: [setup-schema]
```
