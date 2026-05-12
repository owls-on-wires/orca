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

```yaml
templates:
  supervisor:
    actions: [diagnose]
    types:
      diagnose:
        type: agent
        max_turns: 40
        toolset: all
        tags: ["type:supervisor"]
        params:
          prompt: >
            An action has failed with no recovery edge.

            The orca API is at http://localhost:7072.
            Read http://localhost:7072/llms.txt for the API reference.

            Check params.failed_action and params.failed_condition
            for context about what failed.

            Steps:
            1. Read the failed action's detail and logs:
               curl -s http://localhost:7072/actions/{failed_action} | jq .
               curl -s http://localhost:7072/actions/{failed_action}/logs | jq .
            2. Read the source code the action was working on.
            3. Diagnose the root cause.
            4. Handle based on failure condition:

               FOR TIMEOUT / MAX_TURNS / COST_EXCEEDED:
               Check the action's history and iteration count. If the
               agent was making progress (tests improving across iterations),
               bump the budget and retry. If no progress (same errors
               repeating), return "failed" with notes.

               FOR FAIL / ERROR / STUCK:
               Fix the underlying issue — edit source code, fix test
               expectations, update config. Then retry the action:
               curl -X POST http://localhost:7072/actions/{failed_action}/retry

            5. Report status: "passed" after fixing and retrying.
               Report status: "failed" if the issue cannot be resolved.

tasks:
  - id: supervisor
    template: supervisor
```

The supervisor sits inactive until the fallback activates it.

## Supervisor prompt guidelines

The supervisor prompt should:
- Reference the orca API (`/llms.txt` for full reference)
- Tell the agent to read failure context from its own params
- Distinguish between budget failures (retry with more runway) and
  code failures (fix and retry)
- Specify how to use the API to retry actions
- Include project-specific context (tech stack, conventions) so the
  supervisor can fix code effectively

Avoid making the supervisor's max_turns too high (30-40 is enough).
The supervisor should diagnose and fix quickly, not get stuck in
extended debugging loops.

## Error vs fail

- **fail**: The agent explicitly returned `status: "failed"`.
  It tried and reported failure. Retry often makes sense.
- **error**: The agent returned malformed output (`status: "unknown"`
  or missing). Something went wrong with execution. May need
  prompt adjustment or investigation.
- **stuck**: Same output repeated 3 times. The agent is in a loop.
  May need prompt changes or a different approach.
- **timeout**: Wall-clock or command timeout. May need more time
  (increase wall_timeout) or the agent/command is hung.

This distinction matters for edge routing. Templates typically
route `fail` back to develop (retry), but `error` and `stuck`
may warrant supervisor intervention or routing to a different action.

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
may idle if nothing else is pending.

## Failure edge best practices

Define edges for all 7 conditions on critical actions, even if
most route to the same place:

```yaml
eval:
  edges:
    fail: develop
    error: develop
    stuck: develop
    timeout: develop
    cost_exceeded: develop
    max_turns: develop
```

This prevents unnecessary supervisor activation. Reserve the
supervisor for truly unexpected failures where no explicit edge
exists. The supervisor is a safety net, not the primary retry
mechanism.
