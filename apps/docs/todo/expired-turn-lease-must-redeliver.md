# Bug Report: Expired task-turn lease completes provider segment and strands durable demand

> **Status:** Implemented on 2026-09-04; verification is covered by coordinator,
> runtime-reconciler, SQL-store, Hatchet-root, and Operator regression tests.
>
> **Severity:** Critical for correctness of long-running durable agents. The
> expired owner is correctly fenced from committing, but CallAgent can then lose
> liveness: the provider segment completes while requested work has neither an
> owner nor a recovery dispatch.

## Summary

When a CallAgent task-turn lease expires while agent code is still running,
CallAgent correctly rejects the stale execution's later persistence. It then
misclassifies that self-expiry as a harmless `superseded` result, returns a
successful `aplret.segment` result to Hatchet, and does not create a new durable
dispatch intent.

The root remains `running` forever even though its coordinator has:

```text
requestedGeneration > completedGeneration
active claim expired
dispatchIntent absent
no worker executing the task
```

This is a generic runtime defect. It affects any agent whose event loop is delayed,
whose storage renewal is delayed, or whose process loses its renewal window. It is
not ANAC-specific.

The existing architecture report
`concurrent-root-turn-stale-state-terminal-race.md` already states the intended
contract: a durable wake is either owned or left runnable for recovery. This incident
is evidence that the delivered recovery path does not cover self-expired claims.

## Production incident

Affected task:

```text
anac-cig-importer-1788526607259-563f6a76
```

At `2026-09-04T15:42:13.107Z`, its active Hatchet turn claim was renewed with:

```json
{
  "claimId": "8dffb0b5-4e69-4f93-8dd1-0bfa3a72cb9c",
  "fence": "2",
  "claimedGeneration": "1",
  "runtimeSurface": "hatchet",
  "heartbeatAt": "2026-09-04T15:42:13.107Z",
  "expiresAt": "2026-09-04T15:44:13.107Z"
}
```

The internal agent operation took `111,704 ms`. At `15:44:19`, after lease expiry,
the worker logged:

```text
execution module failed: Task turn renewal expired
```

The active claim was then correctly fenced. However, the provider logged:

```text
turn.segment completed
```

and the SQL state remained:

```text
agent_runs.status = running
requestedGeneration = 1
completedGeneration = 0
active.fence = 2
active.expiresAt = 2026-09-04T15:44:13.107Z
dispatchIntent = absent
```

The family lease was released, CPU became idle, no worker owned the task, and
Operator continued to show it as running. The ANAC checkpoint was safe, and no
CallKG publication was made, but this outcome is unacceptable for a generic durable
runtime.

## Root cause

### 1. Self-expiry is converted to `superseded`

`TurnRunnerSegmentExecutor` starts a periodic `renewTaskTurnClaim()` timer. If the
timer eventually observes any disposition other than `renewed`, it aborts the task
context:

```ts
if (disposition !== 'renewed') {
  abortController.abort(new Error(`Task turn renewal ${disposition}`));
}
```

When the lease is already expired, later fenced persistence raises
`TaskTurnSupersededError`. `classifySupersededExecutionError()` treats this exactly
like replacement by another owner. It returns a duplicate/superseded segment result.

Relevant code:

- `packages/core/src/runtime/turnRunnerSegmentExecutor.ts`
  - `runClaimedTurn()`
  - `classifySupersededExecutionError()`
- `packages/core/src/orchestration/TaskTurnCoordinator.ts`
  - `renewTaskTurnClaim()`
  - fenced persistence checks

This conflates two materially different states:

```text
true supersession: a different valid owner has acquired the generation
self expiry:       no valid owner exists; the requested generation is runnable
```

### 2. The recovery coordinator is not notified

The expired claim is left in the snapshot, correctly preventing stale writes. But
the `superseded` result path neither creates a recovery dispatch intent nor invokes
the existing runnable-turn reconciliation path. Hatchet sees a completed segment,
so it has no reason to deliver a replacement segment. CallAgent's reconciler also
does not repair this `requested > completed`, expired-active, no-dispatch state.

The result violates the framework's own liveness invariant:

```text
Every accepted, non-terminal requested generation is either
  (a) held by exactly one unexpired fenced claim, or
  (b) represented by a durable recovery dispatch intent.
```

## Contributing trigger, not the framework root cause

