# Orca v2 — TODO

## UI

- [x] Graph container now updates content bounds on every redraw so new action chains are scrollable — `contentBounds.totalW` is recalculated without resetting viewport position
- [x] Sidebar auto-follows the currently executing action — on graph refresh, if user hasn't manually clicked a node, the sidebar selects the running action. Manual click sets `userManuallySelected` flag; deselecting clears it.
- [x] Sidebar: StructuredOutput tool calls filtered from tool list (output already shown in Output section)
- [x] Sidebar: Params rendered as structured key/value (auto-expanded). `prompt` key shows "view prompt" link that opens a page-centered modal with the full prompt in monospace. Modal closes on × button, overlay click, or Escape. Numbers/booleans highlighted in accent color.
- [x] Sidebar no longer affects graph height — app uses `height: 100vh` with `overflow: hidden`, grid constrains both children to the same row height, detail panel scrolls internally via `overflow-y: auto` + `min-height: 0`
- [x] Sidebar: wall-clock duration — completed actions show total time (e.g. "35.2s"), running actions show a live counter updated every second
- [x] Sidebar: edge list split into "depends on" (incoming pass), "on pass" (outgoing pass), "on fail" (outgoing non-pass), "retry from" (incoming non-pass) sections
- [x] Sidebar: widened to 570px
- [x] Replaced graph polling with SSE-driven refresh — removed 3-second `setInterval`. Graph now refreshes on SSE `action_started`/`action_completed`/`action_waiting` events, on SSE reconnect after a gap, and on `visibilitychange` (tab visible). Disconnect display delayed 5 seconds — brief reconnect gaps are invisible. `events.ts` tracks disconnect state with `onReconnect` callback.

## Server

- [x] `POST /groups` endpoint — create a full task chain from a template in one call. Accepts `{ id, template, project_id, prompt?, after?, depends_on?, overrides?, tags? }`. Reads templates from project.orca.yaml on disk. Expands template into actions + edges, wires `after`/`depends_on` edges. Returns created action IDs.
- [x] Make `prompt` optional on tasks — `V2TaskConfig.prompt` is now `string | undefined`. If prompt is missing from both the task AND the template type's `params.prompt` AND overrides, throws validation error during expansion. Template-level prompts survive when task omits prompt.
- [x] Make `project_id` required on `POST /actions` — returns 400 if missing.

## Executor

- [x] Fix `invokeSimple` swallowing valid structured output — `invokeSimple` now prefers a result with non-null `structured_output` over one without. Prevents the SDK's spurious second result from overwriting valid output.
- [x] Handle "unknown" agent output gracefully — unknown/missing status from agent output now classifies as `error` condition (not `fail`). `fail` = agent explicitly reported failure; `error` = malformed/unexpected output.
- [x] Default fail/error edges for dynamically-created actions + Global fallback supervisor — when an action completes with a non-pass condition and has no matching outgoing edge, the executor looks for an action tagged `type:supervisor` in the same project and activates it with failure context (`failed_action`, `failed_condition`, `failed_output` injected into params). If no supervisor exists, fires `onUnhandledFailure` callback (SSE `unhandled_failure` event). Pass conditions with no edges do NOT escalate. Supervisor can be re-activated on subsequent failures. Escalation is recorded in action history.

## API Docs and Agent Self-Discovery — DONE

How it works:

    GET / returns a discovery document:

    {
      "name": "orca",
      "version": "2.0.0",
      "docs": {
        "llms": "llms.txt",
        "openapi": "openapi.yaml",
        "changelog": "...",
        "guides": {
          "dynamic-tasking": "/docs/guides/dynamic-tasking.md",
          "templates": "/docs/guides/templates.md"
        }
      }
    }

    The key files served from /docs/:

    - /docs/llms.txt — The LLM-optimized reference. This is the one the planner agent reads. It is essentially a general overview, as well as table of contents for the more specific documentation. It shouldn't need frequently updated; it should note locations of docs, general system overview, requirements like auth or rate limits, etc. It's a concise, prompt-friendly document: Written for an LLM audience, not a human one.
    - /docs/openapi.yaml — The full OpenAPI spec, served directly from the schemas/ directory. Machine-readable, complete.
    - /docs/guides/dynamic-tasking.md — How to use POST /groups, how to chain planners, template selection, etc.
    - /docs/guides/common-patterns.md - Commonly used patterns, etc.

    Best implementation:

    1. The server already has handleRoot returning HTML. Change it to content-negotiate: if Accept: application/json, return the discovery JSON. Otherwise return the HTML dashboard link.
    2. Add a GET /docs/* route that serves static files from a docs/ directory in the server package. The llms.txt and guides live there as regular files — easy to update alongside the code.

    What the planner prompt shrinks to:

    Instead of the massive prompt documenting every API call, the planner just gets:

    The orca orchestrator API is at http://localhost:7072.
    Read http://localhost:7072/llms.txt.

    One line. The agent fetches llms.txt on its first turn, gets the complete API reference, and proceeds. Any API changes are immediately visible — no fixture updates, no skill file syncing, no ORCA-API.yaml to copy around.

    The llms.txt convention is emerging as a standard (similar to robots.txt for crawlers). Having it at a well-known path means any LLM-powered tool can discover your API without prior configuration.
