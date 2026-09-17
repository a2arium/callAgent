# Bug report: expired Hatchet turn lease creates recovery-dispatch churn and execution survives worker shutdown

**Status:** Resolved
**Severity:** Critical
**Affected surface:** Hatchet runtime, durable turn recovery, worker shutdown, Operator state projection

**Resolution (2026-09-05):** Recovery-hint admission, bounded polling, execution supervision, shutdown fencing, and mutation guards are implemented. Focused recovery tests, the complete Hatchet driver suite, all package builds, and the six-scenario real Hatchet worker-replacement regression pass. Provider failure reconciliation also requires a stable failure across two polling intervals because Hatchet may briefly expose an assignment failure while the same run is still recoverable.

## Summary

An ANAC CIG run whose active turn lease expired entered a durable recovery loop. CallAgent repeatedly completed short replacement `turn.segment` attempts as `queued`, but the recovery dispatch remained pending and no replacement attempt acquired authoritative ownership. A second importer run then acquired its own claim and continued executing a single long provider segment.

Later, CallAgent correctly detected that its Hatchet worker was no longer `ACTIVE`, marked worker-stream readiness unavailable, and began shutdown. Despite the worker loop and provider root being aborted, the active agent callback continued to run turns and write memory. This permits work to continue after the provider worker that owned it has stopped.

These are framework-level liveness and fencing defects. The importer can reduce pressure with bounded polling and backoff, but it cannot make an unconsumed recovery dispatch or a detached execution safe.

## Production evidence

### Affected tasks

- Stale recovery task: `anac-cig-importer-17885918833N-resume`
- Concurrent active task: `anac-cig-importer-1788592571-publish-resume`
- Shared CallKG publication generation: `7337999b3548e98aabcde58d208a1c2d76fabb2997576a2bc10dc4b19f0dccce`

The publication remained staged at `STAGING / WAIT_BATCH / 21`; nothing was published live.

### Recovery dispatch never consumed

The stale task's authoritative `turnCoordinator` snapshot retained this dispatch:

```json
{
  "dispatchIntent": {
    "turnSeq": 1,
    "generation": "1",
    "runtimeSurface": "hatchet",
    "deliveryKey": "anac-cig-importer-17885918833N-resume:turn-request:1",
    "createdAt": "2026-09-05T07:17:31.194Z",
    "enqueuedAt": "2026-09-05T09:48:58.892Z",
    "recovery": {
      "reason": "lease_expired",
      "sourceClaim": {
        "claimId": "55b3c967-7f04-4b2e-9845-ae39efd923ad",
        "ownerId": "segment:43",
        "fence": "1",
        "turnSeq": 1,
        "claimedGeneration": "1",
        "runtimeSurface": "hatchet",
        "acquiredAt": "2026-09-05T07:04:46.033Z",
        "heartbeatAt": "2026-09-05T07:15:28.394Z",
        "expiresAt": "2026-09-05T07:17:28.394Z"
      }
    }
  },
  "requestedGeneration": "1",
  "completedGeneration": "0"
}
```

The task accumulated 1,602 completed `turn.segment` driver runs. Events repeatedly recorded `turn.attempt_finished` with a `queued` disposition, approximately every six seconds, without clearing the recovery intent or installing a replacement authoritative claim. There were no active `turn_runs` for this task.

### Work continued after worker shutdown

The runtime worker instance `25172d57-7f2a-4fef-848c-896372129987` (`aplret-runtime-worker-7dd35c46`) was recorded as `stopped` at `2026-09-05T09:42:30.087Z`.

Runtime logs reported:

```text
HATCHET_WORKER_STREAM_UNAVAILABLE { message: 'Hatchet worker is not ACTIVE' }
Starting to exit...
Evicted 1 waiting durable run(s) during shutdown
agent.run failed: Operation cancelled by AbortSignal
ActionListener Listener aborted
Gracefully exiting hatchet worker, running tasks will attempt to finish...
```

After that timestamp, the newer task continued emitting `turn.started` events and performing memory reads and writes. Its single `turn.segment` remained active after more than 13,000 internal turns. `/ready` correctly returned `503 HATCHET_WORKER_STREAM_UNAVAILABLE`, but readiness degradation did not stop the detached callback.

## Expected behavior

1. Expired ownership creates at most one durable recovery dispatch for a logical turn and generation.
2. The replacement execution either acquires a new claim with a strictly higher fence or observes an existing competing owner and stops dispatching.
3. Duplicate scanners and duplicate Hatchet deliveries are idempotent and cannot produce a segment storm.
4. A recovery dispatch is cleared or terminalized when consumed, superseded, canceled, or found irrecoverable.
5. When worker registration becomes invalid, CallAgent aborts and awaits every active callback before declaring shutdown complete.
6. Once ownership, fencing, or provider execution is lost, the stale attempt cannot write memory, register effects, or perform external mutations.
7. The worker process exits non-zero after bounded graceful shutdown so the deployment supervisor replaces it.
8. Operator shows one authoritative state: recovering, actively owned, canceled, or failed—not simultaneous indefinite `running` projections.

## Recommended fix contract

### Recovery dispatch ownership

- CAS-create a recovery intent only when the expired claim still matches the authoritative snapshot.
- Assign a stable idempotency key from task, generation, logical turn, expired claim, and next fence.
- Treat an already-enqueued intent as success; do not enqueue it on every scan or provider callback.
- Atomically consume the intent when a replacement claim is installed.
- If another current claim exists, reconcile the intent as superseded instead of returning another queued attempt.
- Apply bounded retry/backoff to provider dispatch failures and expose the retry state in Operator.

### Worker shutdown and fencing

- Maintain an abort controller for each active root/segment execution.
- On invalid worker registration, stop admission, abort all controllers, and await their settlement for a bounded grace period.
- After grace expiry, terminate the worker process; do not leave an in-process callback alive indefinitely.
- Make every TaskContext memory/effect mutation verify the current claim and fence. A lost fence must return a stable terminal interruption and prevent the mutation.
- Ensure the provider root, `driver_runs`, `turn_runs`, `agent_runs`, status outbox, and Operator converge after shutdown or replacement.

## Required tests

1. Expire a claim during execution and assert exactly one recovery dispatch, one replacement claim, and a higher fence.
2. Run the recovery scanner repeatedly and deliver the same provider request repeatedly; assert no duplicate segment executions.
3. Introduce a competing current owner and prove the stale recovery is reconciled without churn.
4. Cancel a task with a queued recovery and prove the dispatch becomes terminal and cannot later run.
5. Invalidate a real Hatchet worker while a callback is reading and writing memory. Assert the callback receives cancellation, stops promptly, and performs no post-fence mutation.
6. Make a callback ignore graceful cancellation. Assert the process exits after the bounded grace period and the supervisor starts a clean worker.
7. Restart after each crash window around intent creation, enqueue, replacement claim CAS, and intent consumption; assert one logical recovery.
8. Verify Operator and API expose the same recovery/terminal state throughout.

## Operational mitigation until fixed

- Cancel both affected CallAgent tasks before deploying a fix.
- Do **not** abort the staged CallKG generation; it is the resumable publication boundary.
- Do not start a second importer for the same family.
- Treat `HATCHET_WORKER_STREAM_UNAVAILABLE` as requiring worker replacement, not merely an unhealthy HTTP status.
- Before resuming, verify one active worker, no active/queued duplicate root for the family, and one authoritative checkpoint owner.
