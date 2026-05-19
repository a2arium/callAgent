# ADR 0005: Replay And Idempotency

## Status

Proposed

## Context

SSE, web clients, and chat bridge integrations need reconnect and delivery
deduplication. Current event ids are not uniformly stable across all event
sources.

## Decision

Every canonical stream event gets:

- stable `id`
- monotonic per-task `seq`
- timestamp `ts`
- `taskId`
- optional `parentTaskId` and correlation fields

Replay returns events with `seq > lastSeq` or after `Last-Event-ID`.

## Consequences

- Clients can reconnect safely.
- Tests can assert exact ordering.
- Storage/replay adapter must persist canonical events or reconstruct them
  deterministically.

