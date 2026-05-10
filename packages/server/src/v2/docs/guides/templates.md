# Templates

Templates define reusable task patterns — the action chain, types,
edges, and default parameters.

## Defining templates in project.orca.yaml

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
          stuck: develop
          error: develop
          timeout: develop
          cost_exceeded: develop
          max_turns: develop
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

This means a template can define a default prompt:

```yaml
templates:
  planner:
    actions: [plan]
    types:
      plan:
        type: agent
        params:
          prompt: "You are a build planner. Read EPICS.md..."
```

Tasks using this template don't need a prompt field — they inherit
the template's.

## Default edges

Every action gets default edges for all 7 conditions:
- `pass` → next action in the chain (or complete if last)
- `fail`, `error`, `stuck`, `timeout`, `cost_exceeded`, `max_turns` → first action

Self-loop edges (action → itself) are automatically skipped.

Template edges override these defaults:
```yaml
eval:
  edges:
    fail: develop     # override: fail goes to develop, not first
```

## Overrides

Per-task overrides let you customize specific actions:

```yaml
tasks:
  - id: auth
    template: tdd
    prompt: "Build auth system"
    overrides:
      write-tests:
        prompt: "Write auth tests specifically..."
      eval:
        command: "bun test test/auth.test.ts"
```

The override merges into the action's params, winning over both
the template default and the task-level prompt.

## Built-in patterns

### tdd (write-tests → develop → eval)
For data layer, models, utilities. The write-tests agent creates
tests first, then develop implements to pass them.

### tdd-qa (write-tests → develop → eval → qa)
For HTTP endpoints. Same as tdd, plus a QA agent that starts
the server and tests live endpoints with curl.

### dev (develop → eval)
For config changes, package.json, simple refactors. No test-writing.

## Using templates with POST /groups

```bash
curl -X POST /groups -d '{
  "id": "auth",
  "template": "tdd",
  "project_id": "my-project",
  "prompt": "Build auth",
  "overrides": {
    "write-tests": { "prompt": "Write auth tests..." }
  }
}'
```

The server reads `project.orca.yaml` from the project's directory,
finds the template, and expands it into actions + edges.
