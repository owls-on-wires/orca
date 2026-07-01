---
id: spec-eval-harness
type: spec
status: proposed
updated: 2026-07-01
applies_to: [fixtures, cli, l3-agent, executor, eval]
related: [vision-thesis, spec-model-provider, decision-0005-layer-a-direct-provider-sdks, architecture-current-state]
---

# Spec: fixture eval harness (prompt in, software out)

How we test orca end-to-end: hand it a **prompt** and a bare scaffold, let it build
the whole thing (circuit + software) itself, then grade the result. The P1–P6 unit
gates test the *parts*; this tests the *whole* — it is the real proof orca works,
and the first run already earned its keep by surfacing the `project_id` bug
(`applyDelta` add_action dropped the column; see [[architecture-current-state]]).

## Fixture structure (already in `fixtures/`)

Each fixture is a **product brief, not a build plan**:

- `PROMPT.md` — the ONLY builder input. Product-owner voice; describes *what*, never
  *how* (no endpoints, schema, or task breakdown). Specificity ladder: calculator
  (concrete) → todo-api → bookmark-api → link-board (low).
- `RUBRIC.md` — hidden from the builder; for the judge. A **contract-agnostic**
  capability checklist graded at **PRESENT / FUNCTIONAL / ROBUST**, plus quality and
  bug-hunt sections. Behavioral properties, not endpoint spellings.
- `scaffold/` — a minimal bootable start (the only thing copied into the build
  workspace). Its job is to pin **how to boot/test** (runtime + a start command),
  not the features.
- `reference/` — deferred: known-good/known-broken builds used to *calibrate the
  judge* (grade the grader).

## Pipeline

```
for (fixture × model):
  1. SETUP        fresh isolated workspace = copy scaffold/, git init, install deps (in a container)
  2. orca build   run-spec.json   -> prompt in -> orca reifies a circuit -> software out -> build-report.json
  3. JUDGE        headless claude -p -> boots + probes the software vs RUBRIC.md -> scored-rubric.json
  4. SCORE        append a row (fixture x model -> coverage%/functional%/quality, cost, circuit metrics)
teardown -> aggregate -> suite scorecard grid
```

The build and judge are **separate, spec-driven steps** on purpose: re-judge without
rebuilding, mix build/judge models, and keep two inspectable artifacts
(build-report + scored-rubric).

## Step 2 — `orca build <run-spec.json>`

A one-shot CLI wrapping the manual flow (create a project → feed the prompt to the
L3 agent → run the executor to a terminal state → emit a report). Named `build` to
avoid overloading the existing `orca run <yaml-config>`.

```json
{
  "prompt": "fixtures/todo-api/PROMPT.md",
  "workspace": "runs/todo-api-h1/workspace",
  "model": "haiku",
  "scope": { "writable": ["**"], "readable": ["**"] },
  "budget": { "max_cost_usd": 3.0, "wall_timeout_s": 1800, "max_iterations": 8, "max_graph_size": 40 }
}
```

`build-report.json` captures cost/time **and the circuit orca built** (the
orca-quality signal, distinct from software quality):

```json
{ "status": "completed", "halt_reason": null, "cost_usd": 0.42, "duration_s": 380,
  "model": "anthropic/claude-haiku-4-5-...",
  "circuit": { "actions": 3, "has_loop": true, "iterations": 2, "rejected_mutations": 5, "supervisor_fires": 0 } }
```

`budget` maps onto the P4 circuit-breaker + per-action caps (the cost rail).
`halt_reason` ∈ {null, budget, breaker, timeout, stuck}.

## Step 3 — the judge is a **headless Claude Code invocation** (for now)

Decision: do **not** reuse orca as the judge yet. Grade with a headless `claude -p`
call. Rationale: it keeps the grader **independent** of the system under test (orca
must not grade its own work), it is simple, and Claude Code already has the tools
(bash/read/curl) to boot the software and probe it. Orca-as-judge (dogfooding) is a
possible future, tracked as an open option, not the current path.

**Invocation** (run with `cwd` = the built workspace so it can boot + probe). Use
**`--json-schema`** to *guarantee* schema-conforming output — do not rely on prompt
discipline (an early run without it prepended a sentence of prose and broke `jq`):

```bash
cd "$WORKSPACE"
claude -p "$(cat judge-prompt.md)" \
  --model "$JUDGE_MODEL" \
  --dangerously-skip-permissions \
  --output-format json \
  --json-schema "$(cat scored-rubric.schema.json)" \
  > judge-raw.json
# schema-conforming object lands in .structured_output (NOT .result):
jq '.structured_output' judge-raw.json > scored-rubric.json
```

**Model decoupling:** build cheap (**haiku**), **judge with a stronger model** —
grading reliability matters more than build cost. Separate `model` fields.

