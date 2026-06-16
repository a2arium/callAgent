# Hatchet Task Model Spec

## Goal

Use Hatchet as a native durable orchestrator while keeping APLRET cognition in
callAgent.

## Tasks

### `aplret.task` — durable control loop

Type: Hatchet durable task.

Responsibility:

1. Spawn `aplret.segment`.
2. Inspect `SegmentResult.boundary`.
3. For `await_input`, `await_tool`, `await_child`, or `external`, wait for a
   matching Hatchet event, then spawn the next `aplret.segment`.
4. For `sleep`, use durable sleep, then spawn the next `aplret.segment`.
5. Return on `complete` / `fail` / `canceled`.

There is no `continue` case: internal `continue` turns are consumed inside the
segment by `runLoop` and never reach the durable task (ADR 0002).

Allowed operations:

- durable event wait;
- durable sleep;
- child spawning;
- branching on prior checkpoint outputs (including tokens minted by a segment).

Forbidden operations:

- direct database reads/writes;
- LLM/tool calls;
- loading or mutating `MentalState`;
- generating tokens/ids or reading wall-clock time for control flow;
- calling `oneTurn` / `runLoop` directly.

### `aplret.segment` — non-deterministic child task

Type: regular Hatchet task.

Responsibility:

```text
TurnExecutor.runSegment({
  tenantId,
  taskId,
  agentId,
  wake,
  idempotencyKey,
})
```

A segment runs `runLoop` to the next durable boundary (await/sleep/terminal),
running internal `continue` turns in-process. It owns all callAgent side effects
for that segment. It is at-least-once; durable idempotency (ADR 0005) plus CAS
ensure one effective state transition. Stream events it produces are delivered
via the event bus, not Hatchet's native stream (ADR 0007).

### `aplret.outbox.dispatch`

Type: regular Hatchet task.

Responsibility:

1. Claim one outbox row.
2. Publish it using the existing event bus projection.
3. Mark it delivered/delete it.
4. Surface failures in Hatchet UI.

This replaces the poll loop per event type only after a feature flag cutover.

### `aplret.child.dispatch`

Type: regular or child task, depending on implementation.

Responsibility:

1. Start the child callAgent task.
2. Record mapping metadata.
3. On completion, push `aplret.child.<parentToken>`.

Parent fan-in remains callAgent state, not Hatchet workflow state.

### `aplret.timer.fire`

Type: event or regular task used by `TimerReconciler`.

Responsibility:

Push a timer wake into the durable loop or call `TurnExecutor.runSegment` if the
timer is recovered outside the active durable task.

## Metadata

Attach to every Hatchet run:

```ts
{
  tenantId,
  agentId,
  taskId,
  traceId,
  spanId,
  token,
  idempotencyKey,
  operation,
  tenantTaskKey: `${tenantId}:${taskId}`,
  tenantTraceKey: `${tenantId}:${traceId}`,
  taskTokenKey: `${taskId}:${token}`,
}
```

Composite keys are required because Hatchet task-run metadata filtering can use
OR semantics across multiple key/value pairs.

## Concurrency and fairness

| Concern | Hatchet setting |
|---|---|
| one in-flight turn per task | concurrency key `tenantId:taskId`, limit 1 |
| tenant fairness | Group Round Robin on `tenantId` |
| provider rate limits | dynamic key `llmProvider` or `agentId` |
| global worker capacity | worker slots |

Correctness still depends on CAS and idempotency; concurrency reduces wasted
contention.

## Event keys

```text
aplret.input.<token>
aplret.tool.<token>
aplret.child.<token>
aplret.timer.<token>
aplret.external.<token>
```

If Hatchet event scopes are used, scope should include `tenantId:taskId` to avoid
cross-task wake collisions.

## Driver run mapping

Persist exact joins in `driver_runs`:

```sql
driver_runs(
  id,
  provider,
  provider_run_id,
  provider_task_run_id,
  tenant_id,
  agent_id,
  task_id,
  token,
  trace_id,
  span_id,
  idempotency_key,
  operation,
  status,
  created_at,
  updated_at
)
```

Hatchet is an operator UI; `driver_runs` is the callAgent index and deep-link
source.

## POC environment

Use Docker Compose production profile (Postgres + RabbitMQ) for POC gates. Do
not rely on Hatchet Lite for crash/restart or dashboard-parity validation.
