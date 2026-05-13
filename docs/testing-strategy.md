# Testing Strategy: Catching Bugs Before Live Runs

Analysis of the 9 foundational bugs discovered during real pipeline runs,
and how each could have been caught during development.

---

## Bug-by-Bug Analysis

### 1. project_dir resolving to server cwd

**What happened:** `expandConfig` with `sourceDir=undefined` resolved
`project_dir: "."` to the server's working directory, not the project's.

**Why tests didn't catch it:** All config tests called `expandConfig(yaml, db)`
without sourceDir. They didn't assert on the resolved project_dir value —
they only checked that actions and edges were created correctly.

**How to catch it:**
- **Integration test:** Import a config via the HTTP API with `{ yaml: "..." }`
  from a temp directory, then assert that the project record's `project_dir`
  matches the temp directory, not `process.cwd()`.
- **Fixture test:** The calculator/todo-api fixtures should import via the
  server's `POST /import { dir: ... }` endpoint (not direct `expandConfig`
  calls) and verify the project record.
- **Validation rule (already implemented):** Reject relative `project_dir`
  without `sourceDir`.

**Test to add:**
```typescript
test("POST /import { yaml } without source_dir is rejected", async () => {
  const { status } = await post("/import", { yaml: YAML_WITH_RELATIVE_DIR });
  expect(status).toBe(400);
});

test("POST /import { dir } resolves project_dir correctly", async () => {
  const tmpDir = mkdtempSync(...);
  writeFileSync(join(tmpDir, "project.orca.yaml"), YAML);
  await post("/import", { dir: tmpDir });
  const proj = db.getProject("test");
  expect(proj.project_dir).toBe(tmpDir); // not process.cwd()
});
```

---

### 2. nix-shell command mangling

**What happened:** `buildNixCommand` for shell.nix joined argv with spaces
(`innerCmd.join(" ")`), destroying shell quoting. `sh -c "cd x && cmd"`
became `sh -c cd x && cmd`.

**Why tests didn't catch it:** The nix.test.ts tests verified the returned
command array structure but never actually executed the commands. They
checked `["nix-shell", path, "--run", expectedString]` but didn't verify
that `expectedString` was correctly quoted for shell interpretation.

**How to catch it:**
- **Execution test with a real nix shell:** Create a temp dir with a
  minimal shell.nix, run a compound command through `buildNixCommand`,
  execute it, and verify the output.
- **Property test:** For any innerCmd containing spaces or special characters,
  the command produced by `buildNixCommand` should execute identically
  to running innerCmd directly in a nix-shell.

**Test to add:**
```typescript
test("shell.nix wrapping preserves compound commands", () => {
  const tmpDir = mkdtempSync(...);
  writeFileSync(join(tmpDir, "shell.nix"), MINIMAL_SHELL_NIX);
  writeFileSync(join(tmpDir, "test.txt"), "hello");

  // This is the exact pattern action-runner uses
  const innerCmd = ["sh", "-c", "cd " + tmpDir + " && cat test.txt"];
  const cmd = buildNixCommand(tmpDir, undefined, innerCmd);

  const result = Bun.spawnSync(cmd, { cwd: tmpDir });
  expect(result.stdout.toString().trim()).toBe("hello");
});
```

**Root fix (already implemented):** Don't use buildNixCommand for command
actions at all — use resolveNixEnv to capture env vars and pass them
directly.

---

### 3. nix env not applied to command actions

**What happened:** Command actions only used nix wrapping when `options.nix`
was explicitly set. Auto-detection (checking for flake.nix/shell.nix)
only worked for agent actions via `resolveNixEnv`.

**Why tests didn't catch it:** The action-runner tests mock `invokeSimple`
for agent actions and use simple commands like `echo` and `true` for
command actions. No test verified that a command action could find
binaries provided by a nix shell.

**How to catch it:**
- **Fixture with nix dependency:** Create a fixture project with a
  shell.nix that provides a specific binary (e.g., `jq`). Define a
  command action that uses that binary. Run it through the executor
  and verify it succeeds.
- **Unit test:** Verify that `runCommandAction` passes nix env to
  `Bun.spawn` when the project has a shell.nix.

**Test to add:**
```typescript
test("command action inherits nix environment", async () => {
  const tmpDir = mkdtempSync(...);
  writeFileSync(join(tmpDir, "shell.nix"), NIX_WITH_JQ);

  const action = commandAction({ params: { command: "jq --version" } });
  const result = await runAction(action, [], { projectDir: tmpDir });

  expect(result.condition).toBe("pass");
  expect(result.output.stdout).toContain("jq-");
});
```

