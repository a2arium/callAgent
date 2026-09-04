# ADR 0002: Durable Execution Mapping

## Status

Proposed

## Context

Hatchet durable tasks are deterministic control programs. The Hatchet docs state
that durable tasks should only wait (sleep/event) or spawn children; side effects
and non-deterministic work should be pushed into child tasks.

APLRET turns are intentionally non-deterministic: Execution can call LLMs,
tools, child agents, conversation APIs, and other external services. Therefore a
turn cannot run as Hatchet durable task code.

### Granularity decision: segment, not turn

There are two candidate granularities for the non-deterministic child task:

| Child = | Hatchet round-trips | Latency | Run count / cost | Verdict |
|---|---|---|---|---|
| one `oneTurn` | per APLRET turn | high | explodes | rejected |
| a **segment**: `runLoop` advanced to the next durable boundary (await/terminal) | per await/terminal only | low | bounded | **chosen** |

A "segment" is one execution of the existing `runLoop` that runs internal
`continue` turns in-process and returns only when it reaches a durable boundary:
`await_input` / `await_tool` / `await_child`, a sleep, or a terminal
`complete` / `fail`. Internal `continue` turns never cross the Hatchet boundary.

This is decisive: a Hatchet round-trip per internal `continue` turn would wreck
interactive latency and inflate run counts. The durable loop only re-engages at
boundaries the orchestrator actually needs to own (waits, sleeps, child spawns).

APLRET boundaries map onto Hatchet primitives:

| Segment boundary | Hatchet primitive |
|---|---|
| `await_input` | durable event wait |
| `await_tool` | durable event wait or child task |
| `await_child` | child spawning + wait |
| sleep / expiry | durable sleep |
| `complete` / `fail` | durable task returns |

(There is no `continue` row: `continue` is consumed inside the segment and never
reaches the durable task.)

## Decision

Use Hatchet durable tasks for control, not cognition:

```text
Hatchet durable task (deterministic control):
  spawn aplret.segment child
  inspect SegmentResult.boundary
  wait (event) / sleep / spawn child
  repeat until terminal

Hatchet regular child task (non-deterministic):
  TurnExecutor.runSegment(...)   # = runLoop to next durable boundary
```

This is the **execution DAG**, not the user-facing operator DAG. The operator
surface projects this into callAgent vocabulary: parent durable runs become
`AgentRun`, child agent calls become `AgentRunEdge`, segment children become
expandable `TurnRun` details, and effect children become hidden-by-default
`EffectRun` debug details.

The durable task may read only the child task result (a checkpoint output),
durable wait results, and small stable identifiers. It must not read snapshots,
call LLMs/tools, generate tokens/ids, read wall-clock time for control flow, or
run APLRET modules directly.

### Token provenance and determinism

Wake event keys are derived from pending tokens (e.g. `aplret.input.<token>`).
Tokens are generated **inside** the non-deterministic segment (e.g. by
`requestInput`) and returned in `SegmentResult.boundary` as a **checkpoint
output**. The durable task may establish a wait only from such checkpoint
outputs — never from a value it regenerates itself. This keeps the durable
control program deterministic on replay while letting cognition mint the tokens.

## Consequences

- Hatchet is used natively: durable sleep, event waits, child spawning, and
  per-task serialization.
- APLRET semantics remain centralized in the existing loop.
- Worker crashes around orchestration waits can resume from Hatchet checkpoints.
- A failed or retried turn child may be delivered more than once; callAgent
  idempotency and CAS remain mandatory.
- An expired segment claim is not ordinary successful supersession. CallAgent
  first commits a same-generation recovery dispatch, then lets the provider
  segment complete as a recovery handoff. The replacement keeps `turnSeq` and
  receives a new claim ID and fence.
- A bounded, indexed store scan repairs expiry when the original process dies
  before it can stage that handoff. Hatchet and in-process drivers invoke the
  same provider-neutral recovery transition.
- Hatchet task names (`aplret.task`, `aplret.segment`, `aplret.outbox.dispatch`)
  must not leak as the product vocabulary. They are raw execution primitives
  linked from the semantic `AgentRunGraph`.

## Open Validation

- POC B1 must kill a worker during `aplret.segment` and prove one effective
  snapshot transition, same-generation redelivery, and rejection of the stale
  claim's later commit/effects.
- POC B9 must prove child fan-out/fan-in while parent cognition remains in
  callAgent.
- POC B8 must confirm that internal `continue` turns stay in-process (no Hatchet
  round-trip per turn) and that segment latency is acceptable.
