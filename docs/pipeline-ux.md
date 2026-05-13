# Pipeline UX: Making Pipelines Easier to Write and Debug

Observations from writing real pipelines (codream, quantagraph, link-board)
and ideas for improving the authoring experience.

---

## Current Pain Points

### 1. Commands fail silently with environment issues

The codream pipeline had `cd packages/web && npx tsc --noEmit 2>&1` as
its eval command. This worked fine when tested manually in a nix shell,
but when orca ran it, the nix shell wrapping mangled the command. The
eval action failed with exit code 1, the develop agent retried, and the
pipeline burned 5 iterations before anyone noticed the eval command
itself was broken.

**Root cause:** There's no preflight check. Orca trusts that every
command in the config will work, and you only discover problems after
the pipeline has been running (and spending money) for a while.

### 2. Repetitive template definitions across projects

Both codream and quantagraph define identical `tdd`, `dev`, and
`sprint-qa` templates. The templates are ~30 lines each and duplicated
verbatim. If you change the retry edge pattern in one project, you need
to update every other project manually.

### 3. Prompts are too long for YAML

The quantagraph pipeline is 1700 lines, mostly because each task has
two 40-line prompts (write-tests and develop). The codream pipeline is
460 lines with shorter prompts. Reading and editing these prompts inline
in YAML is painful — YAML's multiline string syntax (`|`, `>`) is
error-prone and hard to diff.

### 4. The quantagraph "project constraint" is repeated 24 times

Every quantagraph write-tests and develop prompt starts with the same
30-line block explaining coordinate-free graph structures. This is
duplicated across all 12 gravity and 12 quantum tasks. If the
explanation changes, you update 24 prompts.

### 5. No way to test a single task

To test whether the eval command for `kata-surface` works, you have to
import the entire config and either wait for the pipeline to reach that
task, or manually patch its status to pending. There's no `orca run
--task kata-surface --action eval` to just run one action.

### 6. No validation before execution

You only discover problems when actions fail:
- Missing eval command → error at runtime
- Eval command uses wrong binary → fail at runtime
- Typo in depends_on → foreign key error during import
- Agent prompt references wrong file paths → agent confusion at runtime

---

## Proposed YAML Format Improvements

### A. Shared prompt context via `context` field

Instead of duplicating project descriptions in every prompt, define
shared context at the project level:

```yaml
# Current: repeated in every prompt
tasks:
  - id: G1
    overrides:
      write-tests:
        prompt: |
          Project: Quantagraph reformulates physics using purely relational
          graph structures — no coordinate systems...
          [30 lines of shared context]

          Level G1: Write tests for Newtonian gravity in 1D.
          [10 lines of specific instructions]

# Proposed: shared context defined once
context:
  project: |
    Quantagraph reformulates physics using purely relational graph
    structures — no coordinate systems, no embedding in a background
    space. [30 lines, defined once]

  environment: |
    You are running inside a nix shell. Run tests with `uv run pytest ...`.

tasks:
  - id: G1
    overrides:
      write-tests:
        prompt: |
          Level G1: Write tests for Newtonian gravity in 1D.
          Create tests/gravity/test_g1.py.
          [10 lines of specific instructions]
```

The executor prepends `context.project` and `context.environment` to
every agent prompt automatically. The task prompts only contain
task-specific instructions.

This reduces quantagraph from ~1700 lines to ~600 lines.

### B. Prompt files instead of inline YAML

For long prompts, reference external files:

```yaml
tasks:
  - id: G1
    overrides:
      write-tests:
        prompt_file: prompts/g1-write-tests.md
      develop:
        prompt_file: prompts/g1-develop.md
```

Benefits:
- Prompts are markdown files — proper syntax highlighting, easy to diff
- Each prompt is independently editable
- Prompts can be version-controlled separately from the pipeline
- Agents can read and modify prompt files at runtime (dynamic tasking)

### C. Built-in templates (no need to define tdd/dev in every project)

Ship standard templates with orca. Projects only define custom ones:

```yaml
# Current: every project defines tdd, dev, sprint-qa
templates:
  tdd:
    actions: [write-tests, develop, eval, commit]
    types: { ... }  # 20 lines

