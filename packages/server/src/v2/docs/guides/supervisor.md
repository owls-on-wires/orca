# Supervisor & Recovery

How orca handles failures when no explicit edge routing exists.

## The global fallback

When an action completes with a non-pass condition (fail, error,
stuck, etc.) and has **no matching outgoing edge**, the executor
looks for a supervisor action to escalate to.

This means you don't need explicit error edges from every action
to the supervisor — it's a catch-all safety net.

## How it works

1. Action completes with condition "fail" (or error, stuck, etc.)
2. Executor calls `followEdges(action, "fail")`
3. No matching edges found
4. Executor searches for an action tagged `type:supervisor` in
   the same project
5. If found, activates the supervisor with failure context injected
   into its params:
   - `failed_action`: ID of the action that failed
   - `failed_condition`: the condition (fail, error, stuck, etc.)
   - `failed_output`: the action's output object
6. The supervisor runs and can fix the issue via the API

## Defining a supervisor

In project.orca.yaml:

```yaml
defaults:
  types:
    supervisor:
      type: agent
      max_turns: 40
      toolset: all
      params:
        prompt: >
          An action has failed with no recovery edge.
          Check params.failed_action and params.failed_condition.
          Use the orca API to diagnose and fix:
          1. Read the failed action: curl /actions/{failed_action}
          2. Check its logs: curl /actions/{failed_action}/logs
          3. Fix the issue (update prompt, add edges, fix code)
          4. Retry: curl -X POST /actions/{failed_action}/retry

tasks:
  - id: supervisor
    template: supervisor
```

The supervisor sits inactive until the fallback activates it.

## Error vs fail

- **fail**: The agent explicitly returned `status: "failed"`.
  It tried and reported failure. Retry often makes sense.
- **error**: The agent returned malformed output (`status: "unknown"`
  or missing). Something went wrong with execution. May need
  prompt adjustment or investigation.

This distinction matters for edge routing. Templates typically
route `fail` back to develop (retry), but `error` may warrant
supervisor intervention.

## Supervisor can be re-activated

If multiple actions fail, the supervisor is activated for each.
Its iteration count increments. The `failed_action` in params
always reflects the most recent failure.

## Escalation history

When the executor escalates to a supervisor, it records a history
entry on the failed action with event_type "escalated" and the
supervisor's ID. Check with:

```bash
curl /actions/{failed-action} | jq '.history[] | select(.event_type == "escalated")'
```

## SSE notification

The server broadcasts an `unhandled_failure` SSE event whenever
escalation occurs (whether or not a supervisor exists). The web
UI can use this to alert the user.

## When no supervisor exists

If no `type:supervisor` action exists in the project, the executor
fires the `onUnhandledFailure` callback (SSE event) but takes no
other action. The failed action stays failed, and the executor
may idle if nothing else is pending. Check the graph manually
and retry or fix as needed.
