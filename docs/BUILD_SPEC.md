# project.orca.yaml Specification

This document defines the YAML format that replaces `builder.py` scripts. A `project.orca.yaml` file is a complete, declarative description of a build — the orca binary interprets it directly.

---

## Minimal Example

```yaml
name: my-build
project_dir: .
model: opus

tasks:
  file: tasks.yaml

eval:
  command: "cargo test --test {task_id} 2>&1"
  parser: cargo_test

workflow:
  loop:
    - eval
    - analyze
    - develop
```

---

## Full Schema

### Top-level fields

```yaml
# ── Identity ──────────────────────────────────────────────
name: henry-build                    # build name (display, .orca/ path)

# ── Project ───────────────────────────────────────────────
project_dir: .                       # target project root (relative to this file)
model: opus                          # default Claude model

# ── Tasks ─────────────────────────────────────────────────
tasks:
  file: features.yaml                # external task definitions
  defaults: { ... }                  # default values applied to every task
  list: [ ... ]                      # inline task definitions (or loaded from file)

# ── Evaluation ────────────────────────────────────────────
eval:
  command: "cargo test --test {task_id} 2>&1"
  parser: cargo_test                 # cargo_test | pytest | json | exit_code
  timeout: 300                       # seconds

# ── Workflow ──────────────────────────────────────────────
workflow:
  setup: setup                       # run once before all tasks
  pre:                               # run once per task, before loop
    - understand
    - write_tests
  loop:                              # the iteration loop (required)
    - eval
    - analyze
    - develop
  post:                              # run after loop passes
    - regression

# ── Stages ────────────────────────────────────────────────
stages:
  understand:
    toolset: read_only
    max_turns: 60
  develop:
    toolset: all
    max_turns: 150
    escalation: true
    supervisor: true
  # ...

# ── Git ───────────────────────────────────────────────────
git:
  enabled: true
  snapshot_before: develop
  commit_after: loop
  commit_message: "{name}: {task_id} complete"

# ── Scope ─────────────────────────────────────────────────
scope:
  writable: ["src/**"]
  readable: ["**"]

# ── Budget ────────────────────────────────────────────────
budget:
  max_iterations: 10
  max_cost: 80.0
  stage_timeout: 900
  stuck_window: 3

# ── Supervisor ────────────────────────────────────────────
supervisor:
  model: opus
  toolset: all
  max_turns: 40

# ── Notifications ─────────────────────────────────────────
notifications:
  on_escalation: true
  on_task_complete: true
  on_build_complete: true
  on_budget_warning: 0.8
  channels:
    - type: webhook
      url: "https://ntfy.sh/my-builds"

# ── Live Reload ───────────────────────────────────────────
orca:
  max_iterations: 10
  max_cost: 80.0
```

---

## Tasks

Tasks are the units of work. Each task goes through the workflow (pre → loop → post) independently. Tasks can depend on other tasks and be filtered by tags.

### Defining tasks

Tasks can be **inline** or in an **external file** (or both — they merge):

```yaml
# External file:
tasks:
  file: features.yaml

# Inline:
tasks:
  list:
    - id: parsing
      # ...

# Both (inline tasks extend the file):
tasks:
  file: features.yaml
  list:
    - id: extra_task
      # ...
```

### Task schema

```yaml
- id: dev_socket                      # unique identifier (required)
  title: "Test API Socket"            # display name
  tags: [prerequisite, infrastructure] # for filtering / organization
  depends_on: []                      # task IDs that must pass first

  # ── Per-task overrides (override top-level + defaults) ──
  eval:
    command: "cargo test --features dev --test {task_id} 2>&1"
  budget:
    max_iterations: 12
    max_cost: 100.0
  stages:
    understand: { max_turns: 80 }
    develop: { max_turns: 200 }

  # ── Template variables (injected into prompts) ──
  variables:
    description: >
      Add --features dev mode that exposes a Unix socket
      for querying internal editor state.
    spec_ref: "henry-dev-spec.md — Prerequisite 1"
    understand_focus:
      - "Helix's application lifecycle"
      - "The Editor struct and what state it holds"
    develop_focus:
      - "Add a dev feature flag to Cargo.toml"
      - "Create a socket listener module"
    tests:
      - name: socket_opens
        description: "Socket file exists after startup"
      - name: query_state
        description: "Query returns valid JSON"
    principle: "Follow Helix patterns exactly."
```

