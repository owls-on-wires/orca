---
name: orca-reference
description: Complete reference for the orca build orchestrator — file format, conventions, commands, stages, notifications, state, and the .orca directory structure. Activates when working with orca config files or build artifacts.
user-invocable: false
paths:
  - "**/project.orca.yaml"
  - "**/.orca/**"
  - "**/stages/**/*.prompt.txt"
  - "**/stages/**/*.schema.json"
---

# Orca Reference

Orca is a declarative build orchestrator for Claude Code agents. A `project.orca.yaml` file defines tasks, workflow, evaluation, and budget. The `orca` binary executes it, spawning Claude subagents for each stage.

Orca can run as a CLI (`orca run`) or as a persistent HTTP server (`orca serve`) with a REST API, SSE streaming, and a web dashboard.

## project.orca.yaml Schema

```yaml
name: my-build                    # Build name (required)
project_dir: .                    # Project root relative to this file
model: opus                       # Default Claude model

tasks:                            # Task definitions (required)
  file: tasks.yaml                # External file
  defaults:                       # Applied to every task
    budget: { max_iterations: 10, max_cost: 50 }
    stages: { develop: { max_turns: 100 } }
    variables: { principle: "..." }
  list:                           # Inline tasks
    - id: my_task
      title: "My Task"
      tags: [core]
      depends_on: []
      eval: { command: "...", parser: cargo_test }
      budget: { max_iterations: 15 }
      variables: { description: "..." }

eval:                             # Default eval for all tasks
  command: "cargo test --test {task_id} 2>&1"
  parser: cargo_test              # cargo_test | pytest | json | exit_code
  timeout: 300
  results_file: "results.json"    # Read eval results from file instead of stdout

workflow:                         # Stage execution order (required)
  setup: scaffold                 # Run once before all tasks
  pre: [understand, write_tests]  # Run once per task
  loop: [eval, analyze, develop]  # Iteration loop (required)
  post: [regression]              # Run after loop passes

workflows:                        # Named workflow templates (optional)
  tdd:
    pre: [write_tests]
    loop: [eval, analyze, develop]
    post: [regression]
  simple:
    loop: [eval, develop]

stages:                           # Stage configurations
  develop:
    type: agent                   # agent | command | eval (inferred if omitted)
    gate: true                    # Require status: "passed"; restart loop on failure
    builtin: develop              # Use this built-in prompt/schema instead of stage name
    toolset: all                  # read_only | all | code | bash
    max_turns: 150
    model: opus                   # Override model for this stage
    escalation: true              # Check output for escalation
    supervisor: true              # Invoke supervisor on escalation
    condition: always             # always | has:<var> | file_missing:<path>
    scope:                        # Per-stage scope override
      writable: ["src/**"]
  deploy:                         # Command stage (no Claude invocation)
    type: command
    command: "bash deploy.sh"     # Shell command to run
    wait_for: "curl -sf http://localhost:3000/health"  # Health check
    wait_timeout: 120             # Max seconds to wait

nix:                              # Nix environment (optional)
  flake: true                     # Use repo's flake.nix (or path to flake)
  # packages: [nodejs, bun]      # Ad-hoc nix shell -p (alternative to flake)
  # enable: false                 # Disable nix even if flake.nix exists

git:
  enabled: true
  snapshot_before: develop        # Auto-snapshot before this stage
  commit_after: loop              # Commit when loop passes
  commit_message: "{name}: {task_id} complete"

scope:
  writable: ["src/**"]            # Glob patterns for Write/Edit
  readable: ["**"]                # Glob patterns for Read/Glob/Grep

budget:
  max_iterations: 10
  max_cost: 80.0
  stage_timeout: 900              # Seconds per stage
  stuck_window: 3                 # Identical outputs before stuck detection

prompts:
  context: "This is a Rust project using async/await."  # Prepended to every stage prompt
  stages:                         # Per-stage text, appended to the stage prompt
    develop: "Focus on performance."

supervisor:
  model: opus
  toolset: all
  max_turns: 40
  prompt: "custom supervisor prompt"  # Override built-in supervisor prompt
  stuck_window: 3                 # Identical outputs before stuck detection

notifications:
  on_build_start: true
  on_task_start: true
  on_escalation: true
  on_task_complete: true
  on_build_complete: true
  on_budget_warning: 0.8
  channels: []

orca:                             # Live-reloadable (edit while running)
  max_iterations: 10
  max_cost: 80.0
  max_turns: 150
  stage_timeout: 900
```

