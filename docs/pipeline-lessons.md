# Lessons From Running Orchestration Pipelines

Practical observations from building and running two real projects through
orca's action graph system: **quantagraph** (a 24-task physics research
project using static TDD pipelines) and **link-board** (a dynamic-tasking
fixture where a planner agent grows the graph from 1 action to ~50).

These observations are about pipeline design, agent behavior, and prompt
engineering — not orchestrator bugs.

---

## 1. Agent Scope Creep Is the Default Behavior

Agents want to be helpful. Given any information about the broader project,
they will attempt to implement beyond their assigned task.

**Quantagraph:** The develop prompts include a full project description
("Quantagraph reformulates physics using purely relational graph
structures...") and reference docs like `g3-nbody-relational.md`. Early
iterations showed agents reading ahead and attempting to incorporate
design patterns from later levels into the current one.

**Link-board:** The first planner iteration told agents to "read EPICS.md
for the full roadmap." Agents then read all 5 epics and attempted to
implement endpoints from Epic 3 while working on Epic 1. A develop agent
for the auth task also scaffolded comment tables and search endpoints.

**What works:** Task prompts must be hermetically scoped. The agent should
know only what it needs for its specific task:

```yaml
# BAD: agent reads roadmap and builds ahead
develop:
  prompt: "Read EPICS.md for context. Implement the auth system."

# GOOD: agent sees only its immediate scope
develop:
  prompt: "Implement POST /register and POST /login in src/auth.ts.
           Read src/server.ts first for routing conventions.
           Only implement what test/auth.test.ts requires."
```

The link-board planner prompt was revised to explicitly state: "Each task's
prompts must be SCOPED to only the work for that specific task. Do NOT tell
agents to read EPICS.md or implement features beyond their task."

**Rule:** An agent will use every piece of context it receives. If you
give it the roadmap, it will try to build the roadmap.

---

## 2. TDD Ordering Matters: Tests First Constrains the Agent

Both projects use a write-tests → develop → eval pattern. This is not
just a testing strategy — it's the primary mechanism for constraining
agent behavior.

When `write-tests` runs first, it defines the exact public API surface
the develop agent must satisfy. The develop agent reads the test file and
implements *only what the tests require*. Without pre-written tests, the
develop agent invents its own API surface, which may not match what
downstream consumers expect.

**Quantagraph example:**
```yaml
write-tests:
  prompt: "Create tests/gravity/test_g1.py. Import from src/gravity.g1.
           Test cases: free-fall time, bound oscillation period, force
           magnitude, energy conservation, momentum conservation."
develop:
  prompt: "Create src/gravity/g1.py. Read the tests first to understand
           the expected API."
```

The write-tests agent defined `GravityGraph`, `add_body()`, `connect()`,
`step()`, `force()`, `total_energy()`. The develop agent read these tests
and implemented exactly that API — no more, no less.

**Contrast with dev template (no write-tests):**
When using the `dev` template (develop → eval), the develop agent has more
freedom. For simple tasks (config changes, refactors), this is fine. For
feature work, the lack of pre-written tests means the agent defines its
own scope — which leads back to the scope creep problem.

**Rule:** For any task where the desired output is non-obvious, write
tests first. The test suite is a specification, not just a verification.

---

## 3. Eval Commands Must Be Precise

Eval actions are command-type actions that run a test suite. The command
string is the single most important configuration decision in a task.

**What goes wrong with broad eval commands:**
```yaml
eval:
  command: "bun test"  # runs ALL tests
```

When a develop agent for Epic 2 runs `bun test`, it also runs Epic 1's
tests. If the agent accidentally broke an Epic 1 endpoint while
implementing Epic 2, the eval catches it — but the fail edge routes back
to the Epic 2 develop agent, which may not understand or be able to fix
Epic 1 code. The develop agent burns turns trying to fix code it didn't
write, often making things worse.

**What works:**
```yaml
eval:
  command: "bun test test/auth.test.ts"  # only this task's tests
```

Scoped eval commands mean the develop agent only retries on its own
failures, not inherited breakage.

**When to use broad eval:** Sprint QA (integration testing between epics)
is the right place for `bun test` — it runs everything and catches
cross-epic regressions. But sprint QA has different failure routing
(to the next planner, not back to develop), so the correct agent handles
the fix.

**Rule:** Task-level eval tests only that task. Integration eval happens
at milestone boundaries.

---

## 4. Failure Edges Must Be Complete

Every action that can fail needs an explicit failure path. Missing failure
edges cause the graph to stall silently.

**Link-board incident:** The planner created task chains with pass edges
but forgot fail edges on write-tests. When write-tests failed, the
executor found no matching outgoing edge for condition "fail" and went
idle. The graph appeared to be running but nothing was happening.

**Quantagraph design:** The TDD template defines explicit failure routing:
```yaml
eval:
  type: command
  edges:
    fail: develop      # test failures retry develop
    error: develop     # unexpected errors retry develop
    stuck: develop     # same output 3x retries develop
    timeout: develop   # timeout retries develop
    cost_exceeded: develop
    max_turns: develop
```

All 7 edge conditions are handled. Nothing falls through.

**The supervisor as safety net:** Even with complete edge definitions,
novel failure modes can occur. A supervisor action (tagged
`type:supervisor`) automatically activates when any action fails with
no matching outgoing edge. This prevents silent stalls.

**Rule:** Define edges for all 7 conditions (pass, fail, error, stuck,
timeout, cost_exceeded, max_turns) on every action, or ensure a
supervisor exists as the global fallback.

---

## 5. Templates Eliminate Wiring Errors

The single biggest source of configuration bugs is manual edge wiring.
Every edge requires knowing the exact action IDs (which include the task
prefix), the correct condition string, and the right direction.

**Before templates (link-board early iteration):**
The planner agent had to issue 3-4 `POST /actions` calls and 6+
`POST /edges` calls per task. It routinely made mistakes:
- Wrong action IDs (typos, missing task prefix)
- Missing fail edges
- Edges pointing in wrong direction
- Forgetting to set project_id on actions

**After templates (POST /groups):**
```bash
curl -X POST /groups -d '{
  "id": "auth-models",
  "template": "tdd",
  "project_id": "link-board",
  "prompt": "Implement user model...",
  "after": "plan-epic-1.plan"
}'
```

One call creates all actions with correct types, params, and edges.
The template defines the internal wiring; the caller only specifies
the task identity and how it connects to the rest of the graph.

**Rule:** Agents should never wire individual edges. Templates encode
structural patterns; agents choose which template and provide content.

---

## 6. Nix Environment Must Be Explicit and Tested

The quantagraph project uses Python with uv, numpy, scipy, einsteinpy,
and qutip — all provided by a flake.nix. The eval command is
`uv run pytest tests/gravity/test_g1.py -v`. If the nix environment
isn't active, `uv` is not found and every eval fails immediately.

**What went wrong:** The project was imported in a way that set
`project_dir` to the wrong directory. The executor ran eval commands
in orca's directory (which has a different flake.nix providing bun,
not uv). Every eval failed with `uv: command not found`, eval routed
back to develop, develop re-implemented the same code, eval failed
again. The task burned 20 iterations and $7+ before anyone noticed.

