---
name: phase-design
description: Guidelines for designing orca build tasks — decomposition, dependencies, budgets, eval strategy, and variable design. Activates when editing project.orca.yaml or task definition files.
user-invocable: false
paths:
  - "**/project.orca.yaml"
  - "**/tasks.yaml"
  - "**/features.yaml"
  - "**/roadmap.yaml"
---

# Task Design Rules

## Decomposition

- **One deliverable per task.** If a description needs "and" — split it into two tasks.
- **Narrow tasks converge faster.** Many small tasks (1-2 iterations each) beat few large ones (10+ iterations each).
- **Isolate hard cases.** A single hard subtask holding up a task is expensive. Give it its own task with its own budget.

## Dependencies

- `depends_on: []` — no dependencies, can start immediately
- `depends_on: [a, b]` — waits for both `a` and `b` to pass
- No `depends_on` field — sequential, depends on the previous task in the list

## Eval Strategy

- **Test-driven** (binary pass/fail) for deterministic work: parsers, transforms, CRUD, data structures, APIs. Use `parser: cargo_test` or `parser: pytest`.
- **Metric-driven** (continuous improvement) for exploratory work: numerical algorithms, ML, search, optimization. Use `parser: json` with custom eval scripts.
- Don't use test-driven for exploratory work (the tests may not know the right answer).
- Don't use metric-driven for deterministic work (slower to converge than pass/fail).

## Budgets

Budget = expected iterations × 2:
- **1-2 expected:** straightforward implementation → budget 4 iterations, $20
- **3-5 expected:** edge cases, cross-module → budget 10 iterations, $50
- **8-15 expected:** algorithmic tuning → budget 20 iterations, $100

## Variables

Every task should have in its `variables`:
- `description` — what this task achieves
- `develop_focus` — specific implementation guidance (as a list)
- Negative constraints — what NOT to do ("Do NOT modify string literals")

For TDD tasks: `tests` array with `{name, description}`. Include at least one negative test.

For maintainer tasks: `understand_focus` list and `principle` string.

## The Analyze Stage

Include a separate `analyze` stage when:
- Eval output is complex (structured metrics, multiple dimensions)
- Diagnosis requires cross-referencing logs, configs, and eval results

Skip `analyze` when:
- Eval is simple pass/fail
- The develop agent can self-diagnose from test output

When skipping, add "First diagnose the failures, then implement the fix" to the develop prompt.