# Proposed: use built-in templates, only override what's different
templates:
  tdd:
    extends: builtin:tdd    # inherits actions, types, edges
    types:
      eval:
        timeout: 120        # override just the timeout
```

Built-in templates: `tdd`, `tdd-qa`, `dev`, `planner`, `sprint-qa`,
`notify`, `supervisor`. Defined inside the orca binary. Projects
can extend or override.

### D. Simplified eval shorthand

Eval commands are the most common override. Add a shorthand:

```yaml
# Current
overrides:
  eval:
    command: "cd packages/web && npx tsc --noEmit"

# Proposed shorthand
eval: "cd packages/web && npx tsc --noEmit"
```

Or even shorter for common patterns:

```yaml
eval: bun test test/auth.test.ts
eval: pytest tests/test_auth.py -v
eval: cd packages/web && npx tsc --noEmit
```

### E. Variables and interpolation

Currently, only `${TASK_ID}` is interpolated in commands. Extend to
support project-level variables:

```yaml
vars:
  test_runner: "uv run pytest"
  api_port: 3458

tasks:
  - id: G1
    overrides:
      eval:
        command: "${test_runner} tests/gravity/test_g1.py -v"
      qa:
        prompt: "Start server on port ${api_port}..."
```

This eliminates hardcoded values repeated across tasks.

### F. Task groups for repeated patterns

Quantagraph has 6 gravity tasks with identical structure, differing
only in the level name, test file, and prompt. Support iteration:

```yaml
# Current: 6 nearly identical task blocks
tasks:
  - id: G1
    template: tdd
    overrides:
      eval: { command: "uv run pytest tests/gravity/test_g1.py -v" }
      commit: { command: "git add -A && git commit -m 'G1: ...' || true" }
  - id: G2
    template: tdd
    depends_on: [G1]
    overrides:
      eval: { command: "uv run pytest tests/gravity/test_g2.py -v" }
      commit: { command: "git add -A && git commit -m 'G2: ...' || true" }
  # ... G3, G4, G5, G6

# Proposed: generate from a pattern
task_groups:
  - ids: [G1, G2, G3, G4, G5, G6]
    template: tdd
    chain: true  # each depends_on the previous
    tags: [path:gravity]
    overrides:
      eval:
        command: "uv run pytest tests/gravity/test_${TASK_ID}.py -v"
      commit:
        command: "git add -A && git commit -m '${TASK_ID}: gravity' || true"