The agents never reported "uv not found" as the problem because the
develop agent (which is an agent-type action, not a command) had
correct nix resolution and could run uv fine. Only the eval command
(a command-type action) failed, and its error was just treated as
"tests failed" by the develop agent.

**Lessons:**
1. The `project_dir` in the config determines everything: working
   directory, nix shell, log location. Getting it wrong silently
   breaks the entire pipeline.
2. Command actions and agent actions resolve their environment
   differently. Test both paths.
3. A failing eval that always fails with the same error should be
   detected earlier. The stuck detection (3 identical outputs) catches
   this eventually, but 3 iterations of `uv: command not found` is
   3 wasted agent runs.

**Rule:** Validate the environment before running the pipeline. A
preflight check that runs the eval command once (expecting failure from
missing implementation, not from missing tools) would catch this class
of error immediately.

---

## 7. Prompt Structure for Multi-Level Projects

Quantagraph has 12 gravity levels (G1-G6 implemented, G7-G9 planned)
and 12 quantum levels (Q1-Q6 implemented, Q7-Q9 planned). Each level
builds on the previous. The prompt structure evolved through iteration.

**What the prompt must contain:**

1. **Project-wide constraint** (repeated in every prompt):
   "Coordinate-free means NO position attributes on nodes..."
   This is non-negotiable context that the agent must internalize.
   Repeating it costs tokens but prevents the most common error
   (agents reverting to coordinate-based implementations).