### Fields reference

**Structured fields** (orca interprets these):

| Field | Type | Description |
|-------|------|-------------|
| `id` | string | Unique identifier. Used in eval commands, file paths, depends_on. Required. |
| `title` | string | Display name for TUI and logs. |
| `tags` | string[] | Organizational labels. Filter with `--tag` / `--skip-tag`. |
| `depends_on` | string[] | Task IDs that must pass before this task starts. Enables parallel execution. |
| `eval` | object | Per-task eval override (command, parser, timeout). |
| `budget` | object | Per-task budget override (max_iterations, max_cost). |
| `stages` | object | Per-task stage overrides (max_turns, toolset per stage). |

**Freeform fields** (passed to prompts as template variables):

| Field | Type | Description |
|-------|------|-------------|
| `variables` | object | Arbitrary key-value bag. Everything inside becomes a template variable. |

Orca never looks inside `variables`. It flattens them and injects into prompt templates. Variable formatting:
- **Strings** → passed through as-is
- **Lists of strings** → formatted as bullet list (`- item`)
- **Lists of objects with `name`/`description`** → formatted as numbered list (`1. **name**: description`)
- **Other** → JSON-serialized

### Defaults

The `defaults` section defines values applied to every task. Per-task values override defaults.

```yaml
tasks:
  defaults:
    tags: []
    depends_on: []
    budget:
      max_iterations: 10
      max_cost: 80.0
    stages:
      understand: { max_turns: 60 }
      analyze: { max_turns: 40 }
      develop: { max_turns: 150 }
      regression: { max_turns: 40 }
    variables:
      principle: "Follow existing codebase patterns."

  list:
    - id: dev_socket
      title: "Test API Socket"
      tags: [prerequisite]              # replaces default tags
      budget:
        max_iterations: 12              # overrides default (max_cost inherits 80.0)
      variables:
        description: "Add dev socket..."  # extends default variables
        principle: "Zero cost in release." # overrides default principle
```

**Merge semantics:**

| Field | Merge behavior |
|-------|---------------|
| Scalars (`title`, `id`) | Task wins |
| `tags` | Task replaces default |
| `depends_on` | Task replaces default |
| `eval` | Shallow merge (task keys override default keys) |
| `budget` | Shallow merge |
| `stages` | Deep merge (per-stage, task keys override default keys) |
| `variables` | Deep merge (task variables extend default variables; same key = task wins) |

### Dependencies and execution order

Tasks execute in list order by default. `depends_on` modifies this:

- **No `depends_on`** — depends on the previous task in the list (sequential).
- **`depends_on: []`** — no dependencies, can run immediately (parallel-eligible).
- **`depends_on: [a, b]`** — waits for tasks `a` and `b` to pass.

When multiple tasks have their dependencies satisfied, orca can run them in parallel (if `--parallel` is enabled). Otherwise, it follows list order, skipping tasks whose dependencies aren't met.

```yaml
list:
  - id: setup
    depends_on: []

  - id: dev_socket
    depends_on: [setup]

  - id: auto_reload
    depends_on: [dev_socket]

  # These two can run in parallel — both only depend on auto_reload
  - id: ghost_text
    depends_on: [auto_reload]

  - id: bash_execution
    depends_on: [auto_reload]

  # This depends on two tasks — waits for both
  - id: block_autocomplete
    depends_on: [ghost_text, ai_provider]
```

### Tags

Filter tasks at invocation:

```bash
orca run project.orca.yaml --tag prerequisite
orca run project.orca.yaml --tag feature --skip-tag ai
orca run project.orca.yaml --task dev_socket    # single task by ID
orca run project.orca.yaml --from dev_socket    # run all tasks starting from this one
```

---

## Template Variables

Stage prompts use `{variable}` syntax. Variables come from three sources, in priority order (highest wins):

### 1. Per-invocation stage vars

Passed via `stages.<name>.vars` in the task definition. Rare — use for stage-specific overrides.

### 2. Task variables

Everything in the task's `variables` bag, plus these auto-populated fields:

| Variable | Source |
|----------|--------|
| `{task_id}` | `task.id` |
| `{task_title}` | `task.title` |
| `{project_dir}` | Resolved absolute path |
| `{shared_data_dir}` | `{project_dir}/tmp/{name}` |
| `{data_dir}` | `.orca/` |

