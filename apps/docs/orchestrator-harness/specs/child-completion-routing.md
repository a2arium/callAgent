# Child Completion Routing (Deferred)

## Status

`handleChildCompleted` still calls `TaskExecutor.executeTurn` directly (~2778 in
`taskEngine.ts`). It is **not** routed through `runtimeDriver.enqueueResumeSync`.

## Why deferred (Phase 0)

Child resume is the most complex scheduling path in `TaskEngine`:

1. **Custom `EnvironmentState`** — builds a pre-hydrated `env.inbox` with
   `child.completed` and passes it straight to `executeTurn`, bypassing
   `TurnRunner` snapshot loading.
2. **CAS retry loops** — snapshot save + parent resume retry on `CAS_MISMATCH`
   (~2320–2835).
3. **`shouldResumeParent` gating** — resumes only when `meta.awaiting` matches
   the child token or a pending entry was observed before metadata persisted.
4. **Active-loop interaction** — overlaps with `LoopRegistry` injection paths
   documented in `deletion-inventory.md` Category C/D.

Routing through `runPreparedTurnThroughDriver` without replicating this logic risks
subtle regressions across 150+ `TaskEngine` tests.

## Phase 2 prerequisite

Before Hatchet child dispatch (Phase 2–3):

1. Collapse child resume to: snapshot already contains `child.completed` →
   `enqueueResumeSync` with `PreparedTurnInvocation` (trigger `resume`).
2. Or: `TurnExecutor.runSegment` with `child` wake + durable dedupe (ADR 0005).
3. Delete CAS/retry loops only after parity harness proves equivalent behavior.

## Idempotency key (when routed)

`${parentTaskId}:child:${token}` — align with ADR 0009 per-effect keys.
