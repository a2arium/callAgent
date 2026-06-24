# Phase 5C Observability and Failure Drill Runbook

Status: draft implementation runbook.
Last updated: 2026-06-24.

Phase 5C introduces internal observability for the Hatchet harness and operator
surface. The first implementation exposes process-local JSON metrics at
`GET /metrics`; Prometheus/OpenTelemetry export remains a later integration
unless the production deployment requires it before Phase 5D.

## Metrics Contract

The metrics endpoint returns:

```json
{
  "ok": true,
  "metrics": {
    "generatedAt": "2026-06-24T00:00:00.000Z",
    "uptimeMs": 1234,
    "seriesCount": {
      "total": 0,
      "counters": 0,
      "gauges": 0,
      "durations": 0
    },
    "limits": {
      "durationSampleLimit": 512,
      "maxSeriesTotal": 2000,
      "maxSeriesPerMetric": 200
    },
    "droppedSeriesCount": 0,
    "counters": [],
    "gauges": [],
    "durations": [],
    "alerts": []
  }
}
```

Metric dimensions are string-normalized. Metrics are best-effort only and must
not change runtime behavior.

## Cardinality and Memory Policy

Metrics must be safe for long-running workers. The registry enforces this in two
ways:

- only allow-listed, low-cardinality labels are kept;
- total series and per-metric series are capped, with excess routed to
  `cardinality="overflow"` and counted in
  `observability.metric_cardinality_dropped_total`.

The endpoint reports:

- `seriesCount.total`;
- per-kind series counts;
- `limits.durationSampleLimit`;
- `limits.maxSeriesTotal`;
- `limits.maxSeriesPerMetric`;
- `droppedSeriesCount`.

Allowed labels:

- `cardinality`;
- `code`;
- `errorCode`;
- `eventType`;
- `kind`;
- `level`;
- `method`;
- `metric`;
- `operation`;
- `phase`;
- `route`;
- `status`;
- `surface`;
- `type`.

Forbidden labels include task/run identifiers and other unbounded values:

- `taskId`;
- `rootTaskId`;
- `childTaskId`;
- `parentTaskId`;
- `agentId`;
- `tenantId`;
- `traceId`;
- `spanId`;
- `token`;
- `providerRunId`;
- `providerTaskRunId`;
- `outboxRowId`;
- `timerId`;
- `idempotencyKey`.

Those identifiers belong in bounded semantic incident payloads, operator graph
details, logs, or raw drill evidence, not metric labels.

## Required Signals

Operator API:

- `operator.api_request_total`
- `operator.api_request_ms`
- `operator.api_error_total`

Hatchet/runtime:

- `runtime.worker_task_total`
- `runtime.worker_task_ms`
- `hatchet.enqueue_total`
- `hatchet.cancel_total`

Timer reconciler:

- `runtime.timer_due_count`
- `runtime.timer_lag_ms`
- `runtime.timer_reconcile_ms`
- `runtime.timer_reconcile_failure_total`

Payload and log health:

- `payload.event_size_bytes`
- `payload.snapshot_size_bytes`
- `payload.budget_failure_total`
- `observability.log_sink_failure_total`
- `observability.metric_cardinality_dropped_total`

Retry/DLQ/fallback health:

- `runtime.retry_total`
- `runtime.dead_letter_total`
- `runtime.inline_fallback_total`
- `runtime.outbox_dispatch_total`

Semantic incident visibility:

- provider enqueue failures with task context append `observability.incident`
  working-memory events;
- `observability.incident` projects into operator `run_effects` and the run
  graph as failed observability effects.

## Alert States

The internal endpoint derives warning states for:

- timer lag above `CALLAGENT_ALERT_TIMER_LAG_MS` (default `60000`);
- operator API route p95 above `CALLAGENT_ALERT_API_P95_MS` (default `2000`);
- any log sink failure.

These are local warning states, not paging integrations.

## Drill Record Template

For every Phase 5C drill, record:

- date/time;
- git commit;
- runtime config and enabled driver surfaces;
- dataset or task id(s);
- commands used;
- expected result;
- actual result;
- metrics snapshot excerpt;
- operator graph/detail evidence;
- follow-up bugs.