The ANAC replay-spooling code blocked its Node event loop long enough to miss the
120-second lease. That importer defect will be fixed separately. It must not be
required to reproduce this CallAgent bug: storage latency, CPU pauses, process
suspension, temporary network interruption, or any other delayed heartbeat can
produce the same self-expiry.

The simultaneous Hatchet listener `UNAVAILABLE: Connection dropped` is consistent
with the blocked event loop, but does not explain why CallAgent left durable demand
without a recovery path.

## Required behavior

1. A stale owner must never commit after its lease expires.
2. If another owner has already acquired the same generation, the old execution may
   be reported as `superseded`; no extra dispatch is created.
3. If the lease expires and no replacement owner exists, CallAgent must atomically
   make the same requested generation runnable and enqueue/reconcile exactly one
   deterministic recovery dispatch.
4. The recovery attempt must preserve the original root identity, request key,
   generation, deadline, tenant, and side-effect fences.
5. The previous local execution must stop cooperatively and may not make external
   effects after lease loss.
6. A provider segment must not report ordinary success for stranded work. It may
   report a stable recoverable disposition, but the durable recovery dispatch must
   be committed first or be recoverable by reconciliation.
7. Operator must show either `recovering after lease expiry` or a truthful terminal
   failure. It must never show an indefinitely active run with no owner.

## Recommended repair

Introduce an explicit lease-loss classification, distinct from competing-owner
supersession. The exact names may differ:

```ts
type LostTurnOwnership =
  | { kind: 'competing_owner'; replacementClaimId: string }
  | { kind: 'lease_expired_unowned' }
  | { kind: 'terminal' };
```

For `lease_expired_unowned`, perform one fenced reconciliation mutation that:

1. verifies the task is non-terminal;
2. verifies the active claim still matches the expired local claim and no other
   unexpired claim has replaced it;
3. removes or marks that expired active claim non-authoritative;
4. preserves `requestedGeneration` and `completedGeneration` unchanged;
5. creates the deterministic dispatch intent for the pending generation; and
6. emits an idempotent provider nudge for the existing root, not a standalone
   segment.

If this mutation races with a valid takeover, it must resolve to
`competing_owner` without creating duplicate work. If it races with a terminal
winner, it must project that terminal state instead.

The periodic runnable-turn reconciler must independently detect and repair the same
invariant breach after a process crash between expiry and dispatch. It should be
safe to run repeatedly and must not rely on the original worker process.

Do not solve this by merely extending the lease duration. A larger lease changes
the frequency of the incident but preserves the liveness hole and delays recovery.

## Required tests

- Unit: `renewTaskTurnClaim()` returns `expired`; no competing claim exists; the
  executor produces a durable recovery dispatch rather than a successful duplicate.
- Unit: identical lease expiry with a competing replacement claim produces no second
  dispatch and records genuine supersession.
- Unit: expiry races with terminal completion and retains the terminal winner.
- Integration: pause/event-loop-starve a Hatchet segment until its claim expires;
  verify the original execution cannot persist and exactly one fenced redelivery
  resumes the same requested generation.
- Integration: kill the worker after expiry but before recovery dispatch; the
  reconciler discovers the stranded generation and resumes it after restart.
- Integration: run the same scenario with provider delivery temporarily unavailable;
  assert the durable dispatch intent remains and retry is bounded/idempotent.
- Integration: prove root deadline is preserved across recovery and no external
  effect may run twice.
- Projection: Operator transitions from `running` to `recovering after lease expiry`
  and then to the resumed or terminal state. It never remains falsely running with
  an expired unowned claim.
- Regression: run a long checkpointing fixture whose work exceeds the lease once;
  verify it resumes from its last durable checkpoint, with no duplicate checkpoint
  commit or publication.

## Acceptance criteria

1. No non-terminal task snapshot can persist `requestedGeneration >
   completedGeneration` with both an expired active claim and no dispatch intent.
2. Repeated recovery scans and duplicate provider delivery produce one effective
   replacement attempt.
3. A true competing owner never loses ownership or receives duplicate work.
4. Expiry/recovery preserves tenant isolation, root deadline, idempotency keys,
   fencing, cancellation, and terminal arbitration.
5. Provider, `agent_runs`, task snapshot, outbox, and Operator converge on one
   truthful state within the configured recovery interval.
6. Existing cancellation, supersession, root timeout, restart, and terminal-race
   tests remain green.

## Non-goals

- Relaxing task-turn leases as a substitute for recovery.
- Treating an expired lease as a successful turn.
- Re-running arbitrary in-memory work after expiry.
- Importer-specific replay or performance changes.
