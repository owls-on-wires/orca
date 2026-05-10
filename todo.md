# Orca v2 — TODO

## UI

- [ ] Graph container doesn't re-render when new action chains are added dynamically (can't scroll to see them); the graph updates but the scale/view container does not
- [ ] Sidebar should auto-follow the currently executing action (unless user has manually selected a different one)
- [ ] Sidebar: don't show detail for StructuredOutput tool calls (output is already displayed in the Output section)
- [ ] Sidebar: Params section should be auto-expanded and rendered as structured key/value (like Output), not raw JSON text. The `prompt` key should not display its value inline — instead show a "view prompt" link that opens a page-centered modal with the full prompt string, properly formatted.
- [ ] Sidebar: should not affect graph height when content overflows — scroll independently within fixed bounds
- [ ] Sidebar: show wall-clock duration (completed: total time, running: live counter)
- [ ] Sidebar: split edge list into 3 sections — "depends on" (incoming pass), "on pass" (outgoing pass), "on fail" (outgoing fail/error/stuck/etc.) — instead of a flat list of all edges
- [ ] Sidebar: widen to ~570px (currently 380px in `oc-app__body` grid-template-columns)
- [ ] Replace graph polling with SSE reconnect-and-refresh — remove the 3-second `setInterval` poll in `main.ts`. Instead, track SSE disconnect gaps in `events.ts`. On reconnect (`connected` event after an error), fetch full state: `GET /actions` (graph), `GET /health` (stats), and if a detail panel is open, `GET /actions/:id` + logs. Also refresh on `visibilitychange` when tab becomes visible. Only fetch when data might be stale, not continuously. Only show "SSE disconnected" in the footer if reconnect fails for more than ~5 seconds — brief reconnect gaps during tab switches should be invisible to the user.

## Server

- [x] `POST /groups` endpoint — create a full task chain from a template in one call. Accepts `{ id, template, project_id, prompt?, after?, depends_on?, overrides?, tags? }`. Reads templates from project.orca.yaml on disk. Expands template into actions + edges, wires `after`/`depends_on` edges. Returns created action IDs.
- [x] Make `prompt` optional on tasks — `V2TaskConfig.prompt` is now `string | undefined`. If prompt is missing from both the task AND the template type's `params.prompt` AND overrides, throws validation error during expansion. Template-level prompts survive when task omits prompt.
- [x] Make `project_id` required on `POST /actions` — returns 400 if missing.

## Executor

- [ ] Fix `invokeSimple` swallowing valid structured output — the Claude SDK sometimes yields two result messages: the first with a valid `structured_output` (e.g., `{status: "passed"}`), the second with `structured_output: null`. `invokeSimple` at `invoke.ts:257` blindly takes the last one, so the valid output is overwritten by null. The action runner then classifies the null output as `status: "unknown"` / condition `"fail"`, causing the action to fail despite the agent completing successfully. Fix: prefer a result with non-null `structured_output` over one without. This is the root cause of the spurious QA failures in the link-board fixture.
- [ ] Handle "unknown" agent output gracefully — when an agent returns `status: "unknown"` or a malformed structured output, the action runner should classify this as `error` (not `fail`), since the agent didn't explicitly fail — it just didn't produce a valid result. This distinction matters for edge routing: `fail` means "I tried and it didn't work" (retry makes sense), `error` means "something went wrong with the execution itself" (escalate or retry differently).
- [ ] Default fail/error edges for dynamically-created actions — actions created via `POST /actions` have no default edges (unlike actions from config expansion which get defaults for all 7 conditions). Consider: when an action has NO outgoing edges for a failure condition, the executor should either (a) retry the action in-place (up to max_iterations), or (b) escalate to a supervisor if one exists, or (c) pause the executor and emit an SSE event so a human/planner can intervene. Currently it silently stalls.
- [ ] Global fallback supervisor — when an action completes with a non-pass condition and has no matching outgoing edge, the executor should look for an action tagged `type:supervisor` in the project and activate it with context about the failure (failed_action ID, failed_condition, output). The supervisor uses the HTTP API to diagnose and fix the issue (update prompts, add edges, retry). This makes explicit error edges to the supervisor unnecessary — it's a catch-all safety net. The supervisor action is defined in the project YAML and sits inactive until needed.

after all this, update the api schema, and update all the claude code skill files in here entirely for orca v2.
