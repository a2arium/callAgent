# Bug Report: Hatchet durable stream loss fails active work and leaves CallAgent falsely running

> **Status:** Core remediation implemented in `9e75bf2` on 2026-09-04;
> packaged Hatchet interruption/soak verification remains required before this
> incident can be closed.
>
> **Severity:** Critical for long-running durable agents. A recoverable transport
> interruption failed the provider root, while CallAgent continued to expose the run as
> active for more than six hours and ultimately replaced the real failure with a timeout.

## Summary

A long-running ANAC CIG importer lost the Hatchet worker's durable gRPC stream. Hatchet
rejected subsequent heartbeats because the worker stream was no longer active and then
failed the authoritative `agent.run` with:

```text
durable stream error: /v1.V1Dispatcher/DurableTask UNAVAILABLE: Connection dropped
```

CallAgent did not converge its durable `agent_runs` projection to that failure. Operator
continued to present the run as active. Roughly six hours later, stale-run cleanup marked
it `canceled` with `active_run_timeout`, hiding the actual provider failure.

This report treats transport recovery and terminal projection as one incident because
either defect alone makes long-running work unsafe to operate: the first unnecessarily
kills recoverable work, and the second conceals the failure and delays recovery.

## Production Incident

### Identities

- CallAgent task: `anac-cig-importer-1788457383305-ca7327dc`
- Hatchet root `agent.run`: `c44797b5-0277-47ac-96a7-8b5c100b5f67`
- Hatchet worker stream: `1269cfbb-5fd2-4954-b95e-4beffca8ae59`
- CallAgent release: `d42bfdc3df4710b4258276a1a01ad540ff547188`
- Hatchet TypeScript SDK: `1.24.2`

Neither the CallAgent nor Hatchet engine container restarted or was OOM-killed during
the incident.

### Timeline (UTC)

| Time | Evidence |
| --- | --- |
| `2026-09-03 17:43:04` | Hatchet root and CallAgent run started. |
| `2026-09-03 18:05:25` | Hatchet first logged `Heartbeat rejected: worker stream is not active`. |
| `2026-09-03 18:07:21` onward | CallAgent repeatedly logged listener reconnects followed by `Connection dropped`. |
| `2026-09-03 19:20:32` onward | Durable, action, and child listeners all reported dropped gRPC connections. |
| `2026-09-03 19:36:03` | Hatchet marked the authoritative root `FAILED` with the durable-stream error. |
| `2026-09-04 01:43:34` | CallAgent finally marked the run `canceled`, reason `active_run_timeout`. |

The Hatchet task was registered with `step_timeout = 481m`. It failed after about 113
minutes, so the configured eight-hour task timeout did not cause the provider failure.

### Authoritative ledger disagreement

Hatchet:

```json
{
  "operation": "agent.run",
  "status": "FAILED",
  "error": "durable stream error: /v1.V1Dispatcher/DurableTask UNAVAILABLE: Connection dropped"
}
```

CallAgent after stale-run cleanup:

```json
{
  "status": "canceled",
  "cancel_reason": "active_run_timeout",
  "terminal_code": null,
  "terminal_message": null,
  "output_state": "not_captured"
}
```

The real transport failure was retained only in `driver_runs.error`; it was absent from
the authoritative user-facing run state.

## Data-Safety Evidence

The consumer's checkpoint protocol prevented publication or replay loss:

- the importer checkpoint is valid `anac-candidate-progress-v2`;
- phase is `SPOOL_REPLAY`;
- all twelve 2022 resource results are present;
- the committed cursor is resource index `11`, observation chunk `6`;
- the checkpoint owns 977 retained artifacts with zero missing references;
- the root artifact's SHA-256 was recomputed and matched;
- approximately 1.24 GB logical / 408 MB compressed checkpoint data remains;
- the family lease was released;
- no temporary CSV, ZIP, extraction, or partition path remains;
- no CIG generation or ingestion was published to CallKG.

The next importer run can resume from the committed checkpoint. This does not reduce
the severity: consumers without equivalent checkpoints would lose work, and Operator
gave no reliable indication that recovery was required.

## Confirmed Defects

### 1. Durable transport loss is terminal instead of resumable

The Hatchet SDK's durable listener reconnect attempts did not restore an active worker
stream. The engine continued rejecting heartbeats for the same worker stream, and the
root eventually failed with `UNAVAILABLE`.

An `UNAVAILABLE` connection loss is a transient transport condition unless an explicit
deadline, cancellation, or non-retryable protocol error proves otherwise. A durable root
must reconnect/rebind or be safely redelivered while preserving its absolute deadline
and durable execution identity.

### 2. Provider-root failure does not terminalize `agent_runs`

Hatchet's root became `FAILED`, and CallAgent ran `task.state.project_failed`, but the
corresponding `agent_runs` record remained active. Terminal convergence therefore did
not occur.

