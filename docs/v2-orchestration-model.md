# Orca v2 — Generalized Orchestration Model

> Living document. Started 2026-05-06.

## Problems with the current model

Three failure patterns keep recurring, all rooted in the same thing: **the execution plan can't change mid-execution, and nothing has the authority to change it.**

### Parameter mistuning kills good runs

The QA agent ran out of turns (`max_turns: 30`) doing Playwright testing. It was doing good work — found real bugs, invoked StructuredOutput correctly. But the SDK returned `error_max_turns`, orca threw away the entire result (cost, output, everything — see bugs.md), and the build looped until budget exhaustion.

An intelligent system would observe: "this action is productive but under-budgeted." It would bump the parameter and retry, not discard the result and restart.

### Config errors require full stop-and-restart

One run had per-task eval commands (grep checks) that were redundant with the QA stage. Eval kept passing on strings matching existing comments, QA kept failing on actual behavior. The loop burned $0.95 in 6 pointless cycles.

A supervisor could diagnose this: "eval is matching comments, not implementation. QA already tests behavior. These eval overrides should be removed." But it can't fix it — eval commands are baked into the config. The build had to be manually stopped, the YAML edited, and restarted.

### No distinction between "retry this" and "restructure the plan"

If a deploy stage fails because a port is in use, a supervisor can kill the process and retry. But if the workflow itself is wrong — eval in the wrong position, QA as a loop stage instead of a post-stage (which means `passed` is never set, see our earlier debugging) — no amount of retrying helps. The system needs to know when to retry an action vs. when to change the plan.

## The current model's rigidity

```
static config (YAML)
  -> fixed workflow (pre/loop/post)
    -> fixed stages per phase
      -> fixed parameters per stage
```

Escape hatches:
- Live config reload: can change max_iterations and max_cost. Nothing else.
- Supervisor: can retry/skip/abort. Can't restructure.
- Human intervention: can continue/skip/abort with a note.

None of these can add/remove a stage, change the workflow structure, modify eval commands, or adjust turn budgets dynamically.

## The generalized model

Strip away the current abstractions (tasks, stages, workflows, pre/loop/post). What remains:

**A build is a mutable directed graph of actions, where each action produces an output that determines which action runs next, and a privileged supervisor action can edit the graph itself.**

### Actions

An action is one unit of work.

| Type | What it does | Current equivalents |
|------|-------------|---------------------|
| agent | Invoke Claude with prompt, tools, scope, schema | develop, understand, analyze, qa, supervisor |
| command | Run a shell command, check exit code. Optionally `wait_for_response: true` to halt and wait for human input. | eval, deploy, git snapshot, human notification |

Every action has:
- **Inputs**: outputs from predecessor actions
- **Outputs**: structured data (status, artifacts, cost, turns, errors)
- **Constraints**: scope, toolset, model, max_turns, max_cost
- **Edges**: conditional successors

### No global workflow — actions are per-task

The current model has a global `workflow: [develop, eval, deploy, qa]` that every
task expands through. This is wrong — different tasks need different actions:

- A complex feature needs: `write_tests → develop → eval → deploy → qa`
- A simple CSS fix needs: `develop → eval`
- A refactor needs: `develop → eval`
- An investigation needs: `understand` (single action, no loop)

**Tasks specify which actions they need.** The list of action names implies
sequential edges. Gate actions (eval, qa) get automatic fail-loops back to the
first action. That's it — no global workflow, no pre/loop/post.

Defaults exist per **action type** (not per workflow position). "All qa actions
default to max_turns: 80" is a type default. Tasks can override.

```yaml
# The authoring format
defaults:
  types:
    develop: { type: agent, max_turns: 150, toolset: all }
    eval:    { type: command, command: "bun test" }
    deploy:  { type: command, command: "bash deploy.sh" }
    qa:      { type: agent, max_turns: 80, toolset: all }

tasks:
  - id: auth
    prompt: "Implement JWT authentication..."
    actions: [develop, eval, deploy, qa]

  - id: css-fix
    prompt: "Fix the button hover color..."
    actions: [develop, eval]

  - id: payment
    prompt: "Implement Stripe integration..."
    actions: [write_tests, develop, eval, deploy, qa]
    depends_on: [auth]
```

