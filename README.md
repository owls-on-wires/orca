# orca (wip)

Declarative build orchestrator for Claude Code agents.

Define tasks in YAML. Orca expands them into an action graph, walks the graph through Claude Code agents and shell commands, and routes outcomes along conditional edges — retrying on failure, escalating to supervisors, and tracking cost and iteration budgets.

![orca dashboard](docs/screenshot.png)

## Key Concepts

- **Actions** — individual units of work (`agent`, `agent-api`, `command`)
- **Edges** — conditional transitions between actions (`pass`, `fail`, `timeout`, `stuck`, `error`, `max_turns`, `cost_exceeded`)
- **Templates** — reusable action chain definitions (e.g. `tdd`: write-tests → develop → eval)
- **Supervisors** — meta-agents that diagnose failures and edit the graph at runtime
- **Projects** — organizational scope with model, nix, git, and file scope config
- **Graph semantics** — diamond dependencies wait for all predecessors before activating
- **Stuck detection** — identical outputs across iterations trigger escalation
