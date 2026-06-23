# Timer Wakes Spec

## Goal

Implement Phase 4 timers as restart-safe durable wakes under the same runtime
driver seam used for input, tool, child, and external wakes.

Timers must support:

- token expiry for waits such as `await_input` with `expiresAt`;
- explicit sleep boundaries from the APLRET loop;
- recovery after worker/process downtime;
- duplicate-safe timer fire;
- operator-visible timer state and failures.

This spec implements ADR 0003. It does not replace the Phase 5 production
readiness gates for query scale, retention, payload budgets, or incident drills.

## Non-Goals

- Do not use Hatchet scheduled runs as the source of truth for token expiry.
- Do not move timer state into Hatchet workflow-only state.
- Do not delete in-process `setTimeout` behavior until B2 passes and the
  migration flag can be reversed safely.
- Do not add conversation timer semantics here; conversation durable waits remain
  a follow-up until the kernel has a first-class conversation boundary.

## Terms

| Term | Meaning |
|---|---|
| timer token | the token that identifies the wait being expired or woken |
| dueAt | ISO timestamp when the timer should fire |
| timer id | stable callAgent id for a timer record, distinct from provider run id |
| timer fire | the wake event saying the timer is due |
| reconciler | callAgent process that scans persisted timer state and repairs missed fires |
| durable sleep | Hatchet wait primitive used inside `aplret.task` for a known due time |

## Source of Truth

callAgent persisted state is authoritative for timer semantics.

Hatchet is responsible for efficient sleeping and dispatch. It is not the only
place where timer existence is remembered. A timer must be recoverable from
callAgent state even if the durable task was interrupted during downtime.

The persisted timer fact must include at least:

```ts
type TimerWakeRecord = {
  tenantId: string;
  taskId: string;
  agentId?: string;
  rootTaskId?: string;
  token: string;
  timerId: string;
  dueAt: string;
  kind: 'token_expiry' | 'sleep';
  status: 'scheduled' | 'firing' | 'fired' | 'canceled';
  idempotencyKey: string;
  fireLeaseId?: string;
  fireLeaseUntil?: string;
  payload?: unknown;
  createdAt: string;
  updatedAt: string;
  firedAt?: string;
  canceledAt?: string;
  providerRunId?: string;
  providerTaskRunId?: string;
  error?: unknown;
};
```

Phase 4 bridge persistence must be queryable. Do not store the only timer record
inside opaque task snapshots, because `TimerReconciler` must scan due timers
without loading every task snapshot. The expected Phase 4 bridge is a small
indexed timer table or an equivalent queryable store with this record shape.

Minimum index/query paths:

```text
(tenantId, status, dueAt, timerId)
(tenantId, taskId, token)
unique(tenantId, taskId, token, timerId)
unique(idempotencyKey)
```

The task snapshot may duplicate compact pending-token timer metadata for local
turn execution, but the queryable timer record is the reconciler source of truth.
Phase 5 may promote or merge this bridge into normalized run/effect persistence
if timer volume or retention requires it.

## Runtime Contract

The runtime seam already exposes timer scheduling:

```ts
RuntimeDriver.scheduleTimer(
  params: RuntimeDriverIds & {
    token: string;
    fireAt: string;
    payload?: unknown;
  }
): Promise<{ timerId: string }>;
```

Phase 4 tightens the contract:

1. `fireAt` is an absolute ISO timestamp.
2. The driver returns a stable `timerId` for the persisted timer fact.
   `timerId` must be deterministic across retries. Recommended derivation:

   ```text
   timer:<sha256(tenantId + "\0" + taskId + "\0" + token + "\0" + fireAt + "\0" + kind)>
   ```

   If a pre-existing token already carries a timer id, reuse that id. Do not use
   a random UUID generated inside a retried scheduling path unless it is
   persisted before any provider work can be retried.
3. The deterministic idempotency key is:

   ```text
   timer:${tenantId}:${taskId}:${token}:${timerId}
   ```

4. A timer wake is represented as:

   ```ts
   { kind: 'timer'; token: string; timerId: string; payload?: unknown }
   ```

5. Timer fire must route through the same wake application and durable dedupe
   path as other wakes. A duplicate timer fire for the same idempotency key is a
   no-op after the first effective boundary.

## Timer Expiry Observation

Timer wakes are converted into an inbox observation before the next segment runs.
The observation shape must be stable so agent perception modules can distinguish
expiry from normal user input or arbitrary external events:

```ts
type TimerExpiredObservation = {
  kind: 'timer.expired';
  token: string;
  timerId: string;
  dueAt: string;
  firedAt: string;
  reason: 'input_timeout' | 'sleep_due';
  payload?: unknown;
};
```