Each task gets exactly the actions it needs. No wasted stages.

### Edges, conditions, and timeouts

Currently, branching is hardcoded in loop.ts. In the generalized model, all
outcomes — including timeouts, budget limits, and turn limits — are **edge
conditions**. They're the same mechanism as pass/fail:

```
develop → eval                     [always]
eval → deploy                      [pass]
eval → develop                     [fail]
deploy → qa                        [always]
qa → DONE                          [pass]
qa → develop                       [fail]
qa → supervisor                    [max_turns]
qa → supervisor                    [timeout]
develop → supervisor               [cost_exceeded]
develop → supervisor               [stuck]
```

The full set of conditions an action can produce:

| Condition | Signal | Meaning |
|-----------|--------|---------|
| `pass` | output.status == "passed" or exit_code == 0 | Action succeeded |
| `fail` | output.status == "failed" or exit_code != 0 | Action failed normally |
| `max_turns` | SDK error_max_turns | Agent ran out of turns |
| `timeout` | Wall clock exceeded limit | Action took too long |
| `cost_exceeded` | Action cost > max_cost | Over budget |
| `stuck` | Same output hash N consecutive times | Agent looping |
| `error` | SDK error_during_execution, crash | Unexpected failure |

These are just strings. Edges match on them. The executor classifies each
action's result into a condition and follows the matching edge. If no edge
matches, the action is marked failed and execution stops (or routes to a
default supervisor edge).

**Defaults per action type include default edge routing:**

```yaml
defaults:
  types:
    qa:
      type: agent
      max_turns: 80
      timeout: 600          # 10 minutes
      edges:
        pass: complete      # terminal — mark task done
        fail: first         # loop back to first action in task
        max_turns: supervisor
        timeout: supervisor
        stuck: supervisor
    eval:
      type: command
      timeout: 120
      edges:
        pass: next          # continue to next action
        fail: first         # loop back to first action
        timeout: fail       # treat timeout as failure
        error: supervisor
```

Routing shorthands:
- `first` → edge to the first action in this task
- `next` → edge to the next action in sequence
- `complete` → no successor, task is done
- Or an explicit action ID (e.g., `auth.supervisor`, `my-slack-notify`)

`supervisor` and `human` are not special shorthands — they're just action type
names from `defaults.types`. Writing `edges: { fail: supervisor }` means
"create an action of type `supervisor` (if not already present for this task)
and wire a fail edge to it." Same for `human` or `human-slack` or any other
type name you've defined.

This means **no hardcoded failure handling in the executor**. The executor
just follows edges. All routing — including error recovery — is data in the
graph.

### The supervisor as graph editor

The key departure. The supervisor isn't a decision point ("retry or abort") — it's an action that can **modify the graph**:

- Change parameters (bump max_turns from 30 to 80)
- Remove actions (delete redundant eval grep checks)
- Add actions (insert "fix environment" command before retry)
- Rewire edges (make QA a post-gate instead of loop stage)
- Replace actions (swap a broken eval command)

