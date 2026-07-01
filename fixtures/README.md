# Fixtures

Evaluation projects for the orca orchestrator. Each fixture is a **product brief,
not a build plan**: you hand orca a natural-language goal and a bare, bootable
scaffold, and orca's job is to turn that into working software. Grading is done
by an LLM judge against a hidden rubric of observable behaviors.

## Philosophy: prompt in, software out

The old fixtures shipped a solved codebase plus a hand-authored task/action DAG
(`project.orca.yaml`) that told orca exactly what to build and in what order.
These have been reworked into a **prompt-in / software-out** format. Each fixture
now provides:

- **`PROMPT.md`** — the only thing the builder sees. A product-owner-voice
  description of *what* is wanted, deliberately written at a chosen level of
  specificity. It describes desired capabilities and qualities in product terms
  and prescribes **no HOW**: no endpoints, no routes/verbs, no schema, no field
  names, no file layout, no task breakdown. The builder owns every technical
  decision.
- **`RUBRIC.md`** — **hidden from the builder; for the LLM judge only.** A
  contract-agnostic acceptance checklist. Every capability is graded at three
  levels of observable behavior — **PRESENT** (it exists at all), **FUNCTIONAL**
  (a realistic scenario actually works, proven by executing the software, not by
  reading source), and **ROBUST** (bad input and edge cases are handled without
  crashing or corrupting data). It also carries an *Overall Quality & Usability*
  section and a *Bug-Hunt Focus* that a skeptic uses to try to break the build.
  The rubric names example fields/status codes only as illustrations, never as
  required spellings.
- **A minimal, bootable scaffold** — just enough to `install` and start green:
  `package.json`, `tsconfig.json`, a `.gitignore`, and an entry point that does
  nothing but answer a health check (for services) or export an empty module (for
  the library). No feature code, no feature tests. The scaffold boots to a
  passing/`200` baseline so the builder starts from working ground, not a broken
  one.
- **Optional domain context** — where a fixture needs background beyond the
  prompt (e.g. `EPICS.md` for link-board), it ships as read-only context. It
  frames the domain but is not a contract.

A **`reference/`** folder (a known-good solution to diff the build against) is
**deferred** — none of the fixtures ship one yet.

## Grading

The judge never reads the builder's source to award FUNCTIONAL/ROBUST credit. It
discovers the real contract the builder chose by exercising the running software
(curling a live server, importing the library, running its tests), maps the
observed behavior onto the rubric's capabilities, and grades each at
PRESENT/FUNCTIONAL/ROBUST. Because rubrics are contract-agnostic, two builders
with completely different APIs can both score full marks.

## Prompt-specificity ladder

The fixtures span a deliberate ladder from a tightly-specified brief to an
open-ended one, so orca is exercised across the range from "fill in the obvious"
to "make real product decisions."

| Fixture | Domain | Prompt specificity | Capabilities |
|---|---|---|---|
| [calculator](#calculator) | TypeScript/Bun math library (no server) | Concrete | 6 |
| [todo-api](#todo-api) | Bun + SQLite REST API | Moderate | 10 |
| [bookmark-api](#bookmark-api) | Bun + SQLite REST API | Moderate-low | 20 |
| [link-board](#link-board) | Bun + SQLite REST API | Low | 6 |

## calculator

A four-operation arithmetic library (add, subtract, multiply, divide) where
divide-by-zero must signal an error rather than leak `Infinity`/`NaN`, shipped
with passing unit tests. The **concrete** end of the ladder: the prompt names the
four operations and the divide-by-zero requirement, but still leaves signatures,
module layout, and the test list to the builder. Simplest fixture — good for
smoke-testing the executor.

- **Scaffold**: `package.json`, `tsconfig.json`, empty `src/index.ts`, a
  placeholder `test/scaffold.test.ts` (so an empty suite boots green), `.gitignore`,
  `shell.nix`.
- **Boots to**: `bun install` then `bun test` → 1 pass, exit 0.

## todo-api

A REST API for a todo list: full CRUD over todos (title + done flag + timestamp),
durable persistence, plus completion filtering, case-insensitive title search,
and pagination with a total count — with input validation and sane error codes.
**Moderate** specificity: the prompt names the CRUD lifecycle, the fields as
product concepts, and the list-refinement features, but prescribes no paths,
verbs, schema, or response envelope. The bug-hunt targets classic regressions
(completion flag not persisting, delete-of-missing, empty-title acceptance,
malformed bodies).

- **Scaffold**: `package.json`, `tsconfig.json`, a health-only `src/server.ts`
  (reads `PORT`, defaults to 37001), `.gitignore`, `shell.nix`.
- **Boots to**: `bun install`, `bun run src/server.ts`, `GET /health` → `{"status":"ok"}`.

## bookmark-api

A personal bookmark manager: save/read/list/update/delete links (URL-validated,
de-duplicated, auto-titled), keyword search, pagination, multi-field sorting,
tagging + tag filtering + tag overview, named collections, favorites,
archive/restore, notes, click/visit tracking, bulk import with partial success,
export that round-trips, and a stats dashboard. **Moderate-low** specificity: the
prompt describes a broad feature surface in product language while owning zero
technical decisions — the builder chooses resource layout, storage, and every
wire shape. The largest capability set (20).

- **Scaffold**: `package.json`, `tsconfig.json`, a health-only `src/server.ts`
  (reads `PORT`, defaults to 37002), `.gitignore`.
- **Boots to**: `bun install`, `bun run src/server.ts`, `GET /health` → `{"status":"ok"}`.

## link-board

A Hacker-News-style link-sharing community: members & auth, link
submission/browsing, one-per-member voting driving multiple rankings, threaded
comments with voting and soft-delete, public profiles with karma/reputation, and
moderation + search. The **low** end of the ladder: the prompt is pure product
vision ("build me a link-sharing community — think Hacker News") with no
endpoints, schema, or task list; the builder must decompose and design the whole
thing. Ships `EPICS.md` as read-only domain context.

- **Scaffold**: `package.json`, `tsconfig.json`, a health-only `src/server.ts`
  (reads `PORT`, defaults to 37003), `EPICS.md`, `.gitignore`.
- **Boots to**: `bun install`, `bun run src/server.ts`, `GET /health` → `{"status":"ok"}`.
</content>
</invoke>
