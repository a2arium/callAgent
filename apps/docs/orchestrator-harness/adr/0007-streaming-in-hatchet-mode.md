# ADR 0007: Streaming In Hatchet Mode

## Status

Proposed

## Context

In the in-process driver, a segment usually runs in (or close to) the API host
process, and canonical runtime stream events reach SSE/chat consumers through the
existing event bus and outbox (see `apps/docs/17-runtime_streaming_contract.md`).

In Hatchet mode, `aplret.segment` runs on an **arbitrary remote worker**, while
the SSE/chat connection is held by the API host. `ctx.reply`, `ctx.progress`,
artifact deltas, and other canonical events are produced on the worker, not the
host. Something must carry them back to the connection.

Hatchet offers a native streaming primitive (`put_stream` + run-ref stream
consumption, with the backend acting as proxy). Adopting it would introduce a
*second* streaming path parallel to the canonical contract, keyed by Hatchet run
id rather than `taskId`/`seq`.

## Decision

Do **not** use Hatchet's native `put_stream` for agent-visible streaming. Keep
the canonical runtime stream contract unchanged:

- Segments publish canonical runtime events to the existing `IEventBus` exactly
  as today.
- The API host subscribes to the task's stream channel and projects to
  SSE/chat/CLI exactly as today.
- The outbox remains the durable delivery record (reconciled per ADR 0006).

The only thing that changes is **where** the publisher runs (a worker), not the
contract or the projection.

### Required consequence: cross-process event bus

When Hatchet mode is enabled, the in-memory event bus is insufficient because the
publisher (worker) and the subscriber (API host) are different processes. Hatchet
mode therefore **requires a cross-process bus** (NATS JetStream via
`@a2arium/callagent-eventbus-nats`, or equivalent). The in-process driver may
continue to use the in-memory bus.

This becomes a deployment precondition:

```text
driver = in-process  -> in-memory bus is fine
driver = hatchet      -> cross-process bus (NATS) is required for live streaming
```

## Consequences

- One streaming contract across both drivers; no Hatchet-run-id streaming path.
- Replay, visibility (public/debug/private), and finality rules are unchanged.
- Enabling Hatchet implies provisioning a durable cross-process bus; this is
  added to the ops checklist and the worker-runtime spec.
- Workers must be able to publish to the bus (network + credentials), which is
  part of worker bootstrap (`specs/worker-runtime.md`).

## Alternatives considered

- **Hatchet `put_stream` + proxy:** rejected. It forks the canonical contract,
  re-keys events by run id, and splits visibility/replay logic.
- **Worker returns the full transcript at segment end:** rejected. It breaks
  incremental streaming (typing/progress/artifact deltas) that the contract and
  chat bridge already support.

## Open Validation

- Parity test: SSE/chat output for a task is identical under in-process and
  Hatchet drivers (same canonical events, ordering, visibility).
- Confirm worker -> NATS -> API host -> SSE path under load and reconnect
  (`Last-Event-ID` replay still works).