---

### 4. SDK generator hang

**What happened:** The Claude Agent SDK's async generator sometimes never
terminates after producing a valid result.

**Why tests didn't catch it:** Unit tests mock `invokeSimple`. Live agent
tests don't run long enough to hit the hang (it's probabilistic and
more likely with long-running Opus invocations).

**How to catch it:**
- **Not easily caught by unit tests** — this is a third-party SDK bug.
- **Timeout test:** Verify that the watchdog + wall timeout always
  eventually resolves. Create a mock that simulates a hung generator
  (never yields after invoke_end appears in JSONL) and verify the
  watchdog force-resolves.
- **Inactivity timeout test (not yet implemented):** Verify that if no
  tool_use events appear for N seconds after invoke_start, the system
  kills and retries.

**Test to add:**
```typescript
test("watchdog force-resolves when generator hangs after invoke_end", async () => {
  // Mock invokeSimple to never resolve
  mockInvokeSimple.mockImplementation(() => new Promise(() => {}));

  // Write a fake invoke_end to the JSONL log
  const logPath = join(tmpDir, "test.jsonl");
  setTimeout(() => {
    appendFileSync(logPath, JSON.stringify({
      event_type: "invoke_end",
      structured_output: { status: "passed", summary: "done" },
      cost_usd: 0.1, num_turns: 3, duration_ms: 5000,
    }) + "\n");
  }, 100);

  const result = await invokeWithWatchdog({ ..., logPath }, undefined);
  expect(result.output.status).toBe("passed");
}, 30000);
```

---

### 5. Null output overwrite from SDK

**What happened:** SDK yielded two result messages. The second had
`structured_output: null`, overwriting the valid first result.

**Why tests didn't catch it:** Mocked `invokeSimple` returns a single
result. The real `invoke()` generator was never tested with multiple
result events.

**How to catch it:**
- **Generator test:** Test `invoke()` directly (not `invokeSimple`) with
  a mock SDK that yields two result messages, second with null output.
  Verify the first (non-null) result is preserved.

**Test to add:**
```typescript
test("invokeSimple prefers result with non-null output", async () => {
  // Mock the SDK to yield two results
  const events = [
    { type: "result", result: { output: { status: "passed" }, costUsd: 0.1, ... } },
    { type: "result", result: { output: null, costUsd: 0.1, ... } },
  ];
  // ... verify invokeSimple returns the first result
});
```

---

### 5b. Null output overwrite in invoke() generator (not just invokeSimple)

**What happened:** The `invoke()` generator at `invoke.ts:225` overwrites
`structuredOutput` with every SDK result message unconditionally. The SDK
yields multiple result messages (up to 4 observed), where only the first
has valid `structured_output`. Subsequent results have `null`, overwriting
the valid output. The final `yield` at line 242 then emits `output: null`.

This is different from bug #5 (which was fixed in `invokeSimple`). The
fix in `invokeSimple` only works when `invoke()` yields multiple result
events — but `invoke()` consolidates all SDK results into a single final
yield, so `invokeSimple` only ever sees one event.

**Impact:** Sprint QA for codream passed (94/94 tests, all browser features
verified, $2.06 spent) but was classified as "error" with status "unknown"
because the structured output was nulled out.

**Why tests didn't catch it:** Same as bug #5 — mocked `invokeSimple`
bypasses the real `invoke()` generator. No test exercises `invoke()`
with multiple SDK result messages.

**How to catch it:**
- **Generator-level test:** Test `invoke()` directly with a mock SDK
  `query()` that yields multiple result messages, some with null output.
  Verify the generator's final yield preserves the non-null output.

**Test to add:**
```typescript
test("invoke() preserves non-null output when SDK yields multiple results", async () => {
  // Mock SDK query to yield:
  // result { structured_output: { status: "passed" } }
  // result { structured_output: null }
  // result { structured_output: null }
  const events = [];
  for await (const event of invoke(mockOptions)) {
    events.push(event);
  }
  const resultEvent = events.find(e => e.type === "result");
  expect(resultEvent.result.output).not.toBeNull();
  expect(resultEvent.result.output.status).toBe("passed");
});
```

---

### 6. Worker thread in compiled binary

**What happened:** Bun's compiled binary uses `$bunfs` virtual filesystem.
`new Worker(url)` can't resolve URLs inside `$bunfs`.