The later stale-run timeout overwrote the incident's meaning with
`active_run_timeout`. Provider failure, CallAgent run state, status outbox, and Operator
must agree on one authoritative terminal outcome.

### 3. Worker readiness ignores an invalid durable worker stream

The CallAgent process and HTTP readiness stayed healthy while Hatchet was rejecting its
worker heartbeats. Schedule-API readiness is insufficient: it proves REST authentication,
not that the worker's action/durable streams are registered and usable.

## Contributing Risk Requiring Review

The first provider segment hosted many internal importer turns and remained active for
a long CPU- and artifact-intensive interval. The consumer committed bounded checkpoints,
but the provider segment itself was coarse.

This may increase exposure to heartbeat/listener failure or event-loop starvation. It is
not yet proven to be the original cause of stream invalidation. Instrument event-loop lag,
listener heartbeat latency, PostgreSQL latency, and segment duration before deciding
whether segment boundaries or workload isolation must change.

The Hatchet engine simultaneously logged concurrency-strategy operations taking hundreds
of milliseconds to more than one second. CallAgent artifact traffic and Hatchet share the
same PostgreSQL server, so storage contention is another plausible contributor, not a
confirmed root cause.

## Expected Behaviour

1. A transient Hatchet `UNAVAILABLE` or dropped durable listener reconnects and rebinds
   the worker without terminating active durable roots.
2. If recovery requires redelivery, exactly one fenced execution resumes from durable
   state. The absolute root deadline is not reset.
3. If recovery is impossible, the authoritative provider failure immediately terminalizes
   `agent_runs` as `failed` with a stable, non-secret transport error code.
4. A later stale-run sweep cannot replace an already-known failure with
   `active_run_timeout`.
5. Status outbox, `driver_runs`, `agent_runs`, Hatchet, and Operator converge on the same
   terminal state and reason.
6. An invalid worker action/durable stream degrades readiness with a diagnostic distinct
   from schedule REST readiness.
7. No stale execution may continue external side effects after its provider ownership or
   turn-renewal lease is lost.

## Recommended Fix Contract

### Recover or redeliver durable roots

- Classify gRPC `UNAVAILABLE`/connection-drop errors as retryable transport failures.
- Re-establish the action, child, and durable listener streams as one worker-registration
  lifecycle rather than allowing independently reconnecting listeners to remain attached
  to an invalid worker stream.
- If in-place recovery is unsupported by Hatchet, terminate the stale local attempt and
  allow a fenced provider redelivery to resume it.
- Preserve the original root identity, admission deadline, and idempotency boundary.
- Bound reconnection attempts and surface a stable terminal error only after the recovery
  policy is exhausted.

### Make terminal projection authoritative

- On provider-root failure, atomically or idempotently project the provider error into
  `agent_runs`, terminal output metadata, and the status outbox.
- Prefer an existing authoritative failure over a later generic timeout/cancellation.
- Reconciliation must actively compare non-terminal CallAgent roots with terminal provider
  roots and converge them promptly.
- Preserve the original error code/message safely in Operator and API output.

### Add worker-stream health

- Track the last accepted worker heartbeat and the registration state of action, child,
  and durable streams.
- Return readiness `503` with a stable code such as
  `HATCHET_WORKER_STREAM_UNAVAILABLE` when the worker cannot accept/renew durable work.
- Keep liveness healthy so orchestration can restart or repair the worker.
- Do not report readiness restored until Hatchet accepts the worker heartbeat and all
  required streams are subscribed.

### Instrument long segments

Record, without credentials or payloads:

- event-loop delay percentiles;
- heartbeat send/ack/rejection timestamps;
- stream registration/reconnect generation;
- active provider segment duration;
- turn-claim renewal latency and failures;
- Hatchet and CallAgent PostgreSQL latency;
- the terminal source that won convergence.

## Required Tests

### Transport interruption

- Start a durable root, drop the worker-to-Hatchet gRPC connection, and restore it.
- Assert the root resumes and completes without resetting its absolute deadline.
- Repeat interruption during a long segment and between two provider segments.
- Force the old worker stream to become invalid and assert registration creates a usable
  replacement stream rather than repeatedly heartbeating the invalid ID.
- Verify only one fenced attempt may perform external side effects after recovery.

### Unrecoverable provider failure

- Exhaust transport recovery and force Hatchet to terminally fail the root.
- Assert `agent_runs` becomes `failed` promptly with the transport error.
- Assert status outbox and Operator expose the same failure.
- Run stale-run cleanup afterward and prove it cannot rewrite the failure as a timeout.

### Restart and reconciliation

- Kill CallAgent after Hatchet records root failure but before local projection.
- Restart it and assert reconciliation discovers and projects the terminal provider state.
- Test the same window before and after `task.state.project_failed` delivery.
- Verify no active lease, child, tool, timer, driver run, or outbox row remains afterward.

### Readiness

- Keep Hatchet REST schedule access healthy while invalidating the worker stream.
- Assert `/health` remains live and `/ready` returns `503` with
  `HATCHET_WORKER_STREAM_UNAVAILABLE`.