Variables from the `variables` bag are available by their key name:
```yaml
variables:
  description: "..."        # → {description}
  understand_focus:          # → {understand_focus} (formatted as bullet list)
    - "item 1"
  tests:                     # → {test_list} (see formatting below)
    - name: test_a
      description: "..."
```

Special formatting for `tests` key: objects with `name`/`description` are formatted as a numbered list and exposed as `{test_list}`.

### 3. Orca built-ins

| Variable | Value |
|----------|-------|
| `{orca.iteration}` | Current iteration number |
| `{orca.run_dir}` | Run data directory path |
| `{orca.run_id}` | Timestamp run ID |
| `{orca.total_cost}` | Cumulative cost (USD) |
| `{orca.budget_remaining}` | Remaining budget (USD) |
| `{orca.max_iterations}` | Iteration limit |
| `{orca.last_snapshot}` | Most recent git snapshot hash |
| `{orca.eval_artifact}` | Path to latest eval result artifact |

---

## Workflow

The workflow section defines the stage execution order:

```yaml
workflow:
  setup: <stage>          # run once before all tasks
  pre: [<stages>]         # run once per task, before the loop
  loop: [<stages>]        # the iteration loop (required)
  post: [<stages>]        # run once per task, after the loop passes
```

### Execution model

**`setup`** — Runs once at the start of the build. Skipped if already completed (state.json). Used for project initialization.

**`pre`** — Runs once per task, before the iteration loop. Stages with `condition:` may be skipped.

**`loop`** — Repeats until eval passes or budget exhausted. First stage should be `eval`. After eval, if `all_passed`, the loop exits. Otherwise remaining stages execute in order.

```
while budget_remaining:
    for stage in loop:
        if stage == "eval":
            run eval command
            if all_passed: break loop
        else:
            invoke stage
    check_stuck()
    check_escalation()
```

**`post`** — Runs after the loop passes. Skipped if budget exhausted without passing.

### Patterns

| Pattern | Workflow |
|---------|----------|
| TDD | `setup: scaffold`, `pre: [write_tests]`, `loop: [eval, analyze, develop]`, `post: [regression]` |
| Metric | `setup: setup`, `loop: [eval, analyze, develop]` |
| Maintainer | `setup: setup`, `pre: [understand, write_tests]`, `loop: [eval, analyze, develop]`, `post: [regression]` |
| Simple | `loop: [eval, develop]` |

---

## Stages

Each stage defines how a Claude subagent is invoked.

```yaml
stages:
  develop:
    toolset: all                      # read_only | all | code | bash
    max_turns: 150
    prompt: stages/develop.prompt.txt
    schema: stages/develop.schema.json
    model: opus                       # override model for this stage
    scope:                            # per-stage scope override
      writable: ["src/**"]
    escalation: true                  # check output for escalation object
    supervisor: true                  # invoke supervisor on escalation/stuck
    timeout: 900                      # seconds
    condition: always                 # always | has:<var> | file_missing:<path>
```

### Stage file resolution

If `prompt` is not specified, orca looks for `{stages_dir}/{stage_name}.prompt.txt`. If `schema` is not specified, looks for `{stages_dir}/{stage_name}.schema.json`. Default `stages_dir` is `stages/` relative to `project.orca.yaml`.

Per-task overrides: if `stages/{task_id}/{stage_name}.prompt.txt` exists, it takes priority.

### Conditions

| Condition | Meaning |
|-----------|---------|
| `always` | Always run (default) |
| `has: tests` | Run if `variables.tests` exists and is non-empty |
| `has: understand_focus` | Run if `variables.understand_focus` exists and is non-empty |
| `file_missing: tests/{task_id}.rs` | Run if the file doesn't exist |

---

## Eval

```yaml
eval:
  command: "cargo test --features dev --test {task_id} 2>&1"
  parser: cargo_test
  timeout: 300
  results_file: tmp/{name}/{task_id}_eval.json
```

### Parsers

| Parser | Input | Gate |
|--------|-------|------|
| `cargo_test` | Cargo test stdout | `failed == 0 && total > 0` |
| `pytest` | Pytest stdout | `failed == 0 && errors == 0` |
| `json` | Command outputs JSON to stdout (must include `all_passed`) | `all_passed` field |
| `exit_code` | No parsing | `exit_code == 0` |

