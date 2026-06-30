---
id: vision-features
type: vision
status: proposed
updated: 2026-06-30
applies_to: [settings, executor, agent-runtime, observability]
related: [vision-thesis, vision-control-hierarchy]
---

# Target features

Aspirational feature set (migrated from the former `goal-features.md`).
**Status: proposed** — direction, not committed specs. Promote an item to
`kbase/specs/` with acceptance criteria once it is decided.

- **Declarative settings.** A `.orca` folder holds the harness "settings" — almost
  a Nix-like config for the harness. Global and project-scoped, with global
  overrides.
- **Circuit architecture.** The build uses the circuit / dataflow-graph model (see
  [[vision-control-hierarchy]]).
- **Automatic model selection.** Tasks in a circuit get a model chosen
  automatically per task.
- **Local- and cloud-native agent.** Opinionated default tool choices and
  environment-dependent behavior: the agent decides (considering user preferences),
  for a given task, whether to run locally or on a VPS, and which tools to use
  (Docker, ngrok, …). See [[vision-cloud-native-execution]] for how placement is
  decided.
- **Runtime data collection.** All runtime activity / harness state is recorded so
  it can be analyzed.
- **Automatic reflection.** In a project, the agent routinely analyzes its
  collected data and prompts the user with workflow improvements (e.g. "you run
  this action constantly — shall I write a script for it?").