## Task Fields

**Structured** (orca interprets):
- `id` — unique identifier (lowercase, hyphens/underscores)
- `title` — display name
- `tags` — for filtering (`--tag`, `--skip-tag`)
- `depends_on` — task IDs that must pass first
- `eval` — per-task eval override
- `budget` — per-task budget override
- `stages` — per-task stage overrides (max_turns, toolset)
- `workflow` — name of a workflow template from the `workflows` map

**Freeform** (passed to prompts):
- `variables` — arbitrary key-value bag, everything becomes a template variable

### Merge Semantics (defaults → task)

| Field | Behavior |
|-------|----------|
| Scalars | Task wins |
| `tags`, `depends_on` | Task replaces |
| `eval`, `budget` | Shallow merge |
| `stages` | Deep merge per stage |
| `variables` | Deep merge (task extends defaults) |

## Workflow Patterns

| Pattern | Config |
|---------|--------|
| **TDD** | `pre: [write_tests]`, `loop: [eval, analyze, develop]`, `post: [regression]` |
| **Metric** | `loop: [eval, analyze, develop]` |
| **Maintainer** | `pre: [understand, write_tests]`, `loop: [eval, analyze, develop]`, `post: [regression]` |
| **Simple** | `loop: [eval, develop]` |

## Template Variables

Prompts use `{variable}` syntax. Three sources (highest priority wins):

1. **Task variables** — from `variables` bag: `{description}`, `{develop_focus}`, `{test_list}`
2. **Auto-populated** — `{task_id}`, `{task_title}`, `{name}`, `{project_dir}`, `{shared_data_dir}`
3. **Orca built-ins** — `{orca.iteration}`, `{orca.total_cost}`, `{orca.budget_remaining}`, `{orca.max_iterations}`, `{orca.last_snapshot}`

Special: `variables.tests` (array of `{name, description}`) also produces `{test_list}` as a numbered list.

## Built-in Default Stages

Orca ships default prompts and schemas for these stages. Projects can override by placing files in `stages/`:

| Stage | Purpose | Toolset |
|-------|---------|---------|
| `setup` | Build project, record baseline | all |
| `understand` | Study existing codebase before changes | read_only |
| `write_tests` | Create test file from task definition | code |
| `analyze` | Read-only failure diagnosis | read_only |
| `develop` | Implement changes (includes escalation) | all |
| `supervisor` | Handle escalations from develop | all |
| `regression` | Full suite regression check | all |
| `qa` | Quality assurance / review | read_only |

### Stage File Resolution Order

1. `stages/{task_id}/{stage}.prompt.txt` — task-specific override
2. `stages/{stage}.prompt.txt` — project-level shared
3. Orca built-in default — always available

## Eval Parsers

| Parser | Input | Gate |
|--------|-------|------|
| `cargo_test` | Cargo test stdout | `failed == 0 && total > 0` |
| `pytest` | Pytest stdout | `failed == 0 && errors == 0` |
| `json` | Command outputs JSON with `all_passed` | `all_passed` field |
| `exit_code` | No parsing | `exit_code == 0` |

## Escalation Protocol

The develop stage can return an `escalation` object:
```json
{
  "status": "failed",
  "escalation": {
    "cause": "test_bug",           // test_bug | environment_problem | bad_requirements
    "diagnosis": "The test asserts wrong value",
    "evidence": "tests/test.rs:45",
    "suggested_fix": "Change assertion"
  }
}
```

The supervisor agent investigates and decides: `fix_test`, `fix_environment`, `resolve_requirements`, `revert`, `clear_session`, `escalate_human`, or `continue`.

## .orca Directory Structure

```
project/
  .orca/
    runs/{name}/{timestamp}/
      state.json              # Build state (status, tasks, cost, history)
      {stage}_iter{N}.jsonl   # Per-stage JSONL logs
      eval_iter{N}.json       # Eval result artifacts
    intervention.json         # Present when build needs human input
    intervention_response.json # Human writes this to resume
    build.pid                 # PID of detached build process
    build.log                 # Stdout/stderr of detached build
```

## Commands

