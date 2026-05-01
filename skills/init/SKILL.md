---
name: init
description: Scaffold a new project.orca.yaml from a template. Creates the config file, stages directory with prompt templates, and a starter tasks file.
user-invocable: true
argument-hint: "[--template <name>]"
allowed-tools:
  - Bash
  - Read
  - Write
---

# /orca:init

Scaffold a new orca build configuration.

## Usage

```
/orca:init
/orca:init --template rust-library
/orca:init --template rust-maintainer
/orca:init --template metric-optimizer
```

## Templates

| Template | Pattern | Use case |
|----------|---------|----------|
| `generic` | eval → develop loop | Minimal starting point |
| `rust-library` | scaffold → write_tests → eval → develop → regression | Greenfield Rust library |
| `rust-maintainer` | understand → write_tests → eval → develop → regression | Modifying existing Rust codebase |
| `metric-optimizer` | eval → analyze → develop | Numerical/ML optimization |

## Running the command

```bash
orca init $ARGUMENTS
```

After scaffolding, edit the generated `project.orca.yaml` and tasks file for your project.
