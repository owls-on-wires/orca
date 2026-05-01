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
  config/
    schema.ts               TypeScript types for project.orca.yaml
    loader.ts               YAML loading, validation, path resolution
    tasks.ts                Task DAG resolution, dependency checking, filtering
  engine/
    loop.ts                 Core iteration loop (the state machine)
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
  notifications/
    index.ts                Webhook, email, command notifications
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
orca run <config> --from <id> # run all tasks starting from this one
orca monitor <config>         # watch a running build (web UI)
orca status <config>          # one-line status
orca status <config> --json   # machine-readable status
orca abort <config>           # stop a running build
orca init --template <name>   # scaffold project.orca.yaml
orca validate <config>        # validate config without running
```

Aliases: `build` = `run --fresh`, `resume` = `run`
