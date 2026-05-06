---
name: status
description: Check the status of an orca build. Reads .orca/runs/{name}/{timestamp}/state.json and reports task progress, cost, iteration counts, and any pending interventions.
user-invocable: true
argument-hint: "<config-file> [--json]"
allowed-tools:
  - Bash
  - Read
---

# /orca:status

Check build status.

## Usage

```
/orca:status project.orca.yaml
/orca:status project.orca.yaml --json
```

## What this shows

- Build status (running, completed, failed, paused)
- Per-task progress (iteration count, cost, pass/fail)
- Total cost across all tasks
- Any pending intervention requests

## How it works

### Local builds (CLI)

Reads `.orca/runs/{name}/{timestamp}/state.json` from the project directory. This file is updated by the build process after every stage.

```bash
orca status $ARGUMENTS
```

If `--json` is passed, outputs machine-readable JSON instead of formatted text.

### Remote builds (serve mode)

If orca is running in serve mode, query the REST API:

```bash
# List all builds
curl -sf http://localhost:7070/builds | jq .

# Get specific build status
curl -sf http://localhost:7070/builds/<id> | jq .

# Stream live updates via SSE
curl -sf -N http://localhost:7070/builds/<id>/events
```

If no state exists yet, reports that no build has been run.
