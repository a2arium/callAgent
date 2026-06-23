# ADR 0005: Snapshot Ownership And Idempotency

## Status

Proposed

## Context

The current runtime persists `MentalState`, inbox, pending tokens, metadata, and
manifest provenance in callAgent snapshots. Saves use `wmVersion` optimistic
concurrency. Many hard parts of `taskEngine.ts` exist to recover from duplicate
or concurrent delivery.

Hatchet provides at-least-once task execution. The docs explicitly require task
code to be idempotent because tasks can run more than once.

### Why CAS alone is not enough

CAS (`wmVersion`) guards **concurrent** writers: two writes racing on the same
base version, one loses and retries. It does **not** guard **sequential**
duplicate delivery. A redelivered wake (`aplret.tool.<token>`) arriving after the
first one committed will load the *latest* snapshot, append the observation
*again*, and save cleanly — a double application, not a CAS conflict. With
at-least-once delivery plus worker crashes, this is a *when*, not an *if*.

Therefore a **durable dedupe** is required, not optional.

## Decision

callAgent remains the owner of all cognition and snapshot state:

- `MentalState` lives only in callAgent snapshots.
- Hatchet payloads carry stable IDs and small event payloads only.
- `TurnExecutor.runSegment` is responsible for loading, mutating, and saving
  snapshots.
- CAS guards concurrency; a **durable dedupe** guards duplicate delivery.
- Idempotency keys are deterministic and enforced in callAgent.

### Durable dedupe mechanism

`runSegment` checks and records the `idempotencyKey` durably **in the same
transaction** as snapshot writes:

- Implemented mechanism: a `processedKeys` set persisted inside the snapshot
  (bounded / pruned to the most recent 512 keys). `SessionManager.saveSnapshot`
  stamps the active segment idempotency key into every snapshot write made while
  `runSegment` is active, so the dedupe commit and the state transition are one
  atomic write guarded by CAS. A post-run recorder remains as a fallback for
  segments that return without writing a snapshot.
- Alternative: a dedicated `processed_wakes(tenant_id, task_id, idempotency_key,
  applied_at)` table with a unique constraint, written transactionally with the
  snapshot.

On a duplicate key, `runSegment` skips appending the observation and returns the
current boundary as a no-op. The in-memory RPC `IdempotencyStore` (10-min TTL,
lost on restart) is explicitly **not** the mechanism for orchestrator-driven
wakes.

Current required wake idempotency keys:

| Operation | Key |
|---|---|
| task start | `taskId:start` |
| input resume | `taskId:input:token` |
| tool resume | `taskId:tool:token` |
| child completion | `parentTaskId:child:token` |
| external event | `taskId:external:token` |
| timer fire | `taskId:timer:timerId` |
| cancel | `taskId:cancel` |
| segment outbox publish | `segmentIdempotencyKey:outbox:topic:seq` |

## Consequences

- Hatchet retry duplicates are acceptable because dedupe is durable.
- A durable dedupe store/field is required before Hatchet mode ships beyond local
  POC. This is a correctness prerequisite, not an audit follow-up.
- CAS remains even if Hatchet serializes per task. Serialization reduces
  contention; the durable dedupe provides correctness against re-delivery.
- Pruning policy for `processedKeys` must be defined so the snapshot does not
  grow unbounded.

## Open Validation

- B1/B3 real-worker validation: run the duplicate/redelivery scenarios against
  actual Hatchet worker restarts, not only the segment executor integration
  tests.
- ADR 0009 per-effect idempotency remains separate: wake dedupe protects
  snapshot transitions; effect idempotency protects non-transactional external
  side effects.
