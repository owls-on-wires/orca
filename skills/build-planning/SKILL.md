---
name: build-planning
description: Comprehensive guide for planning orca builds — task decomposition, eval strategy, budget estimation, and workflow selection. Activates when the user asks to build, implement, or automate a feature list.
user-invocable: false
---

# Build Planning Guide

## Do I Need Orca?

Not every task needs an orchestration loop. Use this decision tree:

| Situation | What to do |
|-----------|------------|
| User asks a question, brainstorms, discusses | Just answer. No orca. |
| User asks to make a single change, fix a bug, add one feature | Just do it directly. No orca. |
| User gives a short list in the prompt (3-4 items) | Do them sequentially yourself. No orca. |
| **User has a task list in a file (5+ items)** | **Use orca.** Write project.orca.yaml, run with `--detach`. |
| **Tasks need eval/test gating (implement → verify → iterate)** | **Use orca.** Even for 1-2 tasks. |
| **Work will take more than 10-15 minutes total** | **Use orca with `--detach`.** |

The key signals that cross the line into orca territory:
1. **File-based task list** — tasks are defined in a YAML/markdown file, not just mentioned in a prompt
2. **Eval gating** — each task needs to pass tests or metrics before the next one starts
3. **Long-running** — the total work will take long enough that the user would walk away

If none of these apply, just do the work directly. Orca is for sustained, multi-task, eval-gated work — not for quick changes.

---

## Planning an Orca Build

When orca IS the right tool, follow these steps:

### Step 1: Choose a Workflow Pattern

| Pattern | When to use | Workflow |
|---------|-------------|----------|
| **TDD** | Deterministic code: parsers, transforms, CRUD, data structures | `pre: [write_tests]`, `loop: [eval, analyze, develop]`, `post: [regression]` |
| **Metric** | Exploratory: numerical algorithms, ML, search, optimization | `loop: [eval, analyze, develop]` |
| **Maintainer** | Modifying large existing codebase | `pre: [understand, write_tests]`, `loop: [eval, analyze, develop]`, `post: [regression]` |
| **Simple** | Small tasks where the agent can self-diagnose | `loop: [eval, develop]` |

Include an `analyze` stage when eval output is complex (structured metrics, multiple dimensions). Skip it when eval is simple pass/fail — add "First diagnose the failures, then implement the fix" to the develop prompt instead.

Include `regression` when tasks modify shared code that could break earlier tasks.

### Step 2: Decompose Into Tasks

**One deliverable per task.** If a task description needs "and" — split it. A task should have one clear gate (tests pass OR metric met).

**Identify dependencies.** Use `depends_on` to express which tasks must complete first. Tasks with `depends_on: []` can start immediately.

**Isolate hard cases.** If one subtask is fundamentally harder, give it its own task with its own budget. Don't let it hold up the group.

**Order by dependency, then difficulty.** Prerequisites first, then simple tasks (build momentum), then complex ones.

### Step 3: Write Task Variables

For each task, write `variables` that the stage prompts will use:

**Always include:**
- `description` — what this task achieves (1-3 sentences)
- `develop_focus` — specific implementation guidance (list of bullet points)

**For TDD tasks, include:**
- `tests` — array of `{name, description}` for test cases
- Include at least one **negative test**: verify the code does NOT produce false positives

**For maintainer tasks, include:**
- `understand_focus` — areas of the codebase to study (list)
- `principle` — the core design constraint (single sentence)

**Always specify what NOT to do:**
- "Do NOT modify string literals"
- "Do NOT fall back to regex"
- "Never handle auth outside the middleware chain"

**Prescribe algorithms for hard problems.** If you know the right approach, specify it. Don't leave algorithmic choices to the agent. Example: "Use binned averaging for projection, not interpolation."

### Step 4: Design Evaluation

**Test-driven eval:** `command: "cargo test --test {task_id} 2>&1"` with `parser: cargo_test`

**Metric-driven eval:** `command: "python -m tests.eval_{task_id} --json"` with `parser: json`

**Test the eval command manually before building.** Run it, verify the output parses correctly for both passing and failing cases.

### Step 5: Set Budgets

Budget = expected iterations × 2:
- **1-2 expected:** straightforward → 4 iterations, $20
- **3-5 expected:** edge cases → 10 iterations, $50
- **8-15 expected:** algorithmic tuning → 20 iterations, $100

### Step 6: Configure Git and Scope

```yaml
git:
  enabled: true
  snapshot_before: develop
  commit_after: loop

scope:
  writable: ["src/**"]
  readable: ["**"]
```

### Step 7: Write project.orca.yaml and Run

Use `orca init --template <name>` as a starting point, customize, then:

```bash
orca run project.orca.yaml --detach
```

Always use `--detach` for multi-task builds. The build runs in the background. Use `/orca:status` to check progress.

### Pre-flight Checklist

- [ ] Each task has one deliverable and one gate
- [ ] Hard problems have prescribed algorithms
- [ ] Every task has negative constraints ("do NOT do X")
- [ ] TDD tasks have negative tests
- [ ] Iteration budgets are 2× expected difficulty
- [ ] The eval command works manually for both pass and fail
- [ ] Git is enabled with snapshot before develop
- [ ] Scope restricts writes to source files only

---

## Tips

**Mobile notifications:** Add a notification channel so you get push alerts when the build needs attention or completes. Use ntfy or a similar service (Pushover, Gotify) for free mobile push — no account needed:
```yaml
notifications:
  on_escalation: true
  on_build_complete: true
  channels:
    - type: command
      run: "curl -s -d '{message}' https://ntfy.sh/{build-name}-{6-letter-hash}"
```
Generate a unique topic from the build name plus a short random hash (e.g., `reason-index-c7e2d4`) to avoid collisions. Install the ntfy app on your phone and subscribe to the same topic.

**Live budget adjustment:** If a task is stuck and you want to give it more iterations, edit the `orca:` section at the bottom of `project.orca.yaml` while the build is running. It's re-read every iteration.

**Live task queue:** Tasks added to the YAML mid-build are picked up automatically at task boundaries. You can extend a running build without restarting it.

**Single-task debugging:** Use `orca run project.orca.yaml --task <id>` to run just one task in foreground (no `--detach`) for debugging. Useful when a task keeps failing.

**Tag filtering:** Use `--tag prerequisite` to run only prerequisite tasks first, verify they work, then run the full build.
