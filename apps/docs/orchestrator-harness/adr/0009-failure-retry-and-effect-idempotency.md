# ADR 0009: Failure, Retry & Effect Idempotency

## Status

Proposed

## Context

This is the correctness-critical decision behind the segment model (ADR 0002) and
durable dedupe (ADR 0005). The wake-level dedupe is necessary but **not
sufficient**, and the code confirms why.

What the code actually does today
(`packages/core/src/orchestration/TaskExecutor.ts`):

- `executeTurn` runs `runLoop` **once** and persists the snapshot **once at the
  end** (line ~261). Intermediate persistence is conditional only
  (`onTurnCheckpoint` fires for conversation keys; `flushSnapshot` is a manual
  hook used for subagent dispatch). So the durable unit already is the *segment*.
- External effects happen **during** the loop, not at the boundary: status/input
  events are enqueued to the outbox at many points
  (`taskEngine.ts` ~1210/1317/1365/1400/1501/1597; `ApiBinder.ts` ~357/704/880;
  `A2AService.ts` ~704), tools run, children are dispatched, and LLM calls are
  made.
- The outbox enqueue and the snapshot write are **separate, non-transactional**
  calls: `SessionManager.enqueueOutbox` → `store.enqueueOutbox` is independent of
  `SessionManager.saveSnapshot` → `store.writeSnapshotCAS`. There is no shared
  DB transaction wrapping them.

### The problem

ADR 0005 commits the dedupe key (`processedKeys`) atomically with the snapshot,
which only commits at the boundary. Therefore, if a segment crashes mid-loop:

1. the snapshot does not commit, so the dedupe key does not commit;
2. on redelivery (Hatchet at-least-once), the **entire segment re-runs from the
   wake**;
3. but external effects already emitted by the crashed attempt are **not** rolled
   back: tools may have been called, children dispatched, outbox rows written,
   LLM tokens spent, stream events published.

So the wake-level dedupe protects against re-running an **already-succeeded**
segment. It does **not** protect effects emitted by a **partially-executed,
crashed** segment. With at-least-once delivery plus worker crashes this is a
*when*, not an *if*.

This is not introduced by Hatchet — the non-transactional outbox exists today —
but moving segments onto remote workers with automatic retries makes it a
first-class correctness requirement instead of a rare in-process edge case.

## Decision

Treat **every external effect inside a segment as at-least-once**, and make each
effect either idempotent or replay-safe. Three rules:

### 1. Per-effect idempotency keys (not just per-wake)

Each effect carries a deterministic key derived from stable identifiers, so a
re-executed segment collapses to the same effect:

| Effect | Idempotency key |
|---|---|
| child dispatch | `parentTaskId:token:childTaskId` (already specified, ADR 0005) |
| tool call | `taskId:cognitiveTurnSeq:toolCallId` |
| outbox publish | `taskId:cognitiveTurnSeq:eventKind` (dedupe on insert) |
| stream event | `taskId:seq` (already monotonic; consumers dedupe on `seq`) |
| timer schedule | `taskId:token:timerId` (ADR 0003/0005) |

`cognitiveTurnSeq` is the internal counter within the segment (`env.turn`) and is
deterministic for a given wake + snapshot base. `turnSeq` identifies the durable
segment instead; retry and takeover attempts keep that `turnSeq` and receive a new
`claimId`, fence, and provider `attemptSeq`.

### 2. Retry classification owned by callAgent, bounded by Hatchet

- **Retryable (transient):** network/LLM 5xx/timeout, DB CAS conflict, transport
  errors. The segment may be retried; effects are deduped by rule 1.
- **Terminal (`fail`):** policy/shield rejection, validation error, exhausted
  budget, deterministic tool error. These produce an APLRET `fail` boundary and
  must **not** be retried by Hatchet (return success-with-fail-boundary, do not
  throw).
- Hatchet retries only on thrown transient errors, with a **bounded** attempt
  count (start: 3) and backoff. The APLRET retry budget and the Hatchet attempt
  count are distinct; the segment must not throw for a logical `fail`.

The driver boundary therefore distinguishes "segment threw (retry me)" from
"segment returned `fail` (terminal, do not retry)".

### 3. Effects should be safe to re-emit, or deferred to the boundary

Preferred ordering, in priority:

1. **Make the effect idempotent** via rule 1 (the default for tools, outbox,
   children, timers).
2. **Defer commit-coupled effects to the boundary** where feasible: write
   outbox rows in the *same* transaction as the snapshot write (a real
   transactional outbox), so they commit atomically with `processedKeys`. This is
   a targeted change to the snapshot+outbox write path, not an APLRET change.
3. **Accept at-least-once** for effects that cannot be deduped (e.g. a
   non-idempotent third-party tool); document them and require the tool contract
   to advertise idempotency support.

## Consequences

- Tools, outbox publishes, child dispatch, and timers all need deterministic
  keys; this is added to the spec and the migration checklist.
- The snapshot+outbox write path becomes a candidate for transactional coupling
  (a focused change in `SessionManager`/store, not in the loop).
- The driver/Hatchet retry policy is explicit: throw = transient retry; `fail`
  boundary = terminal. Bounded attempts prevent poison-segment storms.
- Non-idempotent external tools are a known residual risk and must be declared.

## Open Validation

- POC: crash a worker **mid-segment after a tool call and an outbox enqueue**;
  on retry, prove the tool is not double-executed (or is deduped) and the outbox
  event is not duplicated downstream.
- POC: a deterministic `fail` is not retried by Hatchet; a transient error is
  retried up to the bound and then dead-letters.
- Decide and test whether the outbox write is moved into the snapshot transaction
  (rule 3.2) for the migrated event types.
