# Fixtures

Test projects for validating the orca orchestrator. Ordered by complexity.

## calculator

Bun math library with 3 bugs to fix. Simplest fixture — good for smoke testing the executor.

| | |
|---|---|
| **Type** | Library (no server) |
| **Tasks** | 3 |
| **Actions** | 6 (develop + eval per task) |
| **Stages** | develop → eval |
| **Testing** | Unit tests (bun test) |
| **Templates** | bugfix, feature |
| **Graph** | Diamond — 2 parallel bugfixes → 1 feature |
| **Starting state** | Broken code, passing tests define the fix |

## todo-api

Bun REST API with bugs to fix and features to add. Tests the full TDD retry loop — eval failures route back to develop.

| | |
|---|---|
| **Type** | REST API (Bun.serve, SQLite) |
| **Tasks** | 8 |
| **Actions** | 16 (develop + eval per task) |
| **Stages** | develop → eval |
| **Testing** | Unit + integration tests (bun test) |
| **Templates** | bugfix, feature |
| **Graph** | 4-phase diamond DAG — parallel bugfixes → endpoints → features → polish |
| **Starting state** | Buggy code with pre-written tests |

## bookmark-api

Full REST API built from scratch via TDD. Agents write tests first, then implement. Agentic QA tests live endpoints with curl. Most complex static fixture — 17 tasks across 8 phases.

| | |
|---|---|
| **Type** | REST API (Bun.serve, SQLite) |
| **Tasks** | 17 |
| **Actions** | 57 (write-tests + develop + eval [+ qa] per task) |
| **Stages** | write-tests → develop → eval → qa |
| **Testing** | Unit tests (bun test), agentic integration QA (curl against live server) |
| **Templates** | setup, tdd, tdd-qa |
| **Graph** | 8-phase DAG with diamonds — env setup → schema → data layer → API → features → advanced → analytics → final |
| **Starting state** | Bare scaffold — only package.json, tsconfig, SPEC.md, and a /health endpoint |

**Features built**: CRUD, tags, favorites, search, sorting, pagination, collections, archive, URL validation, bulk import/export, click tracking, stats dashboard, notes

## link-board

Link-sharing platform (like Hacker News) built entirely via **dynamic tasking**. The graph starts with a single planner action — no pre-defined tasks. The planner agent reads an epic list, decomposes each epic into TDD tasks, and creates them on the fly via the orca HTTP API.

| | |
|---|---|
| **Type** | REST API (Bun.serve, SQLite) |
| **Tasks** | ~15-20 (dynamically created) |
| **Actions** | ~55-65 (dynamically created) |
| **Stages** | write-tests → develop → eval (created by planner) |
| **Testing** | Unit tests (bun test), created by agents |
| **Templates** | None — planner creates raw actions via POST /actions |
| **Graph** | Grows dynamically — planner → [epic tasks] → planner → [epic tasks] → ... |
| **Starting state** | Bare scaffold + EPICS.md + ORCA-API.yaml. Single planner action. |

**Epics**: Users & Auth, Links (submit/vote/sort), Threaded Comments, Profiles & Karma, Moderation & Search

**Key difference**: No SPEC.md, no pre-defined tasks, no templates used at runtime. The planner agent is the architect — it decides the schema, endpoints, task decomposition, and test strategy. The orca API schema (ORCA-API.yaml) tells the planner how to manipulate the graph.

---

## Planned

Future fixtures to expand coverage:

- **fullstack-app** — Frontend + backend, multi-process (API server + dev server), browser-based QA via Playwright
- **microservices** — Multi-container (docker-compose), inter-service communication, agent-managed infrastructure
- **monorepo** — Workspace with shared packages, cross-package dependencies, coordinated releases
- **self-improvement** — Open-ended dynamic tasking; system suggests improvements to itself and implements them