Mapping:

- `await_input` with `expiresAt` uses `reason: 'input_timeout'`;
- explicit `sleep` boundaries use `reason: 'sleep_due'`.

The observation is the only semantic input to the resumed turn. A timer fire must
not fabricate user input, tool output, or child output.

## Segment Boundary

`TurnExecutor.runSegment` may return a sleep/timer boundary when the loop should
pause until a known time.

Expected boundary shape:

```ts
type SegmentBoundary =
  | { kind: 'sleep'; token: string; fireAt: string; timerId?: string; payload?: unknown }
  | existing boundaries...
```

For existing token expiry flows, a segment may still return `await_input` with
`expiresAt`. The durable task must treat that as both:

- an event wait for input; and
- a timer deadline for expiry.

This prevents a token from waiting forever when no external input arrives.

## Hatchet Mapping

### `aplret.task` / `agent.<agentId>`

When a segment returns a timer-capable boundary:

```text
spawn aplret.segment
inspect boundary
if boundary is await_input with expiresAt:
  persist/schedule timer wake for token
  wait for either:
    aplret.input.<token>
    durable sleep until expiresAt
  if input wins:
    cancel/mark timer canceled best-effort
    spawn next segment with input wake
  if sleep wins:
    spawn next segment with timer wake
if boundary is sleep:
  persist/schedule timer wake for token
  durable sleep until fireAt
  spawn next segment with timer wake
```

The durable task must not keep timer-only correctness in local variables. It may
use Hatchet durable sleep for efficiency, but the timer must also be visible in
callAgent persisted state for reconciliation.

Implementation note: before coding this branch, verify the exact Hatchet SDK
pattern for racing a durable event wait against durable sleep. If Hatchet does
not expose a direct race/selector primitive, implement the equivalent with the
documented durable-task control flow and record that choice in this spec before
landing code. The required semantic outcome is still "input wins before dueAt,
timer wins at/after dueAt"; the SDK shape is an implementation detail, not a
semantic change.

### `aplret.timer.fire`

`aplret.timer.fire` is the repair/manual fire path used by `TimerReconciler`.

Responsibility:

1. Load the persisted timer fact.
2. If the timer is already `fired` or `canceled`, return success no-op.
3. Mark `firing` or acquire the equivalent CAS/lease.
4. Push or enqueue the timer wake:

   ```ts
   { kind: 'timer', token, timerId, payload }
   ```

5. Mark `fired` only after the wake is durably accepted or the segment is
   scheduled.

Lease rules:

- acquiring fire ownership sets `status = 'firing'`, a unique `fireLeaseId`, and
  `fireLeaseUntil = now + leaseTtl`;
- default `leaseTtl` should be short (for example 2-5 minutes) and configurable;
- a worker may acquire a timer when `status = 'scheduled'`, or when
  `status = 'firing'` and `fireLeaseUntil < now`;
- a worker may mark `fired` only if it still owns the current `fireLeaseId`;
- if wake enqueue succeeds but marking `fired` fails, retry/reconcile is safe
  because the timer wake idempotency key collapses duplicate fires;
- if wake enqueue fails, keep or restore `scheduled`/retryable state with
  readable error metadata.

If the active durable parent task can receive `aplret.timer.<token>` directly,
`aplret.timer.fire` may push that event. If there is no active parent run, it may
call `enqueueResume` / `TurnExecutor.runSegment` through the driver path. The
observable behavior must be the same: one effective timer wake.

## TimerReconciler

`TimerReconciler` is defense in depth for downtime and missed provider work.

It runs:

- on runtime/worker startup;
- periodically while the process is alive;
- optionally as an operator/manual repair command later.

Algorithm:

```text
scan due timers where dueAt <= now and status in ('scheduled', 'firing')
for each timer:
  derive idempotency key timer:<tenantId>:<taskId>:<token>:<timerId>
  enqueue aplret.timer.fire or equivalent driver timer fire
  record provider run id if available
```

The reconciler must be bounded:

- batch size;
- max attempts per scan;
- tenant-aware ordering where available;
- logs with `tenantId`, `taskId`, `token`, `timerId`, and `dueAt`.

The reconciler must be duplicate safe. It is allowed to enqueue the same due
timer more than once if the timer fire path collapses duplicates by idempotency
key.

## Races

### Input Arrives Before Timer Fires

```text
await_input token T expires at dueAt
input T arrives first
segment resumes with input
timer fires later
```

Expected:

- input wake wins;
- timer fire sees token no longer pending or timer marked canceled;
- timer fire returns success no-op;
- no timeout observation is injected after successful input.

### Timer Fires Before Input

```text
await_input token T expires at dueAt
timer fires first
late input T arrives later
```

Expected:

- timer wake injects `TimerExpiredObservation` with `reason: 'input_timeout'`;
- token is no longer resumable;
- late input returns no-op or rejected-expired result;
- operator graph shows the timer/expiry as the reason the next turn ran.

### Duplicate Timer Fire

Expected:

- only one effective snapshot transition;
- subsequent fires are success no-ops;
- duplicate provider runs may exist in Hatchet debug UI, but the semantic
  operator graph must show one timer wake/effect.

### Cancellation

If a task is canceled before dueAt:

- pending timer state becomes `canceled` or non-resumable;
- queued Hatchet timer fire/provider work is canceled best-effort;
- late timer fire returns a canceled/no-op boundary;
- no next segment is scheduled from that timer.

## Operator Projection

Timer facts should be visible without requiring Hatchet UI.

Minimum projection:

- `AgentRunGraph.effects` includes hidden-by-default timer effects:
  `operation: 'timer.fire'` or `operation: 'timer.schedule'`;
- `TurnRun.boundaryKind` / cognition transition distinguishes `sleep` and timer
  expiry from generic `running`;
- node summary can show waiting reason:
  `Waiting for input until <time>` or `Sleeping until <time>`;
- semantic errors show readable timer failure codes if scheduling or firing
  fails.

Hatchet provider ids remain debug links only.

## Driver Runs

Persist bridge rows for timer provider work:

```text
operation = 'timer.schedule' | 'timer.fire'
taskId = parent task id
token = timer token
idempotencyKey = timer:<tenantId>:<taskId>:<token>:<timerId>
status = queued | running | completed | failed | canceled
boundaryKind = 'sleep' or 'timer'
```

`driver_runs` is not the long-term product read model, but it is required for
debug links, cancellation best-effort, and MVP operator projection.

## Failure Policy

Timer fire has infrastructure retry semantics:

- transient provider/DB/event-push failures throw and retry with bounded backoff;
- semantic no-op states (`already fired`, `canceled`, `token not pending`) return
  success and do not retry;
- repeated failures should surface as a failed timer effect with code/message.

Readable error codes:

```text
TIMER_RECORD_MISSING
TIMER_ALREADY_FIRED
TIMER_CANCELED
TIMER_TOKEN_NOT_PENDING
TIMER_FIRE_FAILED
TIMER_SCHEDULE_FAILED
```

Only actual failure codes should be shown as errors; already-fired/canceled are
debug/no-op states.

## Feature Flags

Timer migration must be reversible per surface:

```text
CALLAGENT_DRIVER_SURFACES=timers
```

When `timers` is disabled:

- in-process timer behavior remains authoritative;
- Hatchet timer tasks/reconciler do not schedule new timer wakes;
- existing due timer facts may be reconciled manually if needed, but the default
  path must not double-fire with in-process timers.

## Tests

Required unit/integration coverage:

1. `scheduleTimer` persists deterministic timer facts and idempotency keys.
2. `await_input` with `expiresAt` schedules a timer and resumes with input if
   input wins.
3. Timer expiry resumes the next segment when input does not arrive.
4. Late input after timer expiry is no-op/rejected expired.
5. Duplicate `aplret.timer.fire` produces one effective snapshot transition.
6. Canceled task ignores later timer fire.
7. Stale `firing` leases are reacquired after `fireLeaseUntil`.
8. `TimerExpiredObservation` shape is injected for input timeout and sleep due.
9. `TimerReconciler` scans overdue scheduled timers on startup.
10. `TimerReconciler` recovers downtime where dueAt passed while no worker was
   running.
11. Operator graph includes timer schedule/fire effects and waiting reason.
12. In-process driver parity remains green when `timers` surface is disabled.

Manual POC B2:

```text
start task that awaits input with expiresAt = now + short delay
stop worker before dueAt
restart worker before dueAt
verify timer fires once

repeat with Hatchet/runtime down through dueAt
restart
verify TimerReconciler fires once and task resumes

push duplicate timer fire
verify no second transition
```

## Deletion Gate

The in-process `setTimeout` token-expiry path can be deleted only after:

- all tests above pass;
- manual B2 passes against the self-hosted Hatchet POC environment;
- timer migration flag can be disabled to restore old behavior;
- operator graph exposes timer wait/fire state clearly;
- production-readiness payload/observability gates are either passed or
  explicitly deferred for non-production use.