2. **What already exists** (reference, not instruction):
   "G1-G3 already implemented in src/gravity/g1-g3.py."
   The agent needs to know what to import and build on, but should
   not be told to modify existing code.

3. **Exact scope for this level**:
   "Level G4: Write tests for special relativity in 1+1D."
   Unambiguous statement of what this task produces.

4. **Specific test cases or implementation targets**:
   Not "test special relativity" but "test time dilation,
   length contraction, velocity addition, invariant interval,
   energy-momentum relation."

5. **Environment instructions**:
   "Run tests with `uv run pytest ...`. Do NOT implement source."

**What the prompt should NOT contain:**
- Future levels ("G5 will add 2+1D...")
- Design philosophy discussions (put these in docs, reference the path)
- Alternative approaches ("you could use Regge calculus or...")

The quantagraph project keeps detailed design notes in
`docs/notes/g3-nbody-relational.md` (333 lines discussing Cayley-Menger
determinants, shape dynamics, Regge calculus). The develop prompt for G7+
references this file rather than inlining the discussion:
"Read docs/notes/g3-nbody-relational.md for design context."

**Rule:** Prompts should be instructions, not essays. Put reference
material in files the agent can read; keep the prompt focused on
what to do right now.

---

## 8. Budget and Iteration Limits Are Safety Rails

Both projects set `max_iterations: 20` per task and `max_turns: 50-100`
per agent action. These aren't performance targets — they're circuit
breakers.

**Quantagraph G7 incident:** The develop action for general relativity
(the hardest task yet) hit max_iterations (20) without producing passing
tests. This is expected — GR is genuinely harder than Newtonian gravity.
The supervisor examined the history, found the agent was making progress
(tests going from 0/5 to 3/5 passing), and retried with increased budget.

**Link-board observation:** Simple tasks (auth, CRUD endpoints) complete
in 1-3 iterations. Complex tasks (threaded comments with voting, search
with pagination) take 4-8 iterations. No task needed more than 10.

**Practical settings that worked:**
- `max_turns: 40-50` for write-tests (agents that just write test files)
- `max_turns: 80-100` for develop (agents that implement + debug)
- `max_turns: 30` for QA (agents that run curl commands)
- `max_iterations: 10-20` per task (eval → develop retry loop)
- `wall_timeout: 600` (10 minutes — kills hung SDK calls)

**The cost dimension:** At $0.10-$0.50 per agent action (Sonnet) or
$0.30-$1.50 (Opus), a 20-iteration task can cost $2-$30. Budget
awareness matters for research projects like quantagraph where a single
hard task might consume the entire budget.

**Rule:** Set iteration limits based on expected task complexity, not
optimistically. A task that needs 20 iterations probably needs a better
prompt, not a higher limit.

---

## 9. The Planner Pattern: Strengths and Pitfalls

The link-board's dynamic tasking system starts with one planner action
that reads an epic list and creates the entire task graph for that epic.
After the epic completes, sprint QA runs, and the next planner activates.

**What works well:**
- Planners can adapt. If sprint QA fails, the next planner sees the
  failure output as predecessor context and can plan fix tasks.
- Template expansion via POST /groups eliminates manual edge wiring.
- Planner prompts live in the template, so new planners inherit the
  same instructions automatically.
- Both pass and fail edges from sprint QA to the next planner mean
  the pipeline always progresses (fix-forward, not retry-backward).

**What requires care:**
- The planner prompt is the longest and most complex prompt in the
  system (~100 lines). It must precisely document the API calls, edge
  wiring patterns, naming conventions, and scoping rules. A vague
  planner prompt produces vague task decomposition.
