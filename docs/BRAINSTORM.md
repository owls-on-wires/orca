# Brainstorm: Orca Feature Improvements
Date: 2026-04-19

## Categories
1. Reliability & Error Recovery
2. Monitoring & Observability
3. Eval System
4. Agent Quality
5. Cost & Budget
6. Developer Experience
7. Multi-Build Coordination

---

## 1. Reliability & Error Recovery

### 1a. Graceful child process cleanup
**Problem:** When orca is aborted or crashes, Claude subprocesses and their children (MCP servers, bash commands) become orphans. We saw this — `orca abort` killed the parent but left Claude + bun test + playwright MCP running.

**Fix:** Use process groups. Spawn Claude in a new process group (`setpgid`), then kill the entire group on abort. Also register SIGTERM/SIGINT handlers in the orca process that clean up child process groups before exiting.

### 1b. Atomic state writes
**Problem:** `state.json` is written with `writeFileSync` directly. If orca crashes mid-write, the file is corrupted and resume/monitor break.

**Fix:** Write to `state.json.tmp`, then `rename()` (atomic on Linux/Mac). Already noted in TODO item 4.

### 1c. Stage timeout enforcement
**Problem:** `stage_timeout` is in the config schema but unclear if it's enforced at the invoke level. The analyze stage hung for 3+ hours.

**Fix:** Pass timeout to the SDK invocation, AND implement a watchdog timer in the loop that kills the invoke if it exceeds `stage_timeout`. Defense in depth — don't rely solely on the SDK honoring the timeout.

### 1d. Automatic retry on transient failures
**Problem:** If the Claude API has a transient error (rate limit, network blip), the stage fails and the iteration is wasted.

**Fix:** Add retry logic around `invoke()` calls with exponential backoff. Only retry on transient errors (network, 429, 500), not on structured output errors. Max 3 retries. This is different from the iteration loop retrying — this is retrying a single API call.

### 1e. Stale intervention cleanup
**Problem:** Old `intervention.json` files from previous builds aren't cleaned up. New builds see them and may pause incorrectly.

**Fix:** At build start, check for and remove stale intervention files. Or scope intervention files to the run directory instead of the top-level `.orca/` dir.

### 1f. Settings isolation for subagents
**Problem:** Subagents inherit user/project settings via `settingSources: ["user", "project", "local"]`. This loads MCP servers (playwright, mail), custom hooks, and other config that interferes with the build. The analyze agent loaded MCP servers and ran bash commands through them.

**Fix:** Use `settingSources: []` or a minimal set. Subagents should only have the tools orca explicitly gives them, not the user's full Claude environment. MCP servers in particular should never load in orca subagents.

---

## 2. Monitoring & Observability

### 2a. Build timeline / Gantt view
**Problem:** The web monitor shows current state but not history. You can't see "task A took 4 iterations, task B took 1, task C is stuck."

**Fix:** Add a timeline view that shows each task as a horizontal bar with iteration markers. Color-coded: green = passed, red = failed, yellow = running, gray = pending. Shows cost per task. Uses the stage history data already in state.json.

### 2b. Live log streaming in web UI
**Problem:** The web monitor shows state but not the agent's live output (what it's reading, writing, thinking).

**Fix:** Stream `build.jsonl` events to the WebSocket. Show tool uses, text output, and eval results in a scrollable log panel. Filter by task/stage.

### 2c. Cost tracking dashboard
**Problem:** Cost is tracked per-task but not visualized well. No way to see cost trends over iterations or compare across tasks.

**Fix:** Add a cost panel to the web monitor showing: total spend, spend per task, spend per iteration, burn rate ($/min), projected total cost based on remaining tasks and average cost.

### 2d. Multi-build dashboard
**Problem:** `orca monitor` watches one build. If you have multiple orca builds across different projects, you need separate monitors.

**Fix:** A dashboard mode that scans for all `.orca/` directories and shows a summary of all builds. Or a central registry where builds register themselves.

### 2e. Notification on iteration progress
**Problem:** Notifications only fire on task complete, build complete, escalation. No notification for "task X now on iteration 5/10, still failing."

**Fix:** Add `on_iteration` notification config with a threshold (e.g., notify every 3 iterations, or when past 50% of max_iterations). Helps catch stuck tasks earlier.

---

## 3. Eval System