**Why tests didn't catch it:** Tests run from source (`bun test`), not
from the compiled binary. The Worker works fine from source.

**How to catch it:**
- **Compiled binary test:** Add a CI step that compiles the binary
  (`bun build --compile`), then runs a smoke test: start the server
  from the compiled binary, import a fixture, verify executor starts.
- **Alternative:** Accept this as a known Bun limitation and fall back
  to inline executor when Worker fails (detect and handle gracefully).

**Test to add (CI script):**
```bash
bun run build
./bin/orca serve --port 0 &
sleep 2
curl -sf localhost:$PORT/health | jq .state
# Should show "running" or graceful fallback
kill %1
```

---

### 7. Self-loop edges

**What happened:** Config expansion created edges like `fail → first`
where `first` was the current action, causing infinite retry loops.

**Why tests didn't catch it:** Config tests verified edge counts and
basic routing but didn't check for self-referential edges.

**How to catch it:**
- **Validation test:** After config expansion, scan all edges and assert
  none have `from_action === to_action`.

**Test to add (already implemented in config expansion):**
```typescript
test("no self-loop edges are created", () => {
  expandConfig(yaml, db, "/tmp");
  const actions = db.listActions();
  for (const a of actions) {
    const edges = db.getEdgesFrom(a.id);
    for (const e of edges) {
      expect(e.to_action).not.toBe(e.from_action);
    }
  }
});
```

---

### 8. Missing project_id column (no DB migration)

**What happened:** DB created before the projects table was added to the
schema. `CREATE TABLE IF NOT EXISTS` doesn't add columns to existing
tables.

**Why tests didn't catch it:** Tests always use `:memory:` databases
(fresh schema). No test simulates opening an existing DB with an
older schema.

**How to catch it:**
- **Migration test:** Create a DB with the old schema (no projects table,
  no project_id column), then open it with `OrcaDatabase`. Verify it
  either migrates or throws a clear error.
- **Schema version tracking:** Store a version number in the DB. On
  open, check version and run migrations if needed.

**Test to add:**
```typescript
test("opening old-schema DB fails with clear error or migrates", () => {
  const dbPath = join(tmpDir, "old.db");
  const raw = new Database(dbPath, { create: true });
  raw.exec("CREATE TABLE actions (id TEXT PRIMARY KEY, type TEXT, status TEXT)");
  raw.close();

  // Should either migrate or throw a meaningful error
  expect(() => new OrcaDatabase(dbPath)).not.toThrow(/SQLITE_ERROR/);
});
```

---

### 9. Broad eval command runs wrong tests

**What happened:** `bun test` (all tests) caused develop agents to retry
on failures from other tasks' tests, wasting iterations.

**Why tests didn't catch it:** This is a pipeline design bug, not an orca
code bug. No amount of orca testing catches bad eval commands in user
configs.

**How to catch it:**
- **Config validation warning:** When a command action's `command` field
  is just `bun test` or `pytest` (no file argument), emit a warning:
  "Eval command runs all tests. Consider scoping to a specific file."
- **Preflight check (see pipeline UX doc):** Before starting the
  executor, dry-run all command actions to verify they execute
  successfully in the project's environment.

---

## Recommended Testing Infrastructure

### 1. Fixture-based integration tests

Create a `tests/integration/` directory with small fixture projects:

- **nix-project/** — shell.nix providing a specific binary, command action
  that uses it. Tests nix env resolution end-to-end.
- **multi-task/** — 3 tasks with dependencies, eval commands that can
  pass or fail. Tests the full executor loop with real commands.
- **bad-config/** — Various malformed configs. Tests error messages.

Run these in CI alongside unit tests. They take longer (~30s each due
to nix) but catch the class of bugs that unit tests with mocks miss.

### 2. Compiled binary smoke test

Add a CI step that compiles the binary and runs basic operations:
import, status, serve, health check. Catches Bun compilation issues.

### 3. Command preflight testing

Before the executor starts, dry-run each command action in the project's
environment (run it, expect either success or a meaningful failure —
not "command not found"). This catches nix issues, wrong paths, and
missing tools before burning agent iterations.

### 4. Schema migration tests

Maintain a set of "old schema" SQL files. Test that opening each with
the current OrcaDatabase either migrates cleanly or errors clearly.

### 5. Property-based tests for config expansion

Generate random valid configs (varying task counts, template types,
dependency graphs). Verify invariants:
- No self-loop edges
- All actions have at least one incoming edge (except root actions)
- All edge targets exist
- project_dir is absolute
- Every agent action has a prompt
