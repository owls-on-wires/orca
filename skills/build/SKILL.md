---
name: build
description: Run an orca build from a project.orca.yaml file. Executes tasks through the configured workflow (eval → analyze → develop loop) with budget tracking, git snapshots, and supervisor escalation.
user-invocable: true
argument-hint: "<config-file> [--task <id>] [--tag <tag>] [--detach] [--fresh] [--monitor]"
allowed-tools:
  - Bash
  - Read
  - Write
  - Edit
  - Glob
  - Grep
---

# /orca:build

Run an orca build.

## Usage

```
/orca:build project.orca.yaml
/orca:build project.orca.yaml --detach
/orca:build project.orca.yaml --fresh
/orca:build project.orca.yaml --task dev_socket
/orca:build project.orca.yaml --tag prerequisite
/orca:build project.orca.yaml --monitor
```

## How `run` Works

The primary command is `orca run <config>`. It is smart about prior state:
- If completed tasks exist from a prior run, it **resumes** from where it left off.
- If no prior state exists, it starts fresh.

`orca build <config>` is an alias for `orca run --fresh` (ignores prior state, starts all tasks from scratch). `orca resume <config>` is an alias for `orca run`. Both are backwards compatible.

Use `--fresh` to force a clean start even when prior state exists.

## When to Use --detach

**Always use `--detach` for multi-task builds.** The build runs as a background process that survives this session closing. You can close your laptop and come back later.

Use foreground (no `--detach`) only for:
- Single-task debugging (`--task <id>`)
- Quick validation runs
- Watching output in real-time for a short build

## Running

For multi-task builds:
```bash
orca run $ARGUMENTS --detach
```

The build starts detached and prints the PID. Check progress with `/orca:status` anytime. State is persisted to `.orca/runs/` throughout the build.

For single-task debugging:
```bash
orca run $ARGUMENTS --task <id>
```

Use `--monitor` to start the web monitor alongside the build (foreground only, incompatible with `--detach`):
```bash
orca run $ARGUMENTS --monitor
```

## Serve Mode (Remote Builds)

Orca can run as a persistent HTTP server that manages builds via REST API:

```bash
orca serve                              # start on default port 7070
orca serve --port 8080                  # custom port
orca serve --data-dir /path/to/data     # custom data directory
```

Create builds remotely:
```bash
curl -X POST http://localhost:7070/builds \
  -H "Content-Type: application/json" \
  -d '{"repo": "/path/to/repo", "name": "my-build"}'
```

Or with an inline spec:
```bash
curl -X POST http://localhost:7070/builds \
  -H "Content-Type: application/json" \
  -d '{"repo": "git@github.com:org/repo.git", "spec": "name: my-build\n..."}'
```

Monitor via SSE:
```bash
curl -N http://localhost:7070/builds/<id>/events
```

The dashboard is at `http://localhost:7070/`.

## After Starting a Detached Build

Tell the user:
- The build is running in the background
- They can check progress with `/orca:status project.orca.yaml`
- They can watch the TUI with `orca monitor project.orca.yaml` in a terminal
- If using serve mode, they can open the dashboard at `http://localhost:7070/`
- If notifications are configured, they'll get a push when it needs attention or completes
- They can close this session — the build continues

## Tip: Mobile Notifications

If the config doesn't have notifications set up, suggest adding them. Use ntfy or a similar service (Pushover, Gotify) for free mobile push notifications — no account needed:

```yaml
notifications:
  on_escalation: true
  on_build_complete: true
  channels:
    - type: command
      run: "curl -s -d '{message}' https://ntfy.sh/{build-name}-{6-letter-hash}"
```

Generate a unique topic name from the project/build name plus a short random hash (e.g., `henry-build-f3a9c1`) to avoid collisions. Install the ntfy app on your phone and subscribe to the same topic.