### 3a. Multiple eval commands per task
**Problem:** A task has one eval command. Some tasks need both unit tests AND integration tests AND lint checks to pass.

**Fix:** Allow `eval` to be a list:
```yaml
eval:
  - command: "bun test src/feature.test.ts 2>&1"
    parser: exit_code
    name: unit
  - command: "bun run lint 2>&1"
    parser: exit_code
    name: lint
```
All must pass for the loop to exit. Individual results shown in state.

### 3b. Eval caching / skip-if-unchanged
**Problem:** Eval runs every iteration even if the develop stage made no changes (e.g., escalation returned without editing files).

**Fix:** Hash the relevant source files before eval. If unchanged since last eval, skip and reuse previous result. Saves time and cost on stuck iterations.

### 3c. Partial pass detection
**Problem:** The eval gate is binary: all_passed or not. A task that goes from 2/10 tests passing to 8/10 still "fails."

**Fix:** Track test pass count over iterations. If progress is being made (more tests passing each iteration), continue. If test count is static for N iterations, that's the real stuck signal — not just "not all passing."

### 3d. Eval-only mode for debugging
**Problem:** When writing eval commands, you want to test them without running a full build.

**Fix:** `orca eval <config> --task <id>` — runs just the eval command for a task and shows the parsed result. Quick feedback loop for eval authoring.

### 3e. Bun test parser
**Problem:** Bun test output isn't parsed — we use `exit_code` which loses per-test detail. The analyze agent has to read raw output to figure out what failed.

**Fix:** Add a `bun_test` parser that extracts pass/fail counts and test names from bun's output format. Or support `bun test --reporter=junit` with a junit parser.

---

## 4. Agent Quality

### 4a. Context injection from prior iterations
**Problem:** Each develop iteration starts fresh. The agent doesn't know what it tried last time unless it reads analyze.json from disk. The analyze → develop handoff is lossy.

**Fix:** Inject a structured context block into the develop prompt: "Iteration 3. Last iteration you tried X, which resulted in Y. The analyze stage recommends Z." Built from the stage history in state.json.

### 4b. Session continuity within a task
**Problem:** Each stage invocation is a separate Claude session. The develop agent loses context between iterations — it has to re-read files, re-understand the codebase.

**Fix:** Use session resumption (`resume: sessionId`) within a single task's iterations. The develop agent keeps its context window across iterations. Clear the session on supervisor intervention or revert.

### 4c. Scope enforcement via `tools` (not `allowedTools`)
**Status:** Just fixed. But worth noting that the `canUseTool` callback provides defense-in-depth — even if `tools` is somehow bypassed, the scope callback blocks unauthorized file access.

### 4d. Prompt customization per project
**Problem:** The built-in prompts are generic. Projects with specific conventions (e.g., "always use Result<T> for errors", "follow this naming scheme") need custom prompts.

**Fix:** Already partially supported via `stages.*.prompt` and the `prompts.context` field. But could be improved with a `prompts/` directory convention where the project drops custom prompt files that override the built-ins. Per-task prompt overrides via `stages/{task_id}/{stage}.prompt.txt` already work.

### 4e. QA stage for non-test-driven work
**Problem:** Some tasks don't have tests — they're UI changes, config changes, or documentation. The eval loop doesn't help here.

**Fix:** A QA stage that uses a separate Claude agent to verify the work by inspecting the codebase, running the app, or checking screenshots. The QA agent produces a pass/fail judgment. This is already partially implemented (`qa.prompt.txt` and `qa.schema.json` exist) but may not be wired into the loop.

---

## 5. Cost & Budget

### 5a. Meta-budget across planning cycles
**Problem:** With the live task queue, a planner can keep adding tasks indefinitely. Per-task budgets don't prevent runaway total spend.

**Fix:** Add `budget.max_total_cost` — a hard ceiling on the entire build's cumulative cost. When reached, the build pauses with an intervention request rather than silently stopping.

### 5b. Cost prediction before build
**Problem:** No way to estimate cost before running a build. You commit to running it and hope it's within budget.

**Fix:** `orca estimate <config>` — counts tasks, multiplies by average cost per task (from historical data or a configurable estimate), prints expected cost range. Rough but useful for sanity checking.

### 5c. Model downgrade on budget pressure
**Problem:** When a task is near its cost limit, it still uses the most expensive model (opus). The last few iterations could use a cheaper model.

