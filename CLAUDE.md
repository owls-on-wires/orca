# Orca

Declarative build orchestrator for Claude Code agents. Compiled TypeScript binary — no Python, no runtime dependencies.

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
orca serve                    # start HTTP server (REST + SSE)
orca serve --port 8080        # custom port (default: 7070)
orca monitor <config>         # watch a running build (web UI)
orca status <config>          # one-line status
orca abort <config>           # stop a running build
orca init --template <name>   # scaffold project.orca.yaml
orca validate <config>        # validate config
orca --version                # show version
```

## Safety Rules

### Killing processes by port

**Never use `kill $(lsof -ti:<port>)`** — this kills ALL processes with that port open, including browsers and clients. Use:

```bash
kill $(lsof -ti:<port> -sTCP:LISTEN)
```
