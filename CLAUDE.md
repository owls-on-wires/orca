# Orca

Declarative build orchestrator for Claude Code agents. Compiled TypeScript binary — no Python, no runtime dependencies.

## Knowledge Base

Project knowledge — goals, principles, requirements, decisions, and open design
questions — lives in `kbase/`. **Before building or redesigning any subsystem,
consult it.** Start at `kbase/INDEX.md` (the manifest) and `kbase/README.md` (how
it's organized).

- `kbase/principles/` — non-negotiable invariants. Respect them.
- `kbase/decisions/` — settled choices (ADRs). Don't re-litigate these.
- `kbase/open-questions/` — unresolved forks. Don't guess in these areas; surface them.
- `kbase/specs/` & `kbase/architecture/` — what to build, and how it works today.
- `kbase/vision/` & `kbase/explorations/` — direction and brainstorms; not authoritative, don't build on them blindly.

Each doc's frontmatter `status` says how much to trust it (`authoritative` >
`proposed` > `exploratory`). When you change code, update the matching
`kbase/architecture/` doc; when you resolve an open question, add an ADR.

## Development

```bash
nix-shell              # enter dev environment (or use direnv)
bun install            # install dependencies
bun run dev -- <args>  # run from source
bun test               # run tests
bun run build          # compile to binary (bin/orca)
```

## Temporary Files

All temporary files (screenshots, test outputs) go in the `tmp/` folder. This directory is gitignored.

## Commands

```bash
orca run <config>             # run a build (resumes from prior state)
orca run <config> --fresh     # ignore prior state, start from scratch
orca run <config> --detach    # run in background
orca run <config> --monitor   # start web monitor alongside build
orca run <config> --task <id> # run a single task
orca run <config> --from <id> # run all tasks starting from this one
orca run <config> --tag <tag> # filter tasks by tag
orca run <config> --skip-tag <tag>  # exclude tasks with tag
orca serve                    # start HTTP server (REST + SSE)
orca serve --port 8080        # custom port (default: 7070)
orca serve --data-dir <dir>   # custom data directory
orca monitor <config>         # watch a running build (web UI)
orca status <config>          # one-line status
orca status <config> --json   # machine-readable output
orca abort <config>           # stop a running build
orca init --template <name>   # scaffold project.orca.yaml
orca validate <config>        # validate config
orca --version                # show version
```

Aliases: `build` = `run --fresh`, `resume` = `run`

## Safety Rules

### Killing processes by port

**Never use `kill $(lsof -ti:<port>)`** — this kills ALL processes with that port open, including browsers and clients. Use:

```bash
kill $(lsof -ti:<port> -sTCP:LISTEN)
```
