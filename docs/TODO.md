- add a "post" hook for the entire build cycle; this is useful for a command like "cargo build --release"

- add a supervisor "check in" invocation; if a process (like qa) appears hung, the supervisor can check in and take action to remedy it. this happened with a stale Xvfb blocking the display for QA, causing it to hang for over an hour

---

## Service Mode

### 1. Serve command (`src/server.ts`, `src/cli.ts`)
Long-running `orca serve` process. Starts an HTTP server on port 7070. Uses REST for commands and Server-Sent Events (SSE) for live streaming. Clones repos, spawns `orca run` as child processes inside nix environments, watches `.orca/state.json` for each build, and streams state updates to SSE clients. Manages multiple concurrent builds. Add `serve` subcommand to `cli.ts`.

### 2. REST API + SSE (`src/server.ts`)
REST endpoints: `POST /api/builds` (create), `GET /api/builds` (list), `GET /api/builds/:id` (status), `DELETE /api/builds/:id` (stop), `POST /api/builds/:id/intervene` (respond to escalation). SSE streams: `GET /api/builds/:id/events` (per-build), `GET /api/events` (all builds). Events: `state`, `log`, `intervention`. Simpler than WebSockets — curl-testable, auth-middleware friendly, EventSource handles reconnect automatically.

### 3. Git remote operations (`src/git/index.ts`)
Add `clone(repo, branch, targetDir)`, `createBranch(name)`, and `push(remote, branch)` to the existing Git class. These are used by the serve layer: clone on build creation, create a working branch, push on build completion. Existing local operations (snapshot, revert, commit) are unchanged.

### 4. Deploy stage type (`src/engine/loop.ts`, `src/config/schema.ts`)
New command-based stage type for the workflow loop. Like `eval`, it runs a shell command instead of invoking a Claude agent. Adds `command`, `wait_for` (health check command), and `timeout` fields to `StageConfig`. Used to push code changes to a test environment before a QA agent verifies them. Handle in the loop alongside the existing eval stage dispatch.

### 5. Nix environment integration (`src/server.ts`, `src/config/schema.ts`)
When spawning a build, the serve process wraps the command in the appropriate nix environment. Supports both nix flakes (`nix develop`) and legacy nix-shell (`nix-shell`), plus ad-hoc packages (`nix shell -p`). Resolution: explicit `nix.flake` or `nix.packages` in spec takes priority, then auto-detect `flake.nix`, then `shell.nix`/`default.nix`, then no nix. Configurable via `nix` section in project.orca.yaml. Can be disabled with `nix.enable: false`.

### 6. Web dashboard (`src/web/dashboard.html`)
Replace the single-build `monitor.html` with a dashboard. Build list with statuses. Create-build form (repo URL, branch, spec editor with template selection). Live build monitoring (task progress, stage history, cost tracking, log streaming via SSE EventSource). Intervention banner for responding to escalations. Stop button for active builds. Basic operations only — no task entry via UI.

### 7. Spec resolution (`src/server.ts`)
`POST /api/builds` accepts either `spec_path` (use spec from repo) or `spec` (inline YAML written to disk after clone). If neither, looks for `project.orca.yaml` in repo root. `POST /api/builds/:id/intervene` writes `intervention_response.json`; existing polling in `intervention/index.ts` picks it up. All interaction flows through the filesystem — the serve layer translates HTTP requests to file operations.

