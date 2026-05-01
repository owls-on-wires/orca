# Orca v2 — Direction

Orca becomes a compiled TypeScript binary and Claude Code plugin. Python is eliminated. Builders become YAML specs instead of Python scripts. The build process runs detached, monitored via TUI, with push notifications and a file-based intervention protocol for human-in-the-loop escalation.

---

## Architecture

```
orca (compiled TS binary via bun build --compile)
├── CLI: orca run, orca monitor, orca status, orca init
├── Loop engine (iteration, budget, stuck detection, state persistence)
├── Agent SDK integration (spawn Claude Code subagents)
├── Eval runner (subprocess → JSON parser)
├── Git operations (snapshot, revert, commit)
├── Scope enforcement (PreToolUse hook generation)
├── Supervisor (escalation detection → supervisor subagent)
├── Notification system (email, webhook, command)
├── Intervention protocol (file-based mailbox)
├── TUI monitor (read-only dashboard, runs as separate process)
└── Built-in eval parsers (cargo_test, pytest, json, exit_code)
```

The binary is self-contained. No Python, no Node runtime, no pip, no venv. Drop it in PATH alongside `claude` and it works in any project's environment.

---

## Claude Code Plugin

```
orca-plugin/
  .claude-plugin/
    plugin.json
  skills/
    build/SKILL.md              # /orca:build — write and run a build spec
    init/SKILL.md               # /orca:init — scaffold project.orca.yaml from template
    status/SKILL.md             # /orca:status — read state, report progress
    monitor/SKILL.md            # /orca:monitor — launch TUI in another terminal
    intervene/SKILL.md          # /orca:intervene — handle escalation requests
    phase-design/SKILL.md       # auto-trigger: best practices for phase design
    spec-writing/SKILL.md       # auto-trigger: best practices for spec writing
    test-design/SKILL.md        # auto-trigger: best practices for test design
  agents/
    developer.md                # subagent definition for develop stages
    analyzer.md                 # subagent definition for analyze stages
    supervisor.md               # subagent definition for escalation handling
    understander.md             # subagent definition for codebase study
  hooks/
    hooks.json                  # PreToolUse hooks for scope enforcement
  bin/
    orca                        # the compiled binary
  templates/
    rust-library.yaml           # TDD loop for greenfield Rust libraries
    rust-maintainer.yaml        # understand → TDD loop → regression for existing Rust
    metric-optimizer.yaml       # metric-driven loop for numerical/ML work
    web-api.yaml                # TDD loop with docker-compose eval
    generic.yaml                # minimal template
```

### Installation

```
/plugin install orca@claude-plugins-official
```

Or local development:
```
claude --plugin-dir ./orca-plugin
```

### Invocation

The parent Claude session writes `project.orca.yaml` (or uses a template), then:

```
orca run project.orca.yaml --detach
```

The process runs detached. The parent Claude session is free to do other work. The user can monitor via:

```
orca monitor project.orca.yaml
```

Or ask Claude for status anytime — Claude reads `.orca/state.json`.

---

## How It Runs

### Build Lifecycle

1. `orca run project.orca.yaml` starts
2. Reads `project.orca.yaml` + tasks file (e.g., `features.yaml`)
3. Creates `.orca/` directory, writes initial `state.json`
4. Runs setup phase (if defined)
5. For each phase:
   a. Runs pre-loop stages (understand, write_tests — once each)
   b. Enters iteration loop (eval → analyze → develop → eval)
   c. On pass: runs post-loop stages (regression), commits, advances
   d. On stuck/escalation: invokes supervisor, may pause for human
6. On completion: writes final state, sends notification
7. Exits

### Detached Execution

The orca process must survive the parent Claude session closing. It runs as a true background process (nohup, tmux session, or systemd unit). All state is on disk. Any Claude session can read `.orca/` to understand what happened.

### Monitoring TUI

`orca monitor project.orca.yaml` is a separate read-only process. It tails `state.json` and the JSONL logs, displaying:
- Phase progress (current phase, iteration count, cost)
- Budget bars (iteration and cost)
- Current stage (running, elapsed time)
- Stage history (last N stages with cost and summary)
- Live log (tool use, text output, escalations)
- Intervention banner (prominent, when human input needed)

Multiple monitors can watch the same build. The monitor doesn't control anything.

---

## Notification System

Configured in `project.orca.yaml`:

```yaml
notifications:
  on_escalation: true
  on_build_complete: true
  on_budget_warning: 0.8        # notify at 80% budget
  channels: []
```

Channels are blank by default. Users configure their preferred backend via `command` type:

```yaml
channels:
  - type: command
    run: "curl -s -d '{message}' https://ntfy.sh/myproject-a1b2c3"
```

For mobile push, use ntfy (free, no account needed) or similar services (Pushover, Gotify). Pick a unique topic like `projectname-xxxxxx` (6-letter hash) to avoid collisions. Install the ntfy app on your phone, subscribe to the topic, and get push notifications for escalations, completions, and budget warnings.