The supervisor sees:
- Current graph structure
- Execution history (what ran, what it produced, costs, durations)
- Failure mode classification (why we're here)
- Original intent (task descriptions, prompts)

It produces a **graph delta** — modifications to apply before resuming.

This means the graph representation must be simple enough for an LLM to reason about and edit. It probably looks like a list of action objects with `id`, `type`, `params`, `edges`, similar in spirit to how tasks.yaml already works, just more general.

### Failure modes are just edge conditions

There is no separate "failure mode detection" system. Every outcome — including
errors, timeouts, and budget limits — is a condition that edges match on. The
routing is defined in the graph, not hardcoded in the executor.

The supervisor is just another action. If an edge routes to it, it runs. If
not, it doesn't. A simple task might route all failures back to develop with
no supervisor involved. A critical task might route everything through the
supervisor. The user decides per-task via the edge defaults on action types.

## Does this cover everything?

| Use case | How it maps |
|----------|------------|
| Simple linear build | A -> B -> C, all success edges |
| Iterative dev loop | develop -> eval, eval[fail] -> develop, eval[pass] -> done |
| Post-stage verification | eval[pass] -> deploy -> qa, qa[fail] -> develop |
| Parallel tasks | A and B have no edges between them, run concurrently; C depends on both |
| Dynamic task discovery | planner action adds new nodes to graph mid-build |
| Human intervention | human action blocks until input, output routes through supervisor |
| Self-repair | supervisor detects problem, edits graph, execution resumes |
| Git operations | snapshot/commit are command actions with dependency edges |
| Environment setup | deploy is a command action, QA depends on it |

Yes. This covers everything the current system does, plus the self-repair it lacks.

## Tagging model

Every action has a globally unique ID (e.g., `auth.develop`, `payment.qa`) and
a `tags` JSON array. Tags are the mechanism for grouping, filtering, and bulk
operations — they replace the structural concept of "tasks" and "stages."

### Auto-generated tags

When a YAML template is imported, each action gets tags automatically:

- `type:<name>` — the action type from defaults (e.g., `type:qa`, `type:develop`)
- `task:<id>` — which task it was expanded from (e.g., `task:auth`)
- `project:<name>` — the project name from the template

### Custom tags

Tasks can add arbitrary tags in the YAML:

```yaml
tasks:
  - id: auth
    prompt: "..."
    actions: [develop, eval]
    tags: [sprint:12, critical, team:backend]
```

All actions expanded from this task inherit the custom tags.

### Tag-based operations

Tags are the primary query/mutation interface:

```
GET    /actions?tag=type:qa              — all QA actions across all tasks
GET    /actions?tag=task:auth            — all actions in the auth task
GET    /actions?tag=critical             — everything tagged critical
GET    /actions?tag=type:qa&status=failed — failed QA actions
PATCH  /actions?tag=type:qa              — bulk update all QA actions
DELETE /actions?tag=type:eval            — remove all eval actions
POST   /actions/retry?tag=project:orca&status=failed — retry all failures
```

The UI filters by tag for display. "Show me the auth task" is just filtering
by `task:auth`. "Show me all QA actions" is filtering by `type:qa`. There's no
special task or stage concept in the data model — just actions with tags.

## Escalation chain: action → supervisor → human

Actions, supervisors, and humans form an escalation chain. Each level handles
what it can and escalates what it can't.

### The chain

```
action fails
  → edge routes to supervisor (if configured)
    → supervisor analyzes, modifies graph, retries
      → if supervisor succeeds: execution resumes
      → if supervisor fails/times out/exceeds budget:
        → edge routes to human
          → human is notified (push notification, email, etc.)
          → action pauses, waits for human input
          → human responds via API or UI
          → execution resumes with human's decision
```

### Human is just an action, not a built-in

There is no special "human" action type. A human escalation is a regular action
— typically type `command` — that runs a notification command and then waits:

```yaml
defaults:
  types:
    human:
      type: command
      command: 'curl -s -d "{context}" https://ntfy.sh/my-topic'
      wait_for_response: true    # halt after command, wait for POST /respond
      timeout: null              # no timeout — wait forever
```

The only built-in behavior is the `waiting` status. When an action has
`wait_for_response: true`, the executor:

1. Runs the command (send notification)
2. Sets status to `waiting` (not `completed`, not `failed`)
3. Leaves it alone — doesn't schedule it, doesn't time it out
4. Resumes when someone hits `POST /actions/:id/respond`
5. The response body becomes the action's output, edge routing continues

The notification mechanism is entirely user-configured. Use ntfy, Slack
webhook, email via sendgrid, a custom script — it's just a command. The
UI also shows waiting actions prominently, so a human watching the dashboard
sees them without needing push notifications.

Users can define multiple human-type actions with different channels:

```yaml
defaults:
  types:
    human-slack:
      type: command
      command: 'curl -X POST -d ... https://hooks.slack.com/...'
      wait_for_response: true
      timeout: null
    human-ntfy:
      type: command
      command: 'curl -s -d "{context}" https://ntfy.sh/my-topic'
      wait_for_response: true
      timeout: null
```

And reference them in edges: `edges: { fail: human-slack }`

### Supervisor edges to human

The supervisor itself has edge routing, including a `human` shorthand:

```yaml
defaults:
  types:
    supervisor:
      type: agent
      model: opus
      max_turns: 40
      timeout: 300
      edges:
        pass: retry_source    # supervisor fixed it, retry the original action
        fail: human           # supervisor couldn't fix it, ask the human
        max_turns: human      # supervisor ran out of turns
        timeout: human        # supervisor took too long
        error: human          # supervisor crashed
```

`human` is a routing shorthand like `first`, `next`, `complete`. It auto-creates
a human action that inherits the context (what failed, supervisor's diagnosis,
the original action's history).

### Default escalation

The fallback for any unmatched condition is configurable:

```yaml
defaults:
  unmatched_condition: human    # if no edge matches, escalate to human
```

This means even if you forget to wire an edge for some exotic failure mode,
the system doesn't silently stop — it asks for help.

### Example: full escalation flow

```
auth.qa [max_turns] → auth.supervisor
  supervisor bumps max_turns to 120, retries qa → auth.qa runs again
auth.qa [fail] → auth.develop
  develop makes changes → auth.eval [pass] → auth.deploy → auth.qa
auth.qa [pass] → complete

# If supervisor itself fails:
auth.supervisor [timeout] → auth.human
  human gets push notification: "supervisor timed out on auth.qa"
  human responds: { action: "skip", note: "qa not needed for this task" }
  → auth.qa marked skipped → dependents unblocked
```

### Notifications

The human action triggers notifications through configured channels when it
activates. The notification includes:

- What action failed and why
- The supervisor's diagnosis (if supervisor ran before human)
- A link to the action in the web UI
- Available response options (continue, skip, abort, modify params)

This replaces the current intervention protocol (writing/polling JSON files)
with a proper API-driven flow.

## Information passing between actions

Actions produce outputs that successor actions need. The output model has two
fields:

### `output` — one JSON object, everything in it

A single JSON object stored in one column. Contains:

- **`status`** — the only field the executor reads (for edge condition matching)
- **`summary`** — human/agent-readable description of what happened
- **`notes`** — free-form guidance for the next action: file paths, queries,
  commands, caveats, explanations
- **...any other fields** the action type defines (`issues`, `passed_tests`, etc.)

```json
{
  "status": "failed",
  "summary": "Login timeout not handled in src/auth.ts:45",
  "issues": "The login form doesn't show a timeout error after 30s",
  "notes": "Screenshots at /data/auth.qa/mobile.png and desktop.png\nFull results: sqlite3 /data/auth.eval/results.db \"SELECT * FROM tests WHERE status='FAIL'\""
}
```

The executor reads `output.status` for routing. Everything else is payload
that gets injected into the successor's prompt. The action writes whatever
fields are useful — `notes` for pointing to artifacts and data, `issues` for
specific failures, or nothing beyond `status` and `summary` for simple actions.

### How the executor injects it

When running an action, the executor collects `output` from all predecessor
actions that triggered this activation:

```
## Previous actions

### auth.qa (fail)
Summary: Login timeout not handled in src/auth.ts:45
Issues: The login form doesn't show a timeout error after 30s
Notes:
  Screenshots at /data/auth.qa/mobile.png and desktop.png
  Full results: sqlite3 /data/auth.eval/results.db "SELECT * FROM tests WHERE status='FAIL'"
```

The successor agent reads the summary (in the prompt), follows the notes to
access artifacts and data (using Read, Bash, etc.), and decides how deep to
dig. The executor doesn't interpret any field except `status`.

### In the schema

```sql
  output JSON,           -- status, summary, notes, and type-specific fields
```

One column. The executor reads `output.status` for edge matching. Everything
else passes through to successors as prompt context.

## No subgraphs — just actions and edges

There is no "task" concept at the graph level. A task is an authoring shorthand — a
macro that expands into namespaced actions with edges between them.

When the user writes:
```yaml
tasks:
  - id: auth
    prompt: "Implement JWT auth..."
  - id: api
    prompt: "Implement REST API..."
    depends_on: [auth]
```

The expansion produces flat actions: `auth.develop`, `auth.eval`, `auth.deploy`,
`auth.qa`, `api.develop`, `api.eval`, `api.deploy`, `api.qa` — each with edges
derived from the workflow pattern. `depends_on: [auth]` becomes a direct edge
from `auth.qa [pass]` to `api.develop` (the terminal action of the dependency
to the first action of the dependent).

The executor sees no task boundaries. It just finds actions whose incoming edges
are all satisfied and runs them. Tags (`task:auth`, `task:api`, `stage:qa`) exist
for filtering in the UI and bulk API operations, but they're metadata, not
structural.

This means:
- Cross-task dependencies are just edges, same as intra-task edges
- You can create arbitrary edges between any actions, not just task-to-task
- A standalone action (not part of any task) can depend on `auth.eval` directly
- The UI groups by tag for display, but the graph is flat

## Where does state live?

### Option A: YAML file (current model extended)

tasks.yaml becomes a graph definition. Supervisor modifies the file on disk.

Problem: running state diverges from file. Race conditions. "What config produced this build?" is unclear.

### Option B: Server state only

Graph lives in memory / state.json. YAML is just the initial seed. Supervisor modifies state directly.

Problem: hard to inspect, version control, reproduce. Forensics are difficult.

### Option C: Template + instance (recommended)

The YAML file is a **template** — the initial graph definition. When a build starts, the template instantiates a **runtime graph**. The runtime graph executes and the supervisor modifies it. The template is never modified.

Like the relationship between a class and an instance, or a Docker image and a container.

- Template (YAML) = user's intent, version-controlled, reviewable
- Runtime graph (state.json) = execution reality, includes all modifications
- Can diff "what was planned" vs "what actually happened"
- Supervisor edits the instance, not the template

## Is this just "circuits"?

The analogy is strong:

| Circuit | Orca |
|---------|------|
| Gate | Action |
| Wire | Edge |
| Signal | Action output |
| Multiplexer | Conditional edge |
| Clock | Executor stepping through ready actions |
| FPGA reprogramming | Supervisor editing the graph |
| Schematic | Template (YAML) |
| Running circuit | Runtime graph |

But circuits are typically static, synchronous, and deterministic. An agent graph is mutable, async, and non-deterministic.

Closer analogs:
- **Petri nets** — tokens flow through places, transitions fire when inputs ready
- **Dataflow architectures** — nodes fire when inputs available
- **LangGraph** — agent workflows as graphs with conditional edges (but no self-modification)
- **Kubernetes operators** — controller reconciles state, can modify the plan

Orca v2 would be LangGraph + a controller node that can rewrite the graph. The "circuit" framing is useful for thinking about it, but the self-modifying property is the key differentiator.

## Implementation path

The full vision is ambitious. Incremental path:

**Phase 0 (current)**: Fixed workflow templates, live reload for budget params, supervisor can retry/skip/abort.

**Phase 1 — supervisor parameter editing**: Supervisor can modify action parameters at runtime (max_turns, max_cost, toolset). Alone, this fixes the QA turns problem. Small change: supervisor output includes parameter deltas, loop applies them before retry.

**Phase 2 — supervisor stage control**: Supervisor can remove/disable/reorder stages in the current task's workflow. Fixes the redundant eval problem. Medium change: supervisor sees workflow structure, produces stage mutations.

**Phase 3 — full graph model**: Arbitrary actions, conditional edges, supervisor as graph editor. YAML template compiles to runtime graph. Supervisor produces graph deltas. The big rewrite.

Phase 1 is small and high-value. Most of our recurring problems would be solved by a supervisor that can say "increase max_turns to 80 and retry."

## Complexity budget

The design must keep the simple case simple:

- If you have a linear task list with a standard workflow, the YAML should look exactly like it does today
- The graph machinery should be invisible unless you need it
- A user who never hits supervisor escalation never sees the graph model
- The web UI shows tasks in a list until the graph is complex enough to warrant a DAG view

Power when needed, simplicity by default.

## The server as a living graph executor

### Shift: from builds to a continuous graph

The current model has discrete "builds" — you start one, it runs, it completes or fails, you start another. This is the wrong primitive. The right primitive is:

**The server maintains a persistent, mutable action graph. Actions become ready when their dependencies are met. The executor continuously runs ready actions. There is no "start" or "finish" — there is only the graph, and whether it has work to do.**

A "build" in the current sense is just: load a YAML template, instantiate actions into the graph, let the executor run them. But the graph doesn't go away when those actions complete. You can:

- Add new actions at any time (via API or supervisor)
- They start executing immediately if their dependencies are already satisfied
- Pause the executor (all actions stop, graph persists)
- Resume (executor picks up where it left off)
- Modify running actions (change params, rewire edges)
- Never "restart" — just add/modify/remove actions in the living graph

This means the concept of a "build" becomes a **group** or **tag** on a set of actions, not a separate execution context. You could have multiple logical projects coexisting in the same graph, or one project's actions feeding into another's.

### What the server owns

The server is the single source of truth for:

1. **The graph** — all actions, their parameters, edges, and constraints
2. **Execution state** — which actions are running, pending, completed, failed
3. **History** — outputs from every completed action, costs, durations, logs
4. **Defaults** — templates for new actions (default model, toolset, scope, budget)

The YAML file becomes an **import format**, not the runtime representation. You load a YAML to seed the graph with actions, but after that, the graph lives on the server. You can export the current graph back to YAML for inspection or version control, but the server state is canonical.

### Persistence: SQLite with JSON columns

**Decision: SQLite.** Single file, zero configuration, embedded via `bun:sqlite`.

The graph structure is shallow — actions with edges between them, plus history per
action. Our query patterns are relational ("pending actions with deps met", "failed
actions tagged X", "total cost for project Y"), not graph traversal. We never need
pathfinding or deep transitive queries at runtime — the executor walks one dependency
level at a time.

A graph database (Neo4j, DGraph) would add a running service, JVM dependency, and
network overhead for query patterns that don't justify it.

#### Schema

```sql
CREATE TABLE actions (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL,           -- agent, command, gate, supervisor, human
  status TEXT NOT NULL,         -- pending, running, completed, failed, skipped, paused
  params JSON NOT NULL,         -- dynamic properties: prompt, command, max_turns, etc.
  output JSON,                  -- status, summary, notes, and type-specific fields
  tags JSON,                    -- ["project:orca", "sprint:12"]
  created_at TEXT,
  updated_at TEXT,
  started_at TEXT,
  completed_at TEXT,
  cost_usd REAL DEFAULT 0,
  iteration INTEGER DEFAULT 0
);

CREATE TABLE edges (
  id INTEGER PRIMARY KEY,
  from_action TEXT NOT NULL REFERENCES actions(id),
  to_action TEXT NOT NULL REFERENCES actions(id),
  condition TEXT,               -- predicate: "status == 'passed'", null = unconditional
  UNIQUE(from_action, to_action, condition)
);

CREATE TABLE history (
  id INTEGER PRIMARY KEY,
  action_id TEXT NOT NULL REFERENCES actions(id),
  iteration INTEGER,
  event_type TEXT,              -- stage_start, stage_end, tool_use, invoke_end, etc.
  data JSON,
  timestamp TEXT
);

CREATE INDEX idx_actions_status ON actions(status);
CREATE INDEX idx_actions_type ON actions(type);
```

#### Dynamic properties in JSON

Action-type-specific fields live in `params` as JSON. No schema-per-type, no
migrations when adding new params:

```json
// agent action
{"prompt": "Fix the login bug...", "model": "opus", "max_turns": 80,
 "toolset": "all", "scope": {"writable": ["src/**"]}}

// command action
{"command": "bun test", "timeout": 120, "parser": "exit_code"}
```

SQLite's native JSON support handles queries and updates:

```sql
-- Supervisor bumps max_turns
UPDATE actions SET params = json_set(params, '$.max_turns', 80) WHERE id = 'qa';

-- Filter by tag
SELECT * FROM actions WHERE EXISTS (
  SELECT 1 FROM json_each(tags) WHERE value = 'project:orca'
);
```

#### The executor's hot query

The core query — "what's ready to run?" — is a single join:

```sql
SELECT a.* FROM actions a
WHERE a.status = 'pending'
AND NOT EXISTS (
  SELECT 1 FROM edges e
  JOIN actions dep ON dep.id = e.from_action
  WHERE e.to_action = a.id
  AND dep.status != 'completed'
);
```

Sub-millisecond at our scale (hundreds to low thousands of actions).

#### Why not alternatives

- **JSON files** (current state.json): no concurrent access, unwieldy at scale,
  no query support. Fine for v1, wrong for a persistent living graph.
- **Graph DB**: operational complexity (separate service, JVM), query patterns
  don't justify it, breaks the "single file, zero deps" property.
- **Append-only log**: good auditability but more complex. Could layer on top of
  SQLite later (WAL mode already gives append-only properties).

The entire graph state is one `.sqlite` file — portable, inspectable with standard
tools (`sqlite3` CLI), trivial to backup and restore.

### API surface

The server exposes the graph through REST endpoints. Everything is a graph mutation or query.

#### Graph manipulation

```
POST   /actions              — add action(s) to the graph
GET    /actions              — list actions (with filters: status, tag, type)
GET    /actions/:id          — get action details + history
PATCH  /actions/:id          — modify action params, edges, constraints
DELETE /actions/:id          — remove action from graph

POST   /actions/:id/retry    — reset a failed action to pending
POST   /actions/:id/skip     — mark action as skipped, unblock dependents

POST   /edges                — add edge between actions
DELETE /edges/:id            — remove edge

POST   /import               — load a YAML template into the graph (adds actions + edges)
GET    /export               — export current graph as YAML
```

#### Execution control

```
POST   /executor/pause       — pause all execution
POST   /executor/resume      — resume execution
GET    /executor/status      — running/paused, actions in flight, queue depth

POST   /actions/:id/pause    — pause a specific action (finish current, don't advance)
POST   /actions/:id/resume   — resume a specific paused action
```

#### Observation

```
GET    /actions/:id/logs     — JSONL events for an action
GET    /actions/:id/output   — structured output from last execution
GET    /history              — global event feed
GET    /stats                — aggregate costs, durations, pass rates

SSE    /events               — live stream of all graph mutations and action completions
SSE    /actions/:id/events   — live stream for a specific action
```

#### Defaults and templates

```
GET    /defaults             — current default params for new actions
PATCH  /defaults             — update defaults (model, toolset, scope, budget)

GET    /templates            — list available YAML templates
POST   /templates/:name      — instantiate a template into the graph
```

### How "add a task" works

Today: edit tasks.yaml, restart the build (or hope live-reload picks it up).

In the new model:

```bash
# Add a single action
curl -X POST /actions -d '{
  "id": "fix-login-bug",
  "type": "agent",
  "prompt": "Fix the login timeout bug in src/auth.ts...",
  "depends_on": [],
  "tags": ["sprint-12"]
}'
# It starts executing immediately — no dependencies, executor picks it up.

# Add an action that depends on another
curl -X POST /actions -d '{
  "id": "test-login-fix",
  "type": "command",
  "command": "bun test src/auth.test.ts",
  "depends_on": ["fix-login-bug"]
}'
# Queued until fix-login-bug completes successfully.
```

Or load a batch from YAML:

```bash
curl -X POST /import -d @new-features.yaml
# All actions and edges from the file are added to the graph.
# Actions whose dependencies are already satisfied start immediately.
```

### How "restart with different config" works

Today: stop the build, edit YAML, start fresh.

In the new model: modify the action in place.

```bash
# Change max_turns on the qa action
curl -X PATCH /actions/qa -d '{"params": {"max_turns": 80}}'

# Remove the redundant eval override
curl -X DELETE /actions/eval-grep-check

# Retry the failed action with new params
curl -X POST /actions/qa/retry
```

No restart. No re-running completed work. Just mutate and continue.

### Grouping and "projects"

Without discrete builds, we need a way to group related actions. Tags serve this purpose:

- Every action can have tags: `["project:orca", "sprint:12", "feature:web-ui"]`
- The UI filters by tag to show a "project" view
- Import from YAML auto-tags all actions with the template name
- Stats aggregate by tag: "total cost for project:orca this week"

A "build" in the current sense maps to: `POST /import` with a YAML file, all actions tagged with the build name. The UI shows actions filtered by that tag. But the actions are just actions in the graph — they coexist with everything else.

### Scheduler

The scheduler evaluates the graph and decides what to run next. It's the
bridge between the graph (data) and execution (work).

**v1: serial, chain-at-a-time.** The scheduler picks one ready action, runs
it to completion, evaluates the resulting edges, and picks the next. When a
chain dead-ends (action completes with no outgoing edges, or reaches
`complete`), the scheduler moves to the next chain that has ready actions.

```
Scheduler loop:
  1. Find all actions in `pending` whose incoming edges are all satisfied
  2. Pick one (priority: continue current chain if possible, else start next)
  3. Run it to completion
  4. Classify result → match edge condition → activate successor
  5. If successor exists: go to 3 (continue chain)
  6. If chain dead-ended: go to 1 (find next chain)
  7. If nothing is pending: idle (wait for new actions or retries)
```

"Continue current chain" means: if the action we just ran has a successor
that's now ready, run that next rather than switching to a different chain.
This keeps related work together — develop → eval → qa for one task runs
sequentially before moving to the next task. Same behavior as v1 orca.

**Why serial first:**
- Simpler to debug (one action at a time, deterministic ordering)
- No filesystem isolation needed (no worktrees)
- No port allocation for parallel deploy/QA
- No merge conflicts
- No API rate limit concerns
- Easy to reason about in the UI (one active action, clear queue)

**Future: parallel scheduler.** The same interface, different strategy.
Instead of picking one ready action, pick all of them (up to a concurrency
limit). Each runs in a git worktree for filesystem isolation. Merges are
serialized. This is an executor config change, not a graph model change —
the graph doesn't know or care whether actions run serially or in parallel.

```yaml
scheduler:
  mode: serial              # v1: one action at a time
  # mode: parallel          # future: concurrent with worktree isolation
  # max_concurrent: 3       # future: concurrency cap
```

The scheduler is a pluggable component. The graph model, edge routing,
action types, and API are all independent of the scheduling strategy.

### What this changes about the web UI

The dashboard shifts from "list of builds" to "the graph":

- Default view: all actions, filterable by tag/status/type
- Action detail: params, history, logs, outputs, edges
- Live execution: which actions are running, what's queued, what's blocked
- Graph view (optional): visual DAG for complex dependency chains
- No "create build" form — instead, "import template" or "add action"
- The supervisor's graph edits are visible as mutations in the history

### What we keep from v1

- YAML as an authoring format (templates)
- The action types (agent, command, eval/gate) — just generalized
- Per-action scope, toolset, budget constraints
- JSONL logging per action
- SSE for live updates
- Intervention protocol (human action type)
- Git integration (snapshot/commit as command actions)
- Notification channels

### What changes from v1

- No "builds" as a concept — just actions in a graph
- No fixed workflow (pre/loop/post) — edges define the flow
- Supervisor can edit the graph, not just retry/skip/abort
- Server is the source of truth, not the YAML file
- Persistence moves from JSON files to SQLite
- API is graph-centric, not build-centric