All parsers produce JSON with at minimum `{"all_passed": bool}`. The full result is saved as an artifact and optionally written to `results_file` for the analyze stage.

Per-task eval overrides:
```yaml
- id: generator
  eval:
    command: "python -m tests.test_generator --json"
    parser: json
    timeout: 600
```

---

## Git

```yaml
git:
  enabled: true
  snapshot_before: develop
  commit_after: loop
  commit_message: "{name}: {task_id} complete"
```

---

## Scope

```yaml
scope:
  writable: ["src/**", "helix-*/**"]
  readable: ["**"]
```

Enforced via PreToolUse hook (blocks before execution), system prompt injection (agent awareness), and post-hoc detection (logging + auto-revert).

---

## Supervisor

```yaml
supervisor:
  model: opus
  toolset: all
  max_turns: 40
  prompt: stages/supervisor.prompt.txt
  stuck_window: 3
```

Invoked when a develop stage returns an `escalation` object or when `stuck_window` consecutive outputs are identical. Can: fix_test, fix_environment, resolve_requirements, revert, clear_session, escalate_human, continue.

---

## Notifications

```yaml
notifications:
  on_escalation: true
  on_task_complete: true
  on_build_complete: true
  on_budget_warning: 0.8
  channels: []
```

---

## Live Reload

The `orca:` section is re-read at the top of each iteration:

```yaml
orca:
  max_iterations: 10
  max_cost: 80.0
  stage_timeout: 900
```

Edit these while the build is running to change limits without restarting.

---

## Complete Examples

### meta-one-rs (TDD, greenfield Rust library)

```yaml
name: meta-one-rs
project_dir: ../../meta-one/meta-one-rs
model: opus

tasks:
  file: tasks.yaml
  defaults:
    budget:
      max_iterations: 10
      max_cost: 50.0
    stages:
      write_tests: { max_turns: 80 }
      analyze: { max_turns: 40 }
      develop: { max_turns: 100 }

eval:
  command: "cargo test --test {task_id} 2>&1"
  parser: cargo_test

workflow:
  setup: scaffold
  pre:
    - write_tests
  loop:
    - eval
    - analyze
    - develop
  post:
    - regression

stages:
  scaffold:
    toolset: all
    max_turns: 150
  write_tests:
    toolset: code
    condition: "has: tests"
  analyze:
    toolset: read_only
  develop:
    toolset: all
    escalation: true
    supervisor: true
  regression:
    toolset: all
    max_turns: 40

git:
  enabled: true
  snapshot_before: develop
  commit_after: loop

scope:
  writable: ["src/**"]
  readable: ["src/**", "tests/**"]
```

With `tasks.yaml`:
```yaml
- id: cst_parsing
  title: "CST Parsing"
  tags: [core]
  depends_on: []
  variables:
    description: "Parse .rs files into CST..."
    source_files: ["src/project.rs"]
    tests:
      - name: test_parse_single_file
        description: "Parse models.rs, verify tree structure"

- id: module_resolution
  title: "Module Resolution"
  tags: [core]
  depends_on: [cst_parsing]
  variables:
    description: "Resolve mod declarations..."
```

### reason-index-v2 (metric-driven)

```yaml
name: reason-index-v2
project_dir: ../../reason/index-v2
model: opus

tasks:
  file: tasks.yaml
  defaults:
    budget:
      max_iterations: 15
      max_cost: 80.0
    stages:
      analyze: { max_turns: 50 }
      develop: { max_turns: 100 }

eval:
  parser: json

workflow:
  setup: setup
  loop:
    - eval
    - analyze
    - develop

stages:
  setup:
    toolset: all
    max_turns: 100
  analyze:
    toolset: read_only
  develop:
    toolset: all
    escalation: true
    supervisor: true

git:
  enabled: true
  snapshot_before: develop
  commit_after: loop
```

With `tasks.yaml`:
```yaml
- id: generator
  title: "Expression Generator"
  tags: [core]
  depends_on: []
  eval:
    command: "python -m index.v2.test_generator --time-budget 15 --json"
    timeout: 600
  budget:
    max_iterations: 20
    max_cost: 200.0
  variables:
    description: "Generate candidate symbolic expressions..."

- id: fingerprint
  title: "Fingerprint Engine"
  tags: [core]
  depends_on: [generator]
  eval:
    command: "python -m index.v2.test_fingerprint --json"
  variables:
    description: "Compute scale-invariant fingerprints..."
```

