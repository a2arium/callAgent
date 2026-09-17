# Worker Runtime Spec

## Goal

Define what a Hatchet worker process must construct so that `aplret.segment` and
the other `aplret.*` tasks behave identically to the in-process driver. A worker
is a **separate OS process** from the API host; nothing in-process can be assumed
to "already exist" there.

## Why this spec exists

`runLoop` / `TaskExecutor` are not self-contained. They reach a composition root
and a process-global singleton:

- `EngineLocator` is a process-global. `loopRunner` (~854) uses it for the topic
  sweeper. On a worker this singleton is **not** the API host's instance.
- The loop reads the session store mid-loop (`loopRunner` ~1489).
- Snapshot persistence, event bus, memory, LLM, tool registry, and plugins are
  all injected at the `TaskEngine` constructor today.

If a worker boots without an equivalent composition root, segments will fail or,
worse, silently diverge (e.g. publish to an in-memory bus nobody reads).

## What a worker must construct

Each worker process must build the same dependency graph the API host builds,
minus the HTTP/SSE surface:

```text
worker bootstrap:
  - load config (same schema as API host)
  - construct SnapshotRepository (same Postgres)
  - construct IEventBus  ->  cross-process bus (NATS) REQUIRED (ADR 0007)
  - construct memory adapters (same backends)
  - construct LLM clients + tool registry + plugins (same registration)
  - construct TaskEngine / TurnExecutor
  - initialize EngineLocator for THIS process
  - register aplret.* task handlers with the Hatchet SDK
  - start the Hatchet worker (gRPC connect)
```

### Single registration path

Agent/tool/plugin registration must be a shared bootstrap function imported by
both the API host and the worker. Divergence here is the most likely source of
"works in-process, fails on worker" bugs. There must be exactly one place that
wires agents, tools, plugins, memory, and LLM providers.

## Process-global hazards

| Hazard | In-process today | On a worker |
|---|---|---|
| `EngineLocator` singleton | host's instance | must be initialized per worker process |
| In-memory event bus | host publishes + subscribes | publisher and subscriber are different processes -> needs NATS |
| In-memory RPC `IdempotencyStore` | host-local, TTL | not shared across host+workers -> use durable dedupe (ADR 0005) |
| Active-loop injection (`__activeLoopInbox`) | same process | scoped to the worker run; never assume host visibility |

## Topology (v1)

Per research A5: one global worker pool per environment.

```text
runtime-host (API)
  └─ InProcessRuntimeDriver for hot chat/SSE
hatchet-worker pool (N processes, identical bootstrap)
  ├─ aplret.segment
  ├─ aplret.task (durable control loop)
  ├─ aplret.timer.fire
  ├─ aplret.child.dispatch
  └─ aplret.outbox.dispatch
```

Concurrency/fairness keys (Hatchet-native):

```text
per-task serialization: `${tenantId}:${taskId}` limit 1
tenant fairness:        groupKey = tenantId, GROUP_ROUND_ROBIN
provider rate:          key = agentId | llmProvider
worker slots:           bounded per worker process
```

Split into per-tenant / per-agent / outbox-only pools later, only when metrics
justify it.

## Package boundary

```text
packages/runtime-core    RuntimeDriver + TurnExecutor types, InProcessRuntimeDriver
packages/driver-hatchet   HatchetRuntimeDriver, aplret.* handlers, worker bootstrap
apps/runtime-host         selects driver from config; runs API + InProcess path
apps/<worker>             imports shared bootstrap + driver-hatchet; no HTTP
```

No Hatchet import above `packages/driver-hatchet`. No agent code imports Hatchet
types (ADR 0001 / 0005, D1).

## Open Validation

- Boot a worker with zero in-memory shortcuts; run a full task start ->
  await_tool -> resume -> complete entirely on workers.
- Kill a worker mid-segment; another worker picks up; one effective transition
  (B1) and identical SSE output via NATS (ADR 0007 parity test).
- Confirm shared bootstrap is the only registration path (no host-only agents).
