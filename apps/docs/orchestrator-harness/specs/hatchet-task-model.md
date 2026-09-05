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

`aplret.task` is the only durable root workflow. Agent identity is metadata, not a
workflow-name routing mechanism. Development and test Hatchet histories created by
older workflow names must be reset before these workers start.

There is no `continue` case: internal `continue` turns are consumed inside the
segment by `runLoop` and never reach the durable task (ADR 0002).

Allowed operations:

- durable event wait;
- durable sleep;
- child spawning;
- branching on prior checkpoint outputs (including tokens minted by a segment).

All state reads, timer bookkeeping, outbox lookup, cancellation inspection, cache
access, and terminal projection are keyed `aplret.task-state` children. Stateful
dependencies are deliberately withheld from the durable root implementation.

Forbidden operations:

- direct database reads/writes;
- LLM/tool calls;
- loading or mutating `MentalState`;
- generating tokens/ids or reading wall-clock time for control flow;
- calling `oneTurn` / `runLoop` directly.

### `aplret.task-state` — idempotent state/projection child

Type: regular Hatchet task.

Responsibility: perform one deterministic-keyed database, cache, timer, recovery,
or projection operation requested by the durable root. Retried executions must be
idempotent. This child is the only bridge from root orchestration to application
state.

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
timer is recovered outside the active durable task. Detailed timer state,
idempotency, races, reconciler behavior, and B2 acceptance live in
`timer-wakes.md`.

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

## Run grouping (operator UI)

Hatchet groups runs in the dashboard via parent-child spawning, not via shared
metadata. A run is nested under a parent only when it is spawned from inside a
parent task with `ctx.runChild` / `ctx.runNoWaitChild` / `ctx.bulkRunChildren`
(or durable `ctx.spawnChild` / `ctx.spawnChildren`). Metadata (the composite
keys above) only powers search/filter; it does not nest runs.

Requirement: `aplret.task` is the single parent Hatchet run
per callAgent task, and all per-task work is spawned as its children:

```text
aplret.task                 (parent run; metadata: tenantId, taskId, rootTaskId, agentId, traceId)
├─ aplret.task-state        (state/recovery/projection)
├─ aplret.segment           (runLoop to next boundary)
├─ aplret.outbox.dispatch   (task.status)
├─ aplret.outbox.dispatch   (task.input_required)
└─ aplret.child.dispatch    (when applicable)
```

This is what keeps the top-level run list readable. The Phase 1 model — where the
runtime host triggers each `aplret.outbox.dispatch` via an external top-level
`runNoWait` — produces ungrouped sibling runs (one per outbox row) and is only
acceptable for the outbox-only POC. Once `aplret.task` exists (Phase 2),
outbox dispatch for a task with an active parent run must route through that
parent. External top-level dispatch remains only as a fallback (no active parent
run / pre-Phase-2 / trigger failure).

This Hatchet grouping is **not** the product operator model. The product model is
the callAgent `AgentRunGraph` (`apps/docs/operator-run-graph.md`), where:

- parent workflow runs project to `AgentRun`;
- child agent calls project to `AgentRunEdge`;
- `aplret.segment` projects to `TurnRun`;
- `aplret.outbox.dispatch` projects to hidden-by-default `EffectRun`.

Operators should not need to understand `aplret.*` names. Hatchet workflow names
and run ids are debug links attached to the semantic graph.

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

Hatchet is an infrastructure UI; `driver_runs` is the provider index and
deep-link source. The operator-facing API must project or persist a semantic
`AgentRunGraph` and should not ask users to interpret raw `driver_runs` rows.

Graph-only fields such as `rootTaskId`, `parentTaskId`, `parentAgentId`,
`childTaskId`, `childAgentId`, `edgeToken`, `edgeKind`, `turnSeq`,
`boundary.kind`, and `turnTraceId` belong in normalized graph persistence
(`agent_runs`, `agent_run_edges`, `turn_runs`, `effect_runs`) or in the
projection contract, not necessarily in `driver_runs`.

## POC environment

Use Docker Compose production profile (Postgres + RabbitMQ) for POC gates. Do
not rely on Hatchet Lite for crash/restart or dashboard-parity validation.
## Worker-lifetime recovery

The exact Hatchet worker process is part of an active turn's internal ownership
identity. Loss of that worker is not an agent failure. A trusted worker-lifetime
abort immediately fences managed mutations and stages the canonical
`taskId:turn-request:generation` recovery intent through the coordinator snapshot
CAS. Recovery keeps the generation and logical turn but creates a new claim and
higher fence on an eligible replacement worker.

The original storage-clock root deadline is the only recovery limit. A deadline
that expires while the worker recovery intent is unresolved produces
`HATCHET_WORKER_RECOVERY_DEADLINE_EXCEEDED`. Arbitrary external calls outside
registered effects cannot be rolled back and must use application idempotency.

Operator preserves `task → logical segment → execution attempt → cognitive turn`.
Recovery reuses the logical segment and adds a higher-fence attempt. Bounded
`meta.turnRecoveries` metadata records the canonical dispatch key, reason, source claim,
and optional replacement claim for diagnostics; the coordinator remains scheduling
authority.