- Restore the worker stream and assert readiness recovers automatically.

### Consumer checkpoint acceptance

- Run a fixture that commits checkpoints across many bounded internal turns.
- Interrupt the durable stream after a committed checkpoint.
- Assert a redelivered run resumes at the next unit, makes no duplicate external mutation,
  and leaves no unowned artifact or temporary path.

## Acceptance Criteria

- The production failure sequence is covered by deterministic integration tests.
- A transient connection drop no longer terminally fails a durable root.
- An unrecoverable provider failure appears in `agent_runs` and Operator within the bounded
  reconciliation interval, retaining the original cause.
- Stale-run timeout never overwrites a known authoritative failure.
- Worker-stream rejection degrades readiness and pages operators before long work is lost.
- Retry/redelivery preserves fencing, idempotency, and the original absolute deadline.
- Existing root timeout, cancellation, supersession, restart, and turn-ownership tests pass.
- A real Hatchet/PostgreSQL soak with a CPU- and artifact-heavy checkpointing agent survives
  forced stream interruption and completes consistently.

## Operational Guidance Until Fixed

- Do not treat an Operator `running` state as authoritative when worker-stream errors exist.
- Alert on `worker stream is not active`, `DurableTask UNAVAILABLE`, and repeated listener
  reconnects.
- Before retrying a checkpointed consumer, verify its lease is released, checkpoint root
  hash and references are intact, and no prior provider root remains active.
- Avoid overlapping retries for the same family.

## Implementation Report Back

### What changed

The failure is now handled in two independent layers.

1. **Worker-stream supervision.** CallAgent uses Hatchet SDK `1.31.1` and
   starts every worker under a unique name derived from the workspace worker
   name plus a process instance suffix. It observes the long-lived worker loop,
   and also polls Hatchet's worker API every 10 seconds. A worker is considered
   healthy only when that exact instance is active, has a fresh heartbeat, and
   has all required CallAgent workflows registered.

   If the loop ends, the heartbeat becomes stale, or Hatchet marks the worker
   inactive, the worker stops accepting work, records
   `HATCHET_WORKER_STREAM_UNAVAILABLE`, and exits non-zero. Docker, systemd, or
   Kubernetes must restart it; CallAgent intentionally does not attempt to
   reconnect individual SDK listeners inside the damaged process.

2. **Authoritative terminal convergence.** Provider failures now converge
   through one SQL-backed path whether they arrive during a worker callback or
   are discovered later by periodic `runs.get_status` polling. That path:

   - CAS-writes the durable task terminal snapshot;
   - clears queued/active task-turn ownership from that terminal snapshot;
   - appends the authoritative `task.failed` event;
   - enqueues the final `task.status` outbox message under the terminal delivery
     key; and
   - drives the existing semantic projection used by Operator.

   A failure from a broken durable stream is classified as
   `HATCHET_DURABLE_STREAM_UNAVAILABLE`; other provider failures are
   `HATCHET_PROVIDER_FAILED`. Error messages are bounded before persistence.

### Timeout correction rule

Completed work, an operator cancellation, and an established domain failure are
immutable. The only correction allowed is the incident-specific race: if
Hatchet's provider failure predates a local `active_run_timeout`, the provider
failure replaces that timeout and records the timeout delivery key it
superseded. This prevents the six-hour stale-timeout outcome from obscuring the
original transport failure.

### Readiness and deployment behavior

`GET /health` continues to mean that the HTTP host is alive. With Hatchet
execution enabled, `GET /ready` now additionally requires a fresh
`RuntimeWorkerHealth` lease for the workspace's stable
`CALLAGENT_RUNTIME_INSTALLATION_ID`. It returns
`503 HATCHET_WORKER_STREAM_UNAVAILABLE` otherwise. Schedule REST failure stays
separate as `HATCHET_SCHEDULE_API_UNAVAILABLE`.

Generated workspaces now include the installation id and required worker
readiness setting. API-only hosts may explicitly use
`CALLAGENT_HATCHET_WORKER_READINESS=disabled` when workers are operated
elsewhere. The packaged Hatchet compose services are pinned to `v0.105.16`.

### Verification completed

- Built core, SQL memory, Hatchet driver, runtime, CLI, and worker packages.
- Ran the full Hatchet driver suite: **115 passing tests** (six intentionally
  skipped; one suite skipped).
- Added focused automated coverage for fresh/incomplete worker registration,
  provider failure convergence, timeout correction, and provider-status polling.

### Remaining closure evidence

The production-specific Hatchet/PostgreSQL integration drill still needs to
invalidate a real durable stream and prove process replacement/redelivery with
a checkpointing agent. The CPU/artifact-heavy soak and deployment-supervisor
restart proof are also pending. Until those drills pass, retain the operational
guidance above and treat this incident as remediated in code but not yet fully
closed in production evidence.