**Fix:** Add a `budget.downgrade_at` threshold (e.g., 0.8). When cost exceeds 80% of max_cost, switch to sonnet for remaining iterations. Configurable per-stage.

---

## 6. Developer Experience

### 6a. Dry run mode
**Problem:** No way to test a config without actually invoking Claude. You want to verify: tasks load correctly, dependencies resolve, eval commands work, prompts render.

**Fix:** `orca build <config> --dry-run` — loads config, resolves tasks, runs eval commands (but not Claude stages), renders prompts with template variables, prints the execution plan. Catches misconfigurations before spending money.

### 6b. Config validation with specific errors
**Problem:** `orca validate` says "Invalid config" without details. Doesn't check eval commands, template variables, or file references.

**Fix:** Enhanced validation: check that eval commands exist and are executable, template variables referenced in prompts are defined, `depends_on` IDs exist, stage prompt files exist. Print specific errors for each issue.

### 6c. Build history and comparison
**Problem:** Each build creates a new timestamped run directory. No easy way to compare two runs — "what changed between yesterday's build and today's?"

**Fix:** `orca diff <config> [run1] [run2]` — compares two runs showing: which tasks changed status, cost differences, iteration count differences. Defaults to comparing the latest two runs.

### 6d. Task-level resume
**Problem:** `resume` skips completed tasks and runs remaining ones. But if a task failed, resume can't retry just that task in the context of the build.

**Fix:** `orca resume <config> --retry-failed` — resets failed tasks to pending and re-runs them. Or `orca resume <config> --task <id>` — retries a specific failed task.

### 6e. Config inheritance / includes
**Problem:** Multiple projects share similar orca configs (same workflow, same stage settings, different tasks). Copy-pasting configs.

**Fix:** Support `extends: base.orca.yaml` or `!include stages.yaml` to compose configs from shared fragments.

---

## 7. Multi-Build Coordination

### 7a. Parallel task execution
**Problem:** Tasks with independent dependencies could run in parallel. Currently orca runs them sequentially.

**Fix:** When multiple tasks in the queue have all dependencies satisfied, spawn them in parallel (each in its own Claude session). Requires careful git handling — each parallel task needs its own worktree or branch, with merging after completion.

### 7b. Cross-build dependencies
**Problem:** Build A produces artifacts that Build B needs. No way to express this.

**Fix:** Probably out of scope for orca. Better handled by a CI system or Makefile that runs `orca build A && orca build B`. Keep orca focused on single-build orchestration.

---

## Synthesis

### High-value, low-effort
- **1f. Settings isolation** — critical reliability fix, ~3 lines changed
- **1e. Stale intervention cleanup** — simple, prevents confusion
- **1b. Atomic state writes** — small change, prevents data loss
- **3d. Eval-only mode** — helpful for authoring, ~30 lines
- **6a. Dry run mode** — catches errors before spending money

### High-value, medium-effort
- **1a. Process group cleanup** — prevents orphan processes
- **1c. Stage timeout watchdog** — defense in depth
- **4a. Context injection** — improves agent quality significantly
- **4b. Session continuity** — could reduce cost and improve quality
- **2b. Live log streaming** — makes monitoring actually useful
- **5a. Meta-budget** — essential for autonomous builds

### High-value, high-effort
- **7a. Parallel task execution** — major perf improvement but complex git handling
- **3c. Partial pass detection** — smarter stuck detection
- **2a. Build timeline** — best visibility into build behavior

### Probably not worth it
- **7b. Cross-build dependencies** — out of scope
- **5b. Cost prediction** — too speculative to be accurate
- **6e. Config inheritance** — YAGNI until there are many orca users

## Next Steps

1. **Immediate fixes (do now):**
   - Settings isolation (1f) — change `settingSources` to `[]`
   - Stale intervention cleanup (1e)
   - Atomic state writes (1b)

2. **Next batch (after TODO items land):**
   - Process group cleanup (1a)
   - Stage timeout watchdog (1c)
   - Meta-budget (5a)
   - Eval-only mode (3d)
   - Context injection for develop stage (4a)

3. **Future exploration:**
   - Session continuity (4b) — needs SDK testing
   - Parallel tasks (7a) — needs design work
   - Live log streaming (2b) — after web UI state sync is fixed
