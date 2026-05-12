# Fixtures

Test projects for validating the orca orchestrator. Ordered by complexity.

Fixtures are immutable source files. `scripts/fixture-run.sh` copies them to `tmp/fixtures/{name}-{timestamp}/`, inits a git repo, and imports into the running orca server.

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

Full REST API built from scratch via TDD. Agents write tests first, then implement. Agentic QA tests live endpoints with curl.

| | |
|---|---|
| **Type** | REST API (Bun.serve, SQLite) |
| **Tasks** | 17 |
| **Actions** | ~60 (write-tests + develop + eval + commit [+ qa] per task) |
| **Stages** | write-tests → develop → eval → commit → qa |
| **Testing** | Unit tests (bun test), agentic integration QA (curl against live server) |
| **Templates** | setup, tdd, tdd-qa |
| **Graph** | 8-phase DAG with diamonds — env setup → schema → data layer → API → features → advanced → analytics → final |
| **Starting state** | Bare scaffold — package.json, tsconfig, SPEC.md, /health endpoint |

**Features built**: CRUD, tags, favorites, search, sorting, pagination, collections, archive, URL validation, bulk import/export, click tracking, stats dashboard, notes

## link-board

Link-sharing platform (like Hacker News) built via **dynamic tasking**. The graph starts with a single planner action and a supervisor. The planner reads an epic list, decomposes each epic into TDD task groups via `POST /groups`, adds sprint QA after each epic, and chains the next planner. The supervisor catches unhandled failures.

| | |
|---|---|
| **Type** | REST API (Bun.serve, SQLite) |
| **Tasks** | ~15-20 (dynamically created) |
| **Actions** | ~50 (dynamically created) |
| **Stages** | write-tests → develop → eval → commit [→ qa] |
| **Testing** | Unit tests (bun test), agentic sprint QA (curl against live server) |
| **Templates** | planner, tdd, tdd-qa, dev, sprint-qa, notify, supervisor |
| **Graph** | Grows dynamically — planner → [tasks] → notify → sprint-qa → planner → ... |
| **Starting state** | Bare scaffold — package.json, tsconfig, EPICS.md, /health endpoint |

**Epics**: Users & Auth, Links (submit/vote/sort), Threaded Comments, Profiles & Karma, Moderation & Search

**Key features**: Dynamic task creation via `POST /groups`, sprint QA between epics (pass/fail both chain to next planner), global fallback supervisor, ntfy push notifications after each sprint, git commits after each eval pass, planner prompt lives in template (inherits automatically), agents read `/llms.txt` for API self-discovery.