- Planners must check graph state before acting. Without the
  `curl /actions | jq` step, a planner may re-create tasks that
  already exist (409 conflict) or miss completed work.
- The planner's prompt guidelines section (lines 182-214 in
  link-board's config) is as important as the planning logic itself.
  It tells the planner HOW to write prompts for the tasks it creates.

**Anti-pattern: planner as implementor.** If the planner's max_turns
is too high, it may start implementing code itself instead of delegating
to task groups. Keep planner max_turns at 30-40 (enough for API calls
and graph reading, not enough for coding).

---

## 10. Static vs Dynamic Pipelines: When to Use Each

**Static pipelines (quantagraph):** All tasks defined in YAML upfront.
The entire graph is visible before execution starts.

Best when:
- The task decomposition is known in advance
- Each task has unique, hand-crafted prompts
- The domain requires precise specifications (physics, math)
- You want human review of the full plan before spending money

**Dynamic pipelines (link-board):** A planner agent creates tasks at
runtime based on project state and a high-level goal.

Best when:
- The decomposition depends on runtime state (what's already built)
- Tasks follow repeatable patterns (CRUD endpoints, test suites)
- You want adaptive planning (fix tasks inserted after QA failures)
- The project is large enough that maintaining a static YAML is unwieldy

**Hybrid approach (quantagraph stage 2):** Static top-level task
definitions with dynamic supervisor intervention. The task graph is
predetermined, but the supervisor can retry with modified params,
bump budgets, or fix code when tasks fail in unexpected ways.

**Rule:** Use static pipelines when you know what to build. Use dynamic
pipelines when you know the *pattern* of what to build but not the
specifics until runtime.

---

## 11. Commit Strategy: Git as a Progress Checkpoint

Both projects include a `commit` action after eval passes:
```yaml
commit:
  type: command
  command: "git add -A && git commit -m 'G1: newtonian gravity 1D' || true"
```

This serves three purposes:
1. **Progress preservation:** If a later task breaks something, you can
   bisect to find which task introduced the regression.
2. **Agent context:** Agents that read git log can see what was done
   in previous tasks without reading all source files.
3. **Human review:** After the pipeline completes, `git log --oneline`
   shows exactly what was built and in what order.

**The `|| true` is important.** If nothing changed (agent re-ran without
modifications), git commit fails. The `|| true` prevents this from
killing the pipeline.

**Commit messages should identify the task.** Generic messages like
"auto: develop complete" are less useful than "G1: newtonian gravity 1D"
or "feat: auth-models". The quantagraph config puts the level name in
each commit message.

---

## 12. Notification as a Pipeline Heartbeat

Both projects use ntfy.sh for fire-and-forget notifications:
```yaml
notify:
  type: command
  command: "curl -s -d 'G1 eval passed' ntfy.sh/quantagraph-5xy"
```

This sounds trivial but is operationally important. Long pipelines
(quantagraph: 24 tasks × 5 actions = 120 actions; link-board: ~50
actions) run for hours. Without notifications, you don't know if the
pipeline is progressing, stuck, or finished.

**Where to place notifications:**
- After eval passes (task completed successfully)
- Between epics (sprint boundary — good checkpoint for human review)
- On supervisor activation (something went wrong, may need attention)

**Anti-pattern:** Notifying on every action start/end. This creates
alert fatigue. Notify on meaningful milestones, not mechanical steps.

---

## Summary of Rules

1. Scope task prompts tightly. Agents use every piece of context they receive.
2. Write tests first to constrain the develop agent's output.
3. Eval commands should test only the current task, not the whole project.
4. Define failure edges for all 7 conditions, or use a supervisor fallback.
5. Use templates for structural patterns; agents should never wire edges manually.
6. Validate the runtime environment before starting the pipeline.
7. Keep reference material in files; keep prompts focused on immediate instructions.
8. Set iteration limits as safety rails, not performance targets.
9. Planner prompts must document how to write prompts, not just what to build.
10. Use static pipelines for known decompositions, dynamic for pattern-based work.
11. Commit after each passing eval for progress checkpoints and bisectability.
12. Notify on milestones, not on every step.