### henry (maintainer, existing Rust codebase)

```yaml
name: henry-build
project_dir: ../../henry
model: opus

tasks:
  file: features.yaml
  defaults:
    budget:
      max_iterations: 10
      max_cost: 80.0
    stages:
      understand: { max_turns: 60 }
      write_tests: { max_turns: 80 }
      analyze: { max_turns: 40 }
      develop: { max_turns: 150 }
      regression: { max_turns: 40 }
    variables:
      principle: >
        Your code must fit naturally into the existing Helix codebase.
        Follow existing patterns, naming conventions, and module structure.

eval:
  command: "cargo test --features dev --test {task_id} 2>&1"
  parser: cargo_test

workflow:
  setup: setup
  pre:
    - understand
    - write_tests
  loop:
    - eval
    - analyze
    - develop
  post:
    - regression

stages:
  setup:
    toolset: all
    max_turns: 200
  understand:
    toolset: read_only
    condition: "has: understand_focus"
  write_tests:
    toolset: code
    condition: "file_missing: tests/{task_id}.rs"
  analyze:
    toolset: read_only
  develop:
    toolset: all
    escalation: true
    supervisor: true
  regression:
    toolset: all

git:
  enabled: true
  snapshot_before: develop
  commit_after: loop
  commit_message: "henry: {task_id} complete"

scope:
  writable: ["helix-*/**", "src/**", "meta-scripts/src/bin/**"]
  readable: ["**"]

notifications:
  on_escalation: true
  on_task_complete: true
  on_build_complete: true
  channels:
    - type: webhook
      url: "https://ntfy.sh/henry-build"
```

With `features.yaml`:
```yaml
- id: dev_socket
  title: "Test API Socket"
  tags: [prerequisite]
  depends_on: []
  variables:
    description: >
      Add --features dev mode that exposes a Unix socket
      for querying internal editor state.
    spec_ref: "henry-dev-spec.md — Prerequisite 1"
    understand_focus:
      - "Helix's application lifecycle"
      - "The Editor struct and what state it holds"
    develop_focus:
      - "Add a dev feature flag to Cargo.toml"
      - "Create a socket listener module"
    tests:
      - name: socket_opens
        description: "Socket file exists after startup"
      - name: query_state
        description: "Query returns valid JSON"

- id: auto_reload
  title: "Auto-Reload on File Change"
  tags: [prerequisite]
  depends_on: [dev_socket]
  variables:
    description: >
      Reload open buffers when files change on disk.
    understand_focus:
      - "Helix's existing file watching code"
      - "The Document struct"
    develop_focus:
      - "Extend the existing file watcher"
      - "Reload if unmodified, notify if unsaved changes"
    tests:
      - name: reload_on_change
        description: "External modification reflected in buffer"

- id: ghost_text
  title: "Ghost Text Rendering"
  tags: [ui, core]
  depends_on: [auto_reload]
  budget:
    max_iterations: 12
    max_cost: 100.0
  stages:
    understand: { max_turns: 80 }
  variables:
    description: >
      Render virtual text after the cursor. Tab accepts, Esc dismisses.
    understand_focus:
      - "Helix's rendering pipeline"
      - "How the cursor is positioned and rendered"
    develop_focus:
      - "Add ghost_text field to View"
      - "Render as dimmed characters after cursor"
    tests:
      - name: ghost_text_renders
        description: "Ghost text visible via test API"
      - name: tab_accepts
        description: "Tab inserts ghost text into buffer"
      - name: esc_dismisses
        description: "Esc clears ghost text"

- id: bash_execution
  title: "Inline Bash Execution"
  tags: [feature]
  depends_on: [auto_reload]
  budget:
    max_iterations: 8
    max_cost: 60.0
  variables:
    description: >
      Ctrl+E executes shell commands, inserts stdout into buffer.

- id: block_autocomplete
  title: "Block Autocomplete"
  tags: [feature, ai]
  depends_on: [ghost_text, ai_provider]
  variables:
    description: >
      Sonnet-powered completion on typing pause, shown as ghost text.
```
