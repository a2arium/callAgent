# Runtime Driver Port Spec

## Goal

Provide a small port that lets callAgent run with or without a durable
orchestrator. The port controls **when** work runs. The shared kernel controls
**what one APLRET segment does** (see `turn-executor-kernel.md`).

## Layering

```text
agent modules
  ↓
oneTurn / runLoop / TaskExecutor        (shared kernel)
  ↓
TurnExecutor.runSegment                 (segment port: run to next boundary)
  ↓
RuntimeDriver                           (in-process or Hatchet)
```

`packages/core` owns the public driver and executor types. `packages/driver-hatchet`
implements the Hatchet adapter. No public agent API imports Hatchet types.

## Proposed public-internal types

These are internal framework types, not agent-author APIs. Names may change in
implementation, but the shape is the contract.

```ts
export type RuntimeOperation =
  | 'start'
  | 'resume'
  | 'timer.fire'
  | 'child.dispatch'
  | 'outbox.dispatch'
  | 'cancel';

export type RuntimeDriverIds = {
  tenantId: string;
  taskId: string;
  agentId?: string;
  traceId?: string;
  spanId?: string;
  token?: string;
  idempotencyKey: string;
};

export type RuntimeWakeEvent =
  | { kind: 'input'; token: string; value: unknown }
  | { kind: 'tool'; token: string; result: unknown }
  | { kind: 'child'; token: string; childTaskId: string; output: unknown }
  | { kind: 'timer'; token: string; timerId: string; payload?: unknown }
  | { kind: 'external'; token: string; type: string; data: unknown }
  // conversation transport stays out of scope; the conversation layer translates
  // a delivered message into this wake via enqueueResume (ADR 0008).
  | { kind: 'conversation'; token: string; messageId: string; data: unknown };

export type RuntimeDriver = {
  enqueueStart(params: RuntimeDriverIds & { input: unknown }): Promise<void>;
  enqueueResume(params: RuntimeDriverIds & { event: RuntimeWakeEvent }): Promise<void>;
  enqueueChildDispatch(
    params: RuntimeDriverIds & {
      parentTaskId: string;
      childTaskId: string;
      childAgentId: string;
      input: unknown;
    }
  ): Promise<void>;
  scheduleTimer(
    params: RuntimeDriverIds & { token: string; fireAt: string; payload?: unknown }
  ): Promise<{ timerId: string }>;
  cancel(params: RuntimeDriverIds & { reason: string }): Promise<void>;
  dispatchOutbox(params: { outboxRowId: string; eventType: string }): Promise<void>;
};
```

## In-process driver behavior

`InProcessRuntimeDriver` reproduces today's behavior:

- start/resume calls happen immediately;
- background task promises remain in-process;
- outbox dispatch uses the current poller until Phase 1 changes it;
- local tests require no Hatchet service.

This driver is the default.

## Hatchet driver behavior

`HatchetRuntimeDriver` maps the same operations to Hatchet tasks/events:

| Driver call | Hatchet mapping |
|---|---|
| `enqueueStart` | trigger `aplret.task` durable loop |
| `enqueueResume` | push `aplret.<kind>.<token>` event |
| `enqueueChildDispatch` | spawn/trigger child task, completion pushes parent event |
| `scheduleTimer` | durable sleep in `aplret.task` + reconciler |
| `cancel` | mark callAgent snapshot (authoritative), cancel Hatchet runs best-effort (ADR 0010) |
| `dispatchOutbox` | trigger `aplret.outbox.dispatch` |

Retry policy (ADR 0009): a handler that **throws** is a transient error and is
retried by Hatchet up to a bounded attempt count; a segment that returns a `fail`
boundary is terminal and must **not** be retried (return success-with-fail, do
not throw). Per-effect idempotency keys make retried segments collapse to one
effect.

## Driver selection

Driver selection happens at the composition root:

```text
CALLAGENT_RUNTIME_DRIVER=in-process | hatchet
```

Runtime selection is atomic. A configured Hatchet runtime owns loop starts,
asynchronous resumes, and durable timers; it never delegates an individual
correctness-critical surface back in-process. `CALLAGENT_DRIVER_SURFACES` is
obsolete and rejected during Hatchet bootstrap.

## Acceptance

- D1: no Hatchet type above adapter package.
- D5: current tests pass with `InProcessRuntimeDriver`.
- B1/B3/B8: Hatchet resume path is safe and measured.