## P3 — Worker Task Failure

Goal: worker task failure is visible in logs, metrics, and operator effects when
task context exists.

Steps:

1. Start the runtime in Hatchet mode.
2. Run an agent that reaches a known failing segment or semantic failure.
3. Capture `GET /metrics`.
4. Open the operator run detail page.

Expected:

- `runtime.worker_task_total{status="failed"}` increments for the failing task;
- `runtime.worker_task_ms{status="failed"}` is present;
- the operator summary shows the semantic failure code/message when available;
- raw Hatchet logs remain debug-only.

## P4 — Timer Reconciler Lag

Goal: timer lag and reconciler failures are observable.

Steps:

1. Create or identify an overdue durable timer.
2. Start the worker and wait for reconciler scan.
3. Capture `GET /metrics`.

Expected:

- `runtime.timer_due_count` shows due timers during scan;
- `runtime.timer_lag_ms` records the max due lag;
- `hatchet.enqueue_total{operation="timer.fire",status="completed"}` increments;
- if timer persistence or enqueue fails, `runtime.timer_reconcile_failure_total`
  and failed enqueue metrics increment.

## P5 — Provider Enqueue Failure

Goal: provider enqueue failures are not silent.

Steps:

1. Enable a Hatchet driver surface such as `start`.
2. Make the provider enqueue fail, for example by stopping Hatchet before a run.
3. Start an agent run.
4. Capture `GET /metrics` and operator detail.

Expected:

- `hatchet.enqueue_total{status="failed"}` increments for the operation;
- an `observability.incident` event is appended when task context exists;
- the operator graph shows a failed observability effect;
- the original runtime failure is not hidden by observability code.

## P6 — Log Sink Degradation

Goal: Hatchet log sink failures do not mask the original task outcome.

Steps:

1. Simulate or trigger Hatchet logger failure.
2. Run a successful and a failing task.
3. Capture `GET /metrics`.

Expected:

- successful task still completes;
- failing task still throws the original execution error;
- `observability.log_sink_failure_total` increments;
- alert `log_sink_failure` appears in warning state.

Recorded controlled drill result:

- Date/time: 2026-06-24T10:19:18Z.
- Commit: `a93d274` plus the uncommitted Phase 5C observability hardening
  working tree.
- Config: no live Hatchet service required; controlled test context injects a
  Hatchet logger whose `info` and `error` calls throw.
- Command:

```bash
yarn jest packages/driver-hatchet/tests/hatchetLogging.test.ts --runInBand
```

- Expected:
  - successful task still resolves to `ok`;
  - failing task rethrows the original `execution failed` error;
  - `runtime.worker_task_total` records started/completed/failed task states;
  - `runtime.worker_task_ms` records task duration;
  - `observability.log_sink_failure_total` increments;
  - metrics remain low-cardinality and do not include task/run identifiers.
- Actual:
  - test passed;
  - successful task resolved to `ok`;
  - failing task rethrew the original execution error;
  - assertions verified `observability.log_sink_failure_total`,
    `runtime.worker_task_total`, and `runtime.worker_task_ms`.
- Metrics excerpt asserted by the drill:

```json
{
  "counters": [
    {
      "name": "observability.log_sink_failure_total",
      "count": 2,
      "dimensions": {
        "operation": "agent.run",
        "level": "info"
      }
    },
    {
      "name": "runtime.worker_task_total",
      "dimensions": {
        "operation": "agent.run",
        "status": "completed"
      }
    },
    {
      "name": "runtime.worker_task_total",
      "dimensions": {
        "operation": "aplret.segment",
        "status": "failed",
        "errorCode": "TypeError"
      }
    }
  ]
}
```

- Operator graph/detail evidence: not applicable for this controlled log-sink
  drill; no task context is persisted.
- Follow-up bugs: none from the controlled drill. Run a live P5 provider-enqueue
  drill before declaring all Phase 5C failure drills complete.

## Not Covered Yet

- Prometheus scrape endpoint.
- OpenTelemetry traces/metrics.
- paging/alert routing.
- historical aggregation across process restarts.
- live provider-enqueue drill evidence.
- 100k-run volume evidence.
