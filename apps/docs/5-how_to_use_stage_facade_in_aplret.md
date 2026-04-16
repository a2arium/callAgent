# How-to: Use StageFacade in APLRET

Use this guide when your agent has non-trivial control flow and you want a consistent, safe way to manage stages, invariants, and stage-related control marks.

## Goal

- Keep stage management explicit and centralized.
- Enforce control-plane invariants at runtime.
- Make stage transitions predictable for humans and LLMs.
- Keep stage logic out of cognition.

## What StageFacade is for

StageFacade is the **control-plane helper** for stageful agents.

Use it to:

- define the closed stage union for an agent
- declare per-stage invariants
- apply automatic control marks when entering a stage
- run safe stage-entry hooks
- keep stage checks and stage writes consistent

It exists to reduce scattered `if (stage === ...)` logic and inconsistent writes to pending/control state.

## What StageFacade is not for

Do **not** use stages or stage marks to represent semantic truths.

Stage is **control**, not cognition.

Do not encode facts like:

- `customer_verified`
- `invoice_overdue`
- `fraud_clear`

Those belong in `MentalState` through Learning.

Stage and stage marks should encode only orchestration facts such as:

- current control stage
- whether an entry hook already ran
- pending control tokens
- idempotency / progress control marks

## Non-negotiable rules

- Stage lives in control state, not in `MentalState`.
- Policy must not read stage directly.
- Learning must not write stage.
- Stage writes should go through StageFacade, not ad hoc helpers.
- Invariants should describe control requirements only.

If the agent maintains **`flow.md`**, the **Stages** subsection there should list the **same stage names** as your stage union / `createStageFacade` configuration (exact spelling). That keeps procedural docs, StageFacade, and traces aligned. See [How-to: `flow.md` for APLRET agents](./13-flow_md_for_aplret_agents.md).

## When to use StageFacade

Use StageFacade when your agent has at least one of these:

- more than one await state
- stage-specific required tokens
- stage-specific forbidden marks
- entry actions such as progress updates
- repeated bugs from inconsistent control-state writes

Do not use it for trivial one-stage flows.

## Canonical example

```ts
import { createStageFacade, defineControlKeys } from '@a2arium/callagent-core';

const stages = ['idle', 'awaiting_fetch', 'analyzing', 'completed'] as const;
type AgentStage = (typeof stages)[number];

export const CK = defineControlKeys({
  fetchToken: 'fetch.token',
  completedCalled: 'completed.called',
  awaitingFetchCalled: 'awaiting_fetch.called',
  analyzingCalled: 'analyzing.called',
});

export const Stage = createStageFacade<AgentStage>({
  stages,
  initial: 'idle',
  invariants: {
    idle: { forbid: [CK.fetchToken, CK.completedCalled] },
    awaiting_fetch: { require: [CK.fetchToken], forbid: [CK.completedCalled] },
    analyzing: { forbid: [CK.completedCalled] },
    completed: {},
  },
  autoMarks: {
    awaiting_fetch: { [CK.awaitingFetchCalled]: true },
    analyzing: { [CK.analyzingCalled]: true },
    completed: { [CK.completedCalled]: true },
  },
  onEnter: {
    idle: (ctx) => ctx.progress(5, 'idle'),
    awaiting_fetch: (ctx) => ctx.progress(20, 'awaiting fetch result'),
    completed: (ctx) => ctx.complete(100, 'completed'),
  },
});
```

`onEnter` callbacks receive **`StageEnterContext`** (only `progress` and `complete`), not full `TaskContext`. Use `Stage.get(ctx)`, `Stage.set(ctx, stage)`, `Stage.is(ctx, stage)`, `Stage.assert(ctx, stage?)`, and `Stage.summary(ctx)` for the normalized shape `{ current, hasPendingInput, hasPendingTool, hasPendingChild, markCount }`. `Stage.set()` returns a **`StageTransitionResult`** (`from`, `to`, `autoMarksApplied`, `invariantChecks`).

## Design the stage union first

Make stages a **closed union**.

```ts
type Stage =
  | 'idle'
  | 'awaiting_fetch'
  | 'analyzing'
  | 'awaiting_validation_fetch'
  | 'validating'
  | 'completed';
```

Rules:

- use a small, explicit vocabulary
- stage names should describe control status, not business meaning
- prefer `awaiting_*`, `running_*`, `completed`, `failed`
- **Contract Rule**: If a stage name starts with `awaiting_`, it *must* declare a `require: [...]` invariant for its corresponding token.

## Write invariants as control requirements

Each stage should declare only what must be present or absent in control state.

Good invariants:

- `awaiting_fetch` requires `fetch.token`
- `completed` forbids pending await tokens
- `idle` forbids stale completion flags

Bad invariants:

- `validating` requires `invoice.status = paid`
- `analyzing` requires `worldModel.entities.length > 0`

Those are cognitive/business facts and do not belong in stage invariants.

## Use typed control keys where possible

Avoid sprinkling raw string paths everywhere.

Instead of repeating:

- `'fetch.token'`
- `'completed.called'`
- `'awaiting_fetch.called'`

