# Development Phases

## Phase 1: Core engine (port)

- Config loader (YAML + schema validation + defaults merge)
- Eval runner (subprocess + parsers)
- Git operations
- Invoke (Agent SDK integration)
- State persistence (read/write state.json)
- Template variable resolution

This produces a working `engine/` that can invoke Claude, run eval, and persist state — but no CLI, no workflow, no loop yet.

**Tests:** 118 passing across parsers, scope, templates, git, state, eval, supervisor, config.

## Phase 2: Workflow engine (new)

- Task resolution (load file, apply defaults, build DAG)
- Condition evaluation (`has:`, `file_missing:`)
- Workflow executor (setup → pre → loop → post)
- Iteration loop with budget/stuck detection
- Supervisor integration
- Scope enforcement
- Per-task stage override resolution
- Git snapshot/commit/revert within workflow
- Commit message template rendering

This is the core of v2 — the thing that reads `project.orca.yaml` and executes it. Biggest piece of new code.

**Tests:** 40 tests in `engine/loop.test.ts` covering workflow ordering, iteration, budget, stuck detection, escalation, git, conditions, config reload, multi-task, stage overrides, commit templates, and auto-revert.

## Phase 3: CLI + lifecycle (new)

- Command dispatch (run, build, resume, status, validate, init)
- Build runner (foreground)
- Status reader (parse state.json, display summary)
- Config validator (load + schema check, dry run)
- Template initializer (copy from templates/)

**Tests:** 16 tests in `cli.test.ts` covering help, validate, init, status.

## Phase 4: Operational features (new)

### Detached execution (`--detach`)

`orca run project.orca.yaml --detach` daemonizes the build process:

1. Orca re-execs itself as a detached child (`Bun.spawn` with `stdio: "ignore"`, `detached: true`, `unref: true`)
2. Writes PID to `.orca/build.pid`
3. Redirects output to `.orca/build.log`
4. Parent exits immediately, prints PID
5. Child runs the full build, writing `state.json` throughout

The detached process survives the parent Claude session closing. Any later session can read `.orca/state.json` to see what happened.

### Monitor (`orca monitor`)

Separate read-only process that tails `.orca/state.json` and `*.jsonl` logs. Renders the TUI dashboard. Multiple monitors can watch the same build. The monitor doesn't control anything — it just reads files.

File watching via `fs.watch` on the `.orca/runs/{name}/` directory. On change, re-read `state.json` and re-render.

### Resume (built into `orca run`)

`orca run` is smart — if completed tasks exist from a prior run, it resumes from where it left off. Completed tasks are skipped. The iteration counter for the current task resumes from where it stopped. Use `--fresh` to force a clean start ignoring prior state.

`orca resume` is a backwards-compatible alias for `orca run`. `orca build` is an alias for `orca run --fresh`.

### Abort (`orca abort`)

Reads `.orca/build.pid`, sends `SIGTERM`, waits 5 seconds, sends `SIGKILL` if still alive. Removes the PID file. The build's `state.json` will show status "failed" with stop_reason "aborted".

### Notifications (command only)

Single channel type: `command`. Runs an arbitrary shell command with `{message}`, `{event}`, `{task_id}`, `{build_name}` substituted.

```yaml
notifications:
  on_escalation: true
  on_task_complete: true
  on_build_complete: true
  on_budget_warning: 0.8
  channels: []
```

Channels are blank by default — users configure their preferred notification backend via `command` type. For mobile push, use ntfy or a similar service (Pushover, Gotify, etc.):

```yaml
channels:
  - type: command
    run: "curl -s -d '{message}' https://ntfy.sh/myproject-a1b2c3"
```

Install the ntfy app on your phone, subscribe to the topic, and you get free push notifications. Use a unique topic like `projectname-xxxxxx` (6-letter hash) to avoid collisions.

No webhook/email types needed in orca itself — `command` covers everything. The user's script handles the protocol.

### Intervention protocol

File-based mailbox for human-in-the-loop:

1. Orca writes `.orca/intervention.json` (request: task, cause, diagnosis)
2. Fires notification via command channel
3. Pauses that task, polls `.orca/intervention_response.json` every 10s
4. On response file appearing: reads action (continue/skip/abort), removes both files, resumes
5. Claude's `/orca:intervene` skill reads the request, discusses with user, writes the response

### Live config reload

The `orca:` section of `project.orca.yaml` is re-read at the top of each iteration (check `mtime_ns`, parse if changed). Allows changing `max_iterations`, `max_cost`, `max_turns`, `stage_timeout` while the build runs.

### Live task queue

Tasks added to the YAML mid-build are picked up automatically at task boundaries. You can extend a running build without restarting it.

### `--monitor` flag

`orca run project.orca.yaml --monitor` starts the web monitor alongside the build. Equivalent to running `orca monitor` in a separate terminal.

**Tests:** 10 tests in `intervention/index.test.ts`, 13 tests in `notifications/index.test.ts`.

## Phase 5: Display (port + new)

- **Print display** — already implemented. Simple terminal output for foreground builds.
- **TUI display** — Rich-style terminal UI using `ink` (React for CLIs) or raw ANSI. Panels for progress bars, current stage, history table, metrics, color-coded live log. Runs in-process for foreground builds.
- **Monitor TUI** — Same visual layout as TUI display but read-only. Reads from disk (state.json + JSONL logs) instead of receiving events in-process. Used by `orca monitor`.

## Phase 6: Plugin packaging

- `.claude-plugin/plugin.json` manifest
- Skills: `/orca:build` (runs `orca run`), `/orca:init`, `/orca:status`, `/orca:intervene`
- Hooks: `PreToolUse` for scope enforcement
- `bin/orca` compiled binary in the plugin
- Cross-platform builds: `bun build --compile --target` for linux-x64, linux-arm64, darwin-x64, darwin-arm64