```

---

## CLI and Workflow Improvements

### A. `orca validate <config>`

Validate the config without importing or executing:

```
$ orca validate project.orca.yaml
✓ YAML syntax valid
✓ 8 tasks, 26 actions
✓ All templates resolve
✓ All depends_on targets exist
✓ No self-loop edges
✓ All agent actions have prompts
⚠ eval command "bun test" runs all tests (consider scoping)
⚠ No supervisor defined
```

Catches: missing prompts, dangling depends_on, undefined templates,
broad eval commands.

### B. `orca preflight <config>`

Import the config, then dry-run every command action in the project's
environment:

```
$ orca preflight project.orca.yaml
Importing 26 actions...
Running preflight checks in /home/user/projects/codream...
  agent-submit-fix.eval: cd packages/web && npx tsc --noEmit
    ✓ command executes (exit 0, 2.3s)
  agent-submit-fix.commit: git add -A && git commit -m '...' --allow-empty
    ✓ command executes (exit 0, 0.1s)
  git-surface.eval: cd packages/api && bun test src/handlers.test.ts
    ✗ command failed (exit 1): Cannot find test file
    (this is expected — tests haven't been written yet)
  kata-surface.eval: cd packages/web && npx tsc --noEmit
    ✓ command executes (exit 0, 2.1s)

Preflight complete: 6/8 commands executable, 2 expected failures.
```

The key insight: preflight doesn't care if the command passes or fails
(tests haven't been implemented yet). It cares whether the command
**can execute at all** — right binary, right directory, right
environment. `exit 1` from a real test failure is fine. `command not
found` is a config bug.

### C. `orca run <config> --task <id>`

Run a single task's actions in sequence, without importing the full
config or starting the server:

```
$ orca run project.orca.yaml --task kata-surface
▶ kata-surface.develop [agent] started
✓ kata-surface.develop → pass ($0.32, 45s)
▶ kata-surface.eval [command] started
✓ kata-surface.eval → pass (0s)
▶ kata-surface.commit [command] started
✓ kata-surface.commit → pass (0s)
Done: kata-surface completed (3 actions, $0.32)
```

This lets you test a single task's prompts and eval command without
waiting for dependencies or running the full pipeline.

### D. `orca run <config> --action <id> --dry-run`

Show what would happen without executing:

```
$ orca run project.orca.yaml --action kata-surface.eval --dry-run
Action: kata-surface.eval
Type: command
Command: cd packages/web && npx tsc --noEmit
CWD: /home/user/projects/codream
Nix env: shell.nix (codream dev shell)
Timeout: 60s
On pass → kata-surface.commit
On fail → kata-surface.develop
```

### E. `orca import <config> --check`

Import and show the graph without starting the executor:

```
$ orca import project.orca.yaml --check
Imported 8 tasks, 26 actions, 84 edges

Execution order:
  1. agent-submit-fix.develop → eval → commit (no deps)
  2. chat-context-fix.develop → eval → commit (no deps)
  3. kata-surface.develop → eval → commit (no deps)
  [parallel: 1, 2, 3]
  4. agent-running-ux.develop → eval → commit (after: agent-submit-fix)
  5. git-surface.write-tests → develop → eval → commit → qa
     (after: agent-submit-fix, chat-context-fix)
  6. live-reload.develop → eval → commit (after: git-surface)
  7. chat-cleanup.write-tests → develop → eval → commit → qa (after: git-surface)
  8. sprint-1-qa.qa (after: all)
```

### F. Watch mode for development

```
$ orca watch project.orca.yaml
Watching project.orca.yaml for changes...
[12:01:03] Config changed, re-validating...
✓ 8 tasks, 26 actions, no errors

[12:01:15] Config changed, re-validating...
✗ Task "new-task" references unknown template "tdd-browser"
```

Validates on every save. Catches YAML errors immediately.

---

## Dashboard Improvements

### Show command output inline

Currently, command action failures show "Exit code 1" in the dashboard.
The actual stdout/stderr is in the JSONL log. The dashboard should
show the command's output directly in the action detail panel — this
is where you discover "npx: command not found" or "no test file" errors.

### Show edge routing visualization

When an action completes, highlight which edge was followed and why.
Currently you see "condition: fail" but not which action was activated
next. The graph view should animate the edge traversal.

### Preflight results in dashboard

Show preflight results before the pipeline starts. Green check for
commands that execute, red X for commands that fail to start. Let the
user fix config issues before spending money on agent actions.

---

## Summary of Priorities

**High impact, low effort:**
1. `orca validate` — catches config errors before import
2. `orca preflight` — catches environment issues before execution
3. Shared `context` field — eliminates prompt duplication
4. Command output in dashboard — faster debugging

**High impact, medium effort:**
5. `orca run --task` — test individual tasks
6. Built-in templates — eliminate boilerplate
7. Prompt files (`prompt_file:`) — better editing experience
8. Variables (`${var}`) — eliminate hardcoded values

**Medium impact, higher effort:**
9. Task groups — reduce repetitive task definitions
10. Watch mode — real-time validation
11. Eval shorthand — minor ergonomic improvement
