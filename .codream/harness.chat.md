
## user
Familiarize yourself with the project.

## agent

Now I have a solid understanding of the project. Here's a summary:

## Orca — Declarative Build Orchestrator

**What it does:** Orchestrates multi-step build pipelines for Claude Code agents. You define tasks in YAML configs, and Orca expands them into a directed action graph, then executes actions serially with dependency tracking.

**Architecture:**

- **Monorepo** with two packages: `packages/server` (core engine) and `packages/web` (monitoring UI)
- **Runtime:** Bun + TypeScript, compiles to a standalone binary at `bin/orca`
- **Storage:** SQLite (WAL mode) with tables for `projects`, `actions`, `edges`, and `history`

**Core concepts:**

- **Config** (`project.orca.yaml`): Declares tasks with action sequences (e.g. `[develop, eval]`), dependencies, tags, and type defaults. `config.ts` expands this YAML into the action graph in the DB.
- **Actions**: Two types — `agent` (Claude Code agent invocation) and `command` (shell command). Each has a status lifecycle: `pending → running → completed/failed`.
- **Edges**: Directed connections between actions with conditions (`pass`, `fail`, `max_turns`, `timeout`, `cost_exceeded`, `stuck`, `error`). Drive the graph traversal.
- **Executor** (`executor.ts`): Serial scheduler that picks the next ready action, runs it via `action-runner.ts`, classifies the result, and follows edges.
- **Action Runner** (`action-runner.ts`): Executes individual actions — agent actions use the Claude Agent SDK (`invokeSimple`), command actions run shell commands. Supports nix environments, predecessor output injection, and structured output schemas.
- **Supervisor** (`supervisor.ts`): Handles failure recovery by building prompts with graph state and allowing graph mutations (add/remove actions, update params, add/remove edges).
- **DB** (`db.ts`): SQLite wrapper with typed CRUD for actions, edges, projects, and history.
- **Server** (`server.ts`): HTTP REST API + SSE for real-time monitoring on port 7072.
- **Web UI**: Webpack + Tailwind frontend for monitoring builds.

**Two versions coexist:** A v1 engine (`src/engine/`, `src/cli.ts`) and the newer v2 (`src/v2/`), with v2 being the active development focus.

## user
Let's consider how we can write a small script that will self-build orca. The idea is that we invoke claude from the command line in a loop: first, we establish a goal: for example, when orca is run, it should successfully complete the process of building all of the fixtures. the loop is basically: invoke claude code to make changes, then run a series of commands that essentially treat the entire fixtures folder as a test suite, running the orca program with existing pipelines. then, after it's finished, we run the claude agent again, which can verify results, fix issues, and generally be self-directed to reach our goal. the agent can produce output to decide when it's complete. thoughts on specific implementation?

## agent

Good, now I have a clear picture. Let me look at the v2 CLI to understand how orca is invoked.Here's my concrete proposal:

## Self-Build Loop Design

**Script:** `self-build/loop.sh` — a simple bash loop that alternates between two phases.

### The two phases

1. **Fix phase** — invoke `claude` CLI with a prompt that includes:
   - The goal (all fixtures build successfully)
   - Results from the last test phase (or "first run" context)
   - Instructions to make code changes, then output a structured verdict (JSON to stdout) indicating `done` or `continue`

2. **Test phase** — a deterministic bash script that:
   - Builds orca from source (`bun run build`)
   - For each fixture, resets it to a clean copy, imports the config, runs the executor, and captures pass/fail + logs
   - Writes a structured report to a known path (`tmp/self-build/report.json`)

### Key implementation details

**Claude invocation** uses `claude -p` (print mode, non-interactive) with `--output-format json` so we can parse the result programmatically. The prompt is assembled from a template file + the test report. Something like:

```bash
claude -p \
  --allowedTools "Bash,Read,Write,Edit,Glob,Grep" \
  "$(cat self-build/prompt.md)

## Last test results
$(cat tmp/self-build/report.json)"
```

**Test harness** (`self-build/test-fixtures.sh`) is the key piece. It can't use the HTTP API flow (too heavy) — instead it should use the v2 CLI directly:

```bash
for fixture in fixtures/*/; do
  # reset to tmp/
  work_dir=$(bash scripts/fixture-reset.sh "$name")
  # run orca against it
  bun run packages/server/src/v2/cli.ts run "$work_dir/project.orca.yaml" --fresh 2>&1 | tee "tmp/self-build/logs/$name.log"
  # capture exit code
done
```

**Termination** — the loop exits when either:
- Claude outputs `{"done": true}` (all fixtures pass and it's satisfied)
- A max iteration count is reached (safety valve, e.g. 10)

**Report format** — the test harness writes something like:
```json
{
  "iteration": 3,
  "fixtures": {
    "calculator": {"status": "pass", "actions": 6, "completed": 6, "failed": 0},
    "bookmark-api": {"status": "fail", "actions": 51, "completed": 38, "failed": 2, "error_log": "...truncated..."}
  }
}
```

### What makes this work vs. not work

The critical question is whether the fixtures actually exercise orca meaningfully as a test suite. Looking at the fixtures:

- **calculator** — 3 tasks, simple develop+eval loops, depends_on chains. Tests basic graph execution.
- **bookmark-api** — 17 tasks, complex dependency DAG, 3 templates (setup/tdd/tdd-qa), QA stages that start servers. Tests the full feature set.
- **link-board** and **todo-api** — additional coverage.

The fixtures are good coverage. But running them with real Claude agents would be expensive and slow. Two options:

1. **Dry-run mode** — add a `--dry-run` flag to orca that simulates agent actions (returns canned pass/fail) and runs command actions for real. This tests the orchestration machinery without API costs.
2. **Command-only** — create a fixture that uses only `command` type actions (shell scripts that exit 0/1). Pure orchestration test, zero agent cost.

I'd recommend option 2 for the self-build loop — create a synthetic fixture in `self-build/fixtures/` that uses only command actions but exercises the full graph machinery (edges, conditions, depends_on, templates, retries, tags). The existing fixtures with agents are for real integration testing.

Want me to build this out? I'd start with:
1. The test-only fixture with command actions
2. `self-build/test-fixtures.sh` — the deterministic test harness  
3. `self-build/prompt.md` — the agent prompt template
4. `self-build/loop.sh` — the outer loop