**The judge prompt** (`judge-prompt.md`, assembled per run) instructs Claude to:
1. Read `RUBRIC.md` and the boot info; **discover the entry** — the builder chose the
   layout, so find it from `package.json`/`src/` rather than assuming `src/server.ts`.
2. **Discover** the API the builder actually chose (route list / `/llms.txt` / probe) —
   the contract is unknown by design.
3. Grade each capability at **PRESENT / FUNCTIONAL / ROBUST**, where
   **FUNCTIONAL/ROBUST verdicts MUST come from executed requests, never from reading
   source.** Every "works" cites the request/response.
4. Adversarially **hunt bugs** (bad input, edge cases, data round-trips, and **a
   concurrency burst** when the rubric requires it — this is how the todo-api
   data-loss bug was caught).
5. **Calibration rule** — grade against the rubric's *stated* requirements. Issues
   *beyond* the rubric go in `bugs`/notes but do **not** lower a capability's verdict.
   (This tamed a 0.95↔0.62 verdict swing on identical builds.)
6. Report `quality.score` **out of 10**.

Output structure is enforced by `--json-schema`, so the prompt no longer needs to beg
for "JSON only".

**Expected output — `scored-rubric.json`:**

```json
{
  "fixture": "todo-api",
  "boot_ok": true,
  "capabilities": [
    {
      "name": "Create a todo",
      "present": true,
      "functional": true,
      "robust": true,
      "evidence": "POST /todos {title:'x'} -> 201 {id...}; GET /todos -> contains it; POST {title:'  '} -> 400",
      "notes": ""
    }
  ],
  "coverage_pct": 100,
  "functional_pct": 90,
  "quality": { "score": 8, "notes": "sane status codes; consistent shapes; errors are clear" },
  "bugs": ["PUT with an unknown field is silently ignored"],
  "overall_verdict": "pass",
  "summary": "..."
}
```

Notes: with `--json-schema` the conforming object is in `.structured_output` and is
guaranteed valid — no prose-extraction needed. **`quality.score` is an integer 0–10**;
bound it in the schema (`minimum:0, maximum:10`) *and* say "out of 10" in the prompt —
an unbounded run once returned `4.7` on an implied 0–1 scale. A malformed/absent
`.structured_output` is a judge failure, not a build failure.

## Validated end-to-end (todo-api, ~$1: haiku build + sonnet judge)

The full loop runs and is trustworthy. What the first real runs taught us:

- **The planner needs grounding as much as the builder.** L3 got *no* workspace
  context (generic prompt, no file tools) and hallucinated file/test paths
  (`src/index.ts`, `/tmp/test-…`). Injecting a WORKSPACE CONTEXT block (file tree,
  `package.json`, cwd convention, current circuit) into the planning turn fixed it —
  see [[architecture-current-state]].
- **The rubric must state what it grades.** A build lost data under concurrency; the
  judge flagged it, but the rubric only required single-process persistence. Making
  concurrency explicit (in PROMPT *and* RUBRIC) both *changed the build* (it became
  concurrency-safe) and *aligned the verdict*.
- **Objective vs. subjective.** Per-capability present/functional/robust is **stable**
  across judge runs; `quality`/`overall_verdict` are **noisy** (they track how hard the
  judge probed). Grade on the stable axes; **run a panel** for the fuzzy ones.
- **Daemon robustness.** On a 4 GB host the orca server OOM-died mid-build (server +
  build agent + bun processes at once). The build artifact survived but the circuit
  state was lost — the daemon must survive/restart under its own build load.

## Cross-cutting

- **Isolation = containers.** Both the build agent and the judge *run generated
  code*; one disposable container per run gives clean filesystems, port allocation,
  and resource caps. Parallelize N per host.
- **Two signals, kept separate.** `build-report` = did orca *plan + build* well
  (circuit, loops, governed mutations, cost). `scored-rubric` = is the *software*
  good. A fixture can build a beautiful circuit that produces broken software, or
  vice-versa — grade both.
- **Non-determinism → distributions.** Run the judge as a panel (N independent
  `claude -p` calls); aggregate per capability (e.g. "functional 3/3"); set the pass
  bar on the aggregate, not a lone boolean.
- **Calibration (when `reference/` lands).** Judge the known-good reference (expect
  high) and a known-broken variant (expect low). If the judge can't tell them apart,
  the *judge* is broken — a gate on trusting scores.
- **Reproducibility.** Persist `runs/<fixture>-<model>-<id>/` = `workspace/` +
  `build-report.json` + `scored-rubric.json` + transcripts. Diff scores over time for
  regression.

## Open items

- Build `orca build <spec>` (CLI over the L3 runner + executor + project; the manual
  flow, now that `project_id` is fixed).
- Author `judge-prompt.md` template + the panel/aggregation wrapper.
- Container image + the top-level `orca eval <fixture-spec>` (or shell harness) that
  chains setup → build → judge → score into the suite grid.
- Decide the pass thresholds and whether orca-as-judge ever replaces the headless
  Claude judge.
