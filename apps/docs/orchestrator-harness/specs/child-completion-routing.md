# Child Completion Routing

## Status

Child completion is fully routed through the durable task-turn coordinator.
`TaskEngine` never calls `TaskExecutor.executeTurn` or `TurnRunner.runTurn`.
`TurnRunnerSegmentExecutor` is the sole loop-mode entry to agent code.

## Delivery modes

Every child terminal claim declares one internal delivery mode:

- `inline`: blocking `awaitCompletion:true` calls terminalize the token and
  preserve one correlated observation for the currently owned loop. They do
  not advance the requested generation, record a wake key, or create a
  dispatch intent.
- `async_wake`: runtime terminal callbacks terminalize the token, stage the
  observation, advance one generation, record the processed wake key, and
  create the dispatch intent in one snapshot CAS.

Completion, failure, and timeout use the same terminal coordinator. A matching
replay may republish the deterministic runtime nudge, but it does not advance
another generation. Competing or late outcomes cannot publish a parent wake.

## Runtime ownership

The in-process runtime publishes through `onTaskTerminal`. Hatchet reloads the
child's durable terminal record inside keyed `aplret.task-state`, claims the
parent token with `async_wake`, and publishes `aplret.child.<token>`. Neither
surface trusts a stale process-local task entity or segment boundary.

The runtime nudge always re-enters coordinator admission. `terminal_replay`,
`matching_replay`, `queued`, and `superseded` are authoritative non-executing
results and never fall through to raw turn execution.

## Idempotency key

`${parentTaskId}:child:${token}` — align with ADR 0009 per-effect keys.
