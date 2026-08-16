# Spec: Harness Snapshot Fork (Phase 6b)

## Status

Ready for implementation. Independent of plan schema, but the motivating
tests are planning repair branches.
`adr/0009-harness-snapshot-fork-isolates-branches.md` is **Accepted**.

## Goal

Let a test freeze one harness state and open **two isolated branches**
from it (retry vs repair, old Policy vs new Policy) without shared
mutable `M` / pending / inbox / traces / stub queues.

Originating request §§13–14. This is a **test API**, not production
resume.

## Why this shape

| Request want | Phase 6b answer |
|---|---|
| `snapshot()` / `fork(snapshot)` | Yes |
| Reproduce M, control, pending, plan, provenance, clock, RNG | Yes, as listed below |
| Reuse production `Snapshot` type | **No.** Too small; would confuse resume |
| Seed `Math.random` process-wide | **No.** Optional `randomSeed` on harness config for loop sampling only |
| Serialize Policy/Learning functions | **No.** Fork reuses the same module functions; state must live in `M` / env |

## API

Home: `packages/core/src/testing/TestHarness.ts` + types in
`harnessTypes.ts`.

```ts
export type HarnessSnapshot = {
  readonly __brand: 'HarnessSnapshot';
};

export type TestHarness<Sensory = unknown> = {
  // ...existing...
  snapshot(): HarnessSnapshot;
  fork(snapshot: HarnessSnapshot): TestHarness<Sensory>;
};
```

`HarnessSnapshot` is **opaque** (branded). Tests must not poke fields.
Implementation may store cloned state on a private WeakMap or a
symbol-keyed object; do not export the inner shape.

`fork` returns a **new** `TestHarness`. The parent remains usable.
Forking twice from the same snapshot yields two independent children.

Do not add `createTestHarness({ fromSnapshot })` as a second required
entry. One method on the instance is enough. A static
`createTestHarness.fromSnapshot` is forbidden unless it needs modules —
modules live on the parent; `fork` copies module **references** and
cloned **state**.

### What is cloned

| State | Clone? |
|---|---|
| `MentalState` (`currentM`) | Yes, deep |
| `env` (time, turn, budget, inbox, pending, control) | Yes, deep |
| `inboxAll` / harness inbox history | Yes, deep |
| Traces so far | Yes, deep copy of array + objects |
| `replies()` | Yes |
| LLM/tool stub **remaining queues** | Yes, copy of queued items (independent consume) |
| Invite clock pin (`setInviteClockNow`) | Yes |
| `HarnessConfig` (maxTurns, deterministicTime, provenance, randomSeed) | Yes |
| `ctx` / `InternalTaskContext` | **New** context per fork (do not share) |
| Module functions | Same references |
| `TaskEngine` / `EngineLocator` global | Do not clone the process global. Tests that register an engine must not assume fork isolation of EngineLocator — document this limit |
| Operator DB / real SQL | Out of scope; harness tests use in-memory |

Deep clone: `structuredClone` where possible. If `MentalState` contains
values `structuredClone` rejects, fail `snapshot()` with a clear error
rather than silently sharing a reference.

### Isolation rule

After `const a = h.fork(s); const b = h.fork(s);`:

- `a.seedMentalState(...)` does not change `b.currentM()`;
- `a.injectObservation` / `runTurn` does not change `b.lastTrace()` /
  `b.currentM()` / stub queue length on `b`;
- mutating `a.currentM()` is already forbidden (readonly); tests that
  mutate via Learning only affect that fork’s next `M`.

### Clock and RNG

- `deterministicTime` already defaults true. Forks copy `env.time`.
- Optional `HarnessConfig.randomSeed: z.number().int().optional()`.
  When set, `oneTurn` Policy-array sampling uses a seeded PRNG
  **injected into that run**, not `Math.random`. When unset, keep
  `Math.random` (today).
- Do not seed `Date.now` process-wide.
- Do not add a general ID factory in this phase unless token seeding
  already has state — then copy it.

`policyParams.stochastic` tests that need reproducibility MUST pass
`randomSeed` and keep the same Policy array.

## Tests

New `packages/core/tests/testHarness.fork.test.ts`.

1. Seed `M.plans` + pending token; `snapshot()`; two forks; fork A
   `seedMentalState` changes a title; `b.currentM()` still has the
   original title.
2. Fork A `runTurn` with a Policy that completes; fork B `currentM()`
   and `allTraces().length` unchanged.
3. Stub queue: enqueue one LLM response on parent before snapshot; each
   fork can consume it independently (both get the copy, neither starves
   the other because of shared shift()).
4. Same `randomSeed` + identical Policy array + `stochastic: true` →
   same sampled `intent.kind` on both forks for that turn (if this is
   expensive, one focused test).
5. `snapshot()` object is not the live state: mutating harness after
   snapshot then forking still restores snapshot-time `M`.

Type tests: `fork` returns `TestHarness`; `HarnessSnapshot` is not
assignable to `Snapshot` from `loop/types.ts`.

Existing `testHarness.test.ts` must stay green. Do not change
`seedMentalState` merge semantics.

### Known regression review

| Failure | Action |
|---|---|
| Tests that mutated shared module-level variables | Test bug; document. Do not freeze user modules |
| `EngineLocator` singleton leaked across forks | Document; do not “fix” by hiding the global in this spec |
| `structuredClone` on functions in `M` | Fail snapshot loudly; agents must not put functions in `M` |
| `deterministicTime` tests | Unrelated; keep default true |
| Production resume `Snapshot` | Do not change that type to match the harness |

Run `yarn test` and `yarn test:types` in `packages/core`.

## Docs to update in the **same change set**

| Doc | What to change |
|---|---|
| `apps/docs/11-how_to_test_aplret_agents.md` | `snapshot` / `fork` API; isolation; stateful-module pitfall; `randomSeed` only for stochastic sampling. Tests that register a `TaskEngine` / `EngineLocator` are **not** isolation-safe. |
| `apps/docs/12-how_to_debug_with_turn_trace.md` | Forks have their own `allTraces()`. |
| `apps/docs/9-how_to_implement_planning_without_breaking_policy_purity.md` | Repair A/B: snapshot at failure, fork retry vs `repair_plan`. |

Do **not** describe this as production time-travel.

## Out of scope

- Production `Snapshot` / session resume changes
- Process-wide RNG
- Cloning `TaskEngine` / SQL
- Serializing module closures
- `PlanPatch` (sibling spec)

## Acceptance

- Isolation tests pass (A cannot mutate B).
- Snapshot is opaque; production `Snapshot` unchanged.
- `randomSeed` is optional and off by default.
- Docs agree.
- `yarn test` and `yarn test:types` in `packages/core` are green.

## Implementation order

1. Opaque snapshot clone of harness internals.
2. `fork` builds a new harness with cloned state + new `ctx`.
3. Optional `randomSeed` plumbing into `oneTurn` sampling only.
4. Isolation tests + tsd.
5. Docs.
6. Full core `yarn test` + `yarn test:types`.
