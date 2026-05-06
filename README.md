# orca

Declarative build orchestrator for Claude Code agents. Compiled TypeScript binary — no Python, no runtime dependencies.

## Development

```bash
bun install
bun run dev -- run project.orca.yaml      # run from source
bun test                                   # run tests
bun run build                              # compile to binary
```

## Project Structure

```
src/
  cli.ts                    Entry point (command dispatch)
  version.ts                Version constant
  server.ts                 HTTP server (REST + SSE for serve mode)
  nix.ts                    Nix environment detection and wrapping
  config/
    schema.ts               TypeScript types for project.orca.yaml
    loader.ts               YAML loading, validation, path resolution
    tasks.ts                Task DAG resolution, dependency checking, filtering
    prompts.ts              Prompt/schema resolution (3-tier fallback)
  engine/
    loop.ts                 Core iteration loop (the state machine)
    context.ts              Build context setup
    eval.ts                 Eval runner (subprocess + parser dispatch)
    invoke.ts               Claude Agent SDK invocation
    supervisor.ts           Escalation detection + supervisor agent
  git/
    index.ts                Git operations (snapshot, revert, commit)
  scope/
    index.ts                File scope enforcement (check, system prompt)
    matcher.ts              Glob pattern matching with ** support
  display/
    types.ts                Display event interface
    print.ts                Simple terminal output
    tui.ts                  Rich TUI monitor (read-only)
    web.ts                  Web monitor (browser-based)
    monitor.ts              Standalone read-only build monitor
  notifications/
    index.ts                Command-based notifications
  intervention/
    index.ts                File-based human-in-the-loop protocol
  state/
    index.ts                State persistence (state.json, artifacts)
  templates/
    index.ts                Template variable resolution + formatting
  parsers/
    cargo.ts                Cargo test output parser
    pytest.ts               Pytest output parser
    json.ts                 JSON passthrough parser
    exit_code.ts            Exit code parser
  prompts/
    system.prompt.txt       System prompt (included in every invocation)
    *.prompt.txt            Built-in stage prompts
    *.schema.json           Built-in stage output schemas
  web/
    dashboard.html          Serve mode web dashboard
    monitor.html            Build monitor web UI
schemas/
  project.orca.schema.json  JSON Schema for project.orca.yaml
  tasks.schema.json         JSON Schema for external tasks files
templates/
  generic.yaml              Minimal starter template
  rust-library.yaml         TDD loop for greenfield Rust
  rust-maintainer.yaml      Understand + TDD + regression for existing Rust
  metric-optimizer.yaml     Metric-driven loop
docs/
  BUILD_SPEC.md             Full project.orca.yaml specification
  DIRECTION.md              Architecture and vision
```

## Commands

```bash
orca run <config>             # run a build (resumes from prior state if available)
orca run <config> --fresh     # ignore prior state, start from scratch
orca run <config> --detach    # run detached in background
orca run <config> --monitor   # start web monitor alongside the build
orca run <config> --task <id> # run a single task
orca run <config> --from <id> # run all tasks starting from this one
orca run <config> --tag <tag> # filter tasks by tag
orca run <config> --skip-tag <tag>  # exclude tasks with tag
orca serve                    # start HTTP server (REST + SSE)
orca serve --port 8080        # custom port (default: 7070)
orca serve --data-dir <dir>   # custom data directory
orca monitor <config>         # watch a running build (web UI)
orca status <config>          # one-line status
orca status <config> --json   # machine-readable status
orca abort <config>           # stop a running build
orca init --template <name>   # scaffold project.orca.yaml
orca validate <config>        # validate config without running
orca --version                # show version
```

Aliases: `build` = `run --fresh`, `resume` = `run`