```bash
# Build commands
orca run project.orca.yaml                # run (resumes from prior state if available)
orca run project.orca.yaml --fresh        # ignore prior state, start all tasks from scratch
orca run project.orca.yaml --detach       # background build
orca run project.orca.yaml --monitor      # start web monitor alongside the build
orca run project.orca.yaml --task x       # single task
orca run project.orca.yaml --from x       # run all tasks starting from this one
orca run project.orca.yaml --tag core     # filter by tag

# Monitoring
orca monitor project.orca.yaml            # watch a running build (web UI)
orca status project.orca.yaml             # one-line summary
orca status project.orca.yaml --json      # machine-readable

# Management
orca validate project.orca.yaml           # check config
orca init --template rust-library         # scaffold
orca abort project.orca.yaml              # stop running build

# Serve mode (persistent HTTP server)
orca serve                                # start on port 7070
orca serve --port 8080                    # custom port
orca serve --data-dir /path/to/data       # custom data directory
```

Aliases (backwards compatible):
- `orca build <config>` = `orca run --fresh`
- `orca resume <config>` = `orca run`

## Serve Mode — REST API

When running `orca serve`, builds are managed via HTTP:

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/builds` | Create build. Body: `{ repo, branch?, spec?, spec_path?, name? }` |
| `GET` | `/builds` | List all builds |
| `GET` | `/builds/:id` | Build detail with state |
| `DELETE` | `/builds/:id` | Stop a running build |
| `POST` | `/builds/:id/intervene` | Respond to intervention. Body: `{ action, note? }` |
| `GET` | `/builds/:id/logs` | Captured stdout/stderr |
| `GET` | `/builds/:id/events` | SSE stream (events: `status`, `state`, `stdout`, `stderr`) |
| `GET` | `/health` | Health check |
| `GET` | `/` | Web dashboard |

The serve process clones repos, spawns `orca run` as child processes (optionally wrapped in nix), watches state files, and streams updates to SSE clients. Multiple builds can run concurrently.

## Command Stages

Stages with a `command` field run a shell command instead of invoking Claude. Useful for deploy, setup, or teardown steps:

```yaml
stages:
  deploy:
    command: "bash scripts/deploy.sh"
    wait_for: "curl -sf http://localhost:3000/health"
    wait_timeout: 120
```

Command stages work in both `loop` and `post` sections. Template variables (`{task_id}`, etc.) are interpolated in the command.

## Nix Environment

When running in serve mode, orca auto-detects nix environments:

| Priority | Condition | Command |
|----------|-----------|---------|
| 1 | `nix.flake` in spec | `nix develop {path} --command orca run ...` |
| 2 | `nix.packages` in spec | `nix shell nixpkgs#pkg1 ... --command orca run ...` |
| 3 | `flake.nix` in repo | `nix develop --command orca run ...` |
| 4 | `shell.nix` in repo | `nix-shell shell.nix --run "orca run ..."` |
| 5 | None | `orca run ...` (no nix) |

Disable with `nix: { enable: false }`.

## Stage Summaries

Each stage can produce a summary via the `evalSummary` function. Summaries are stored in `state.json` per-stage history entries and displayed in the monitor. Stage schemas include a `summary` field for the agent to populate.

## Subagent Tool Restriction

When spawning Claude subagents, use `tools` (not `allowedTools`) to restrict which tools the subagent can use. This aligns with the Agent SDK's current API.

## Live Task Queue

Tasks added to the YAML mid-build are picked up automatically at task boundaries. The task file is re-read between tasks, so you can extend a running build without restarting it.

## Notifications

Channels are blank by default — users configure their preferred backend. Command-only channel type: runs a shell command with variables substituted.

For mobile push, use ntfy or a similar service (Pushover, Gotify) — free, no account needed:

```yaml
channels:
  - type: command
    run: "curl -s -d '{message}' https://ntfy.sh/myproject-a1b2c3"
```

Pick a unique topic like `projectname-xxxxxx` (build name + 6-letter hash) to avoid collisions. Install the ntfy app on your phone and subscribe to the same topic.

Variables: `{message}`, `{event}`, `{build_name}`, `{task_id}`, `{details}`.

## Intervention Protocol

When a build pauses for human input:

### Local builds (file-based)
1. Read `.orca/intervention.json` for the request
2. Fix the issue (edit code, tests, config)
3. Write `.orca/intervention_response.json`:
   ```json
   {"action": "continue", "note": "Fixed the test"}
   ```
   Actions: `continue`, `skip`, `abort`
4. Build resumes automatically (polls every 10 seconds)

### Remote builds (REST API)
```bash
curl -X POST http://localhost:7070/builds/<id>/intervene \
  -H "Content-Type: application/json" \
  -d '{"action": "continue", "note": "Fixed the test"}'
```

The web dashboard at `http://localhost:7070/` shows an intervention banner with action buttons.
