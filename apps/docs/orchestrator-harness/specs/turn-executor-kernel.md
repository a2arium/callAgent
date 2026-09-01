# Turn Executor Kernel Spec

## Goal

Extract the minimum reusable kernel that both drivers need:

> Load a task snapshot, append one wake observation, run the existing `runLoop`
> to the next **durable boundary** (a "segment"), persist the result, and return
> the typed boundary outcome.

A **segment** is one execution of `runLoop` that runs internal `continue` turns
in-process and returns only at a durable boundary: `await_input` / `await_tool` /
`await_child`, a sleep, or terminal `complete` / `fail`. Internal `continue`
turns never cross the driver boundary (see ADR 0002). This is the unit both
drivers schedule.

This is the boundary that lets Hatchet use native durable control while keeping
callAgent cognition unchanged.

Identity is deliberately layered: `turnSeq` identifies this durable segment,
`cognitiveTurnSeq` identifies each internal `continue` iteration, `generation`
identifies accepted demand, and `claimId`/fence/provider `attemptSeq` identify
execution attempts. Recovering the same generation must reuse its `turnSeq`.

## Existing implementation to reuse

The kernel already mostly exists:

- `packages/core/src/orchestration/TaskExecutor.ts`
  - `executeTurn(...)` loads/updates snapshots around `runLoop`.
- `packages/core/src/orchestration/TurnRunner.ts`
  - builds env/inbox and adapts start/resume/event triggers.
- `packages/core/src/loop/loopRunner.ts`
  - multi-turn loop until await/terminal/budget.
- `packages/core/src/loop/oneTurn.ts`
  - the APLRET stage pipeline.

Phase 0 should wrap this; it should not rewrite it.

## Proposed contract

```ts
export type TurnTrigger =
  | 'start'
  | 'resume'
  | 'tool'
  | 'child'
  | 'timer'
  | 'event'
  | 'conversation';

export type TurnWake =
  | { trigger: 'start'; input: unknown }
  | { trigger: 'resume'; event: RuntimeWakeEvent }
  | { trigger: 'tool'; event: RuntimeWakeEvent }
  | { trigger: 'child'; event: RuntimeWakeEvent }
  | { trigger: 'timer'; event: RuntimeWakeEvent }
  | { trigger: 'event'; event: RuntimeWakeEvent }
  | { trigger: 'conversation'; event: unknown };

// The boundary is what the driver schedules on. `continue` is NOT a boundary:
// it is consumed inside the segment by runLoop and never returned here.
export type SegmentBoundary =
  | { kind: 'await_input'; token: string; expiresAt?: string }
  | { kind: 'await_tool'; token: string }
  | { kind: 'await_child'; token: string }
  | { kind: 'sleep'; token: string; fireAt: string }
  | { kind: 'paused'; reason: string }
  | { kind: 'complete'; result?: unknown }
  | { kind: 'fail'; error: unknown };

export type SegmentResult = {
  tenantId: string;
  taskId: string;
  agentId?: string;
  boundary: SegmentBoundary;
  taskStatus: 'working' | 'input-required' | 'completed' | 'failed' | 'canceled';
  traceId?: string;
  turnTraceId?: string;
};

export type TurnExecutor = {
  runSegment(params: {
    tenantId: string;
    taskId: string;
    agentId?: string;
    wake: TurnWake;
    idempotencyKey: string;
  }): Promise<SegmentResult>;
};
```

## Semantics

1. `runSegment` runs `runLoop` to the next durable boundary; internal `continue`
   turns happen in-process and are never surfaced to the driver.
2. It is idempotent by `idempotencyKey`: a duplicate call for an already-applied
   wake is a no-op that returns the current boundary (see ADR 0005 — durable
   dedupe, not just CAS).
3. It appends at most one wake observation to `inbox.current` per distinct
   `idempotencyKey`.
4. It persists exactly one effective snapshot transition.
5. It emits/persists canonical stream/session events as today's runtime does
   (delivered via the event bus; see ADR 0007).
6. It returns the boundary to the driver. Any token in the boundary is a
   checkpoint output the driver may wait on (ADR 0002 — token provenance).

## Hatchet usage

`aplret.segment` is a regular Hatchet task:

```text
input: { tenantId, taskId, agentId, wake, idempotencyKey }
body:  return turnExecutor.runSegment(input)
```

The Hatchet durable task never calls `runLoop` directly. It only spawns
`aplret.segment` and branches on the returned `SegmentResult.boundary`.

## In-process usage

`InProcessRuntimeDriver` can call `turnExecutor.runSegment` directly when a wake
arrives. This provides parity between drivers and makes tests target the shared
kernel instead of duplicated start/resume paths.

## Non-goals

- Do not expose this API to agent authors.
- Do not change APLRET module signatures.
- Do not collapse streaming, TurnTrace, or snapshot persistence into Hatchet.

## Resolved decisions

- **Granularity:** the unit is a segment (`runLoop` to next durable boundary),
  not a single `oneTurn`. Resolved in ADR 0002.
- **Idempotency:** a durable dedupe is required before Hatchet mode is used
  outside local POC; the in-memory RPC store is insufficient. Resolved in
  ADR 0005.

## Extraction hazards (for the implementer)

`runLoop` is not a pure function today. Wrapping it must account for:

- it mutates `ctx` and attaches `__activeLoopInbox` / `__activeLoopEnv`;
- it reads the session store mid-loop (`loopRunner` ~1489);
- it calls the global `EngineLocator` for the topic sweeper (`loopRunner` ~854).

The last point matters across processes: a Hatchet worker is a separate process
where the `EngineLocator` singleton is not the API host's. See
`specs/worker-runtime.md`.