---

## Intervention Protocol

When the supervisor escalates to human (`escalate_human`):

1. Orca writes `.orca/intervention.json`:
   ```json
   {
     "timestamp": "2026-04-14T...",
     "phase": "ai_provider",
     "cause": "test_bug",
     "diagnosis": "The mock server test expects /v1/chat but the Anthropic API uses /v1/messages",
     "evidence": "tests/ai_provider.rs:45",
     "suggested_fix": "Change the endpoint in the test assertion",
     "supervisor_reasoning": "The test was generated based on OpenAI conventions, not Anthropic"
   }
   ```
2. Sends notification via configured channels.
3. Pauses that task. Other tasks can continue if parallelized.
4. Polls `.orca/intervention_response.json` every 10 seconds.

The human (via Claude or directly) writes the response:
```json
{
  "action": "continue",
  "note": "Fixed the test endpoint"
}
```

Or:
```json
{
  "action": "skip",
  "note": "Skip this phase for now, come back to it"
}
```

Or:
```json
{
  "action": "abort",
  "note": "Kill the build"
}
```

Orca reads the response, removes both files, and resumes.

### Claude-assisted intervention

The `/orca:intervene` skill auto-triggers when Claude detects an intervention file. Claude reads the diagnosis, discusses with the user, makes the fix (edits code/tests/config), writes the response file. The user doesn't need to write JSON by hand.

---

## Templates

Templates are starter `project.orca.yaml` files for common patterns. Shipped in the plugin's `templates/` directory.

| Template | Pattern | Use Case |
|----------|---------|----------|
| `rust-library.yaml` | scaffold → TDD loop | Building a new Rust library from scratch |
| `rust-maintainer.yaml` | understand → TDD loop → regression | Modifying an existing Rust codebase |
| `metric-optimizer.yaml` | metric loop | Numerical algorithms, ML, search heuristics |
| `web-api.yaml` | scaffold → TDD loop | Web APIs with docker-compose test harness |
| `generic.yaml` | TDD loop | Minimal starting point |

Claude picks the appropriate template when the user describes their goal, fills in the tasks, and runs the build.

---

## Best Practices as Skills

The current `BEST_PRACTICES.md` content becomes auto-triggering skills:

| Skill | Triggers When | Content |
|-------|---------------|---------|
| `phase-design` | Editing project.orca.yaml / features.yaml | One deliverable per phase, budget rules, TDD vs metric |
| `spec-writing` | Writing phase descriptions | Specify what NOT to do, prescribe hard algorithms |
| `test-design` | Writing test definitions | Negative tests, no fragile comparisons, validate against fixtures |

These have `user-invocable: false` and `paths` patterns so they activate automatically without cluttering the command list.

---

## meta-one Integration

meta-one libraries are per-language AST toolkits. They integrate via the project's native package manager, not via orca.

| Language | Package | Install |
|----------|---------|---------|
| Rust | `meta-one-rs` | Cargo workspace member |
| TypeScript | `meta-one-ts` | `devDependencies` in package.json |
| Python | `meta-one-py` | `[dev]` extra in pyproject.toml |
| Go | `meta-one-go` | `go get` dev dependency |

Each project that uses meta-one has:
1. The dependency in its package manager config
2. A `meta-scripts/` directory with an `API.md` reference
3. A `.claude/skills/meta-one/SKILL.md` that tells agents how to use it

Subagents spawned by orca inherit the project directory and its skills, so they automatically have access to meta-one.

---

## Environment Model

Orca is a standalone binary. It doesn't bring language-specific toolchains. The project's own environment (nix flake, Dockerfile, virtualenv) provides those.

```
Project nix flake → Rust/Python/Node/Go toolchain
     +
orca binary → in PATH (via plugin bin/ or manual install)
     +
claude CLI → in PATH (installed separately)
     =
Complete build environment
```

No composite shells. No Python layer. The orca binary and claude CLI are the only external dependencies. Everything else comes from the project.

For Docker-based builds (production/CI):
```dockerfile
FROM nixos/nix
COPY orca /usr/local/bin/orca
# claude CLI installed via npm or direct download
RUN npm install -g @anthropic-ai/claude-code
# Project flake handles the rest
```

---

## Commands

```bash
orca run project.orca.yaml           # run (resumes from prior state if available)
orca run project.orca.yaml --fresh   # ignore prior state, start from scratch
orca run project.orca.yaml --detach  # run in background
orca run project.orca.yaml --monitor # start web monitor alongside the build
orca run project.orca.yaml --from x  # run all tasks starting from this one
orca monitor project.orca.yaml       # watch a running build (web UI)
orca status project.orca.yaml        # one-line status summary
orca status project.orca.yaml --json # machine-readable status
orca abort project.orca.yaml         # stop a running build
orca init --template rust-maintainer  # scaffold project.orca.yaml
```

Aliases: `build` = `run --fresh`, `resume` = `run`