prefer a shared control-key map via **`defineControlKeys`**:

```ts
import { defineControlKeys } from '@a2arium/callagent-core';

export const CK = defineControlKeys({
  fetchToken: 'fetch.token',
  validationToken: 'validation.token',
  completedCalled: 'completed.called',
  awaitingFetchCalled: 'awaiting_fetch.called',
});
```

Then build invariants and autoMarks from `CK` (e.g. `require: [CK.fetchToken]`).

This reduces drift and makes refactoring safer.

## Use autoMarks for orchestration, not meaning

AutoMarks are useful for:

- “entry hook already ran” flags
- idempotency markers
- stage entry bookkeeping

Good:

- `'awaiting_fetch.called'`
- `'completed.called'`

Bad:

- `'customer_verified'`
- `'fraud_safe'`

If the mark would still matter to Policy after the stage changes, it probably belongs in `MentalState`, not in control marks.

## Keep onEnter safe

`onEnter` is powerful, so constrain it.

### Recommended rule

`onEnter` may perform **telemetry-style runtime calls only**.

Allowed examples:

- `ctx.progress(...)`
- `ctx.complete(...)` if completion is treated as runtime status emission

Not allowed:

- tool calls
- child-agent dispatch
- LLM calls
- user replies
- input requests
- writes to external systems

Why:

- those are real effects and belong in Execution
- otherwise StageFacade becomes a hidden effect runner

If your framework wants stricter purity, an alternative is to make `onEnter` return entry actions as data and let Transition/Execution apply them.

## Where StageFacade may be used

### Allowed

- Execution
- Transition
- runtime/control helpers

### Read-only or rare

- Perception, only if stage affects input selection in a strictly control-plane way

### Not allowed

- Policy must not read stage
- Learning must not write stage

This preserves the cognition/control split.

## Recommended usage pattern

### 1. Set stage explicitly at control boundaries

Use StageFacade when:

- beginning an async wait
- leaving an await state after resume
- entering terminal states
- transitioning between explicit control phases

### 2. Validate stage invariants when stage changes

When calling **`Stage.set(ctx, newStage)`**, the facade:

- validates invariants for the new stage (against the state that would exist after stage + autoMarks)
- if validation fails, throws and does **not** commit stage or marks (atomic)
- if validation passes, commits stage and autoMarks, then runs `onEnter` with **`StageEnterContext`** (post-commit; if `onEnter` throws, stage and marks are not rolled back)
- writes transition data to `ctx.__stageTrace` for TurnTrace (consumed by oneTurn/loopRunner)

### 3. Keep Policy blind to stage

If the agent should behave differently after a stage transition, write a durable fact into `MentalState` in Learning and let Policy reason on that fact.

Do not make Policy read stage.

## TurnTrace expectations

When StageFacade is used, TurnTrace includes stage fields that match the documented StageFacade behavior:

- **`stageBefore`**, **`stageAfter`** — stage at turn start and after the turn
- **`stageTransition`** — `{ from, to }` when **`Stage.set(ctx, nextStage)`** runs
- **`stageAutoMarksApplied`** — list of autoMark keys applied on entry
- **`stageInvariantChecks`** — results of required/forbidden checks (e.g. `required`, `forbidden`, `ok`, `failedKey`)
- **`stageInvariantError`** — when a stage invariant fails, the structured **InvariantErrorPayload** (e.g. `detail.type === 'stage_invariant'`)

That makes stage bugs debuggable from a single trace.

## Testing checklist

Minimum tests:

- entering a stage with required keys present succeeds
- entering a stage with missing required keys fails loudly
- entering a stage with forbidden keys fails loudly
- autoMarks are applied exactly once per entry
- `onEnter` performs only allowed runtime calls
- stage transition appears in TurnTrace

## Common mistakes

### Mistake 1: stage leaks into Policy

Symptoms:

- `policy(m, env)` or `policy(m)` reads stage-derived control vars

Fix:

- move the relevant durable fact into `MentalState`
- keep stage as control only

### Mistake 2: marks become business facts

Symptoms:

- code branches on control marks to decide domain behavior

Fix:

- move those facts into Learning / `MentalState`

### Mistake 3: raw string paths everywhere

Symptoms:

- invariants and marks use many repeated ad hoc string keys

Fix:

- centralize control-key names

### Mistake 4: onEnter performs real effects

Symptoms:

- `onEnter` calls tools, sends messages, or dispatches children

Fix:

- move real effects back into Execution
- keep onEnter telemetry-only

## Review checklist for LLM-generated changes

When a stage-related change is proposed, ask:

- Is the new stage part of a closed stage union?
- Are invariants control-only?
- Are marks orchestration-only?
- Does Policy remain stage-blind?
- Does Learning remain stage-write-free?
- Are stage transitions recorded in TurnTrace?
- Are tests added for invariant success and failure?

## Fast PR comment

> Please use StageFacade as the control-plane entry point for this flow. Keep stage out of `MentalState` and out of Policy, keep invariants control-only, and keep `onEnter` telemetry-only. Add TurnTrace and invariant tests for the new stage transition.

