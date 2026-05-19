# Ordering And Replay Spec

## Ordering

- Events are ordered by per-task `seq`.
- The first event for a task should use `seq = 0`.
- Parent/child ordering is causal when possible, but child tasks may have their
  own sequence spaces.
- Projection adapters must preserve canonical order for a single task.
- If events are emitted concurrently, the stream store assigns sequence numbers
  at append time.

## Replay

- Current legacy SSE clients reconnect with numeric `Last-Event-ID`.
- For legacy SSE, `Last-Event-ID` is treated as `sinceSeq`.
- Server returns stored events with `seq > sinceSeq`.
- Replayed legacy SSE frames use stored `seq` as SSE `id`.
- Replayed legacy SSE frames preserve stored `type`, `createdAt`, and payload.
- Replayed working-memory events that have canonical mappers may be emitted as
  canonical runtime SSE frames when `visibility=debug` is requested. Public
  replay keeps debug events filtered out.
- Future canonical transports may support opaque event ids, but must not overload
  the current numeric `Last-Event-ID` behavior without a versioned transport.

## Closure

- `artifact.done` does not close streams.
- `input.required` may pause task execution but does not close the subscription
  unless a transport explicitly chooses to end a request-response cycle.
- Terminal `task.status` with `completed`, `failed`, or `canceled` closes the
  task stream.

## Idempotency

- Replayed events preserve their original `id`.
- Client delivery layers should dedupe by `id`.
- Chat bridge delivery should additionally dedupe by `(channelKey, seq)` where
  the target network lacks event ids.

For legacy SSE replay, the delivery id is the stored sequence number. Clients
should therefore dedupe replayed legacy SSE by numeric SSE `id`.
