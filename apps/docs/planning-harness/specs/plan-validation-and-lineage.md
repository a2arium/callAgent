# Spec: Plan Validation and Lineage (Phase 3b)

## Status

Ready for implementation after Phase 1. Graph helpers (Phase 2) should
land first if this PR adds the optional ready-helper flag; schema fields
alone only need Phase 1.

May land in the same PR as `specs/plan-output-refs.md`.
`adr/0004-validation-is-cognition-lineage-explains-revision.md` is
**Accepted**.

## Goal

1. Let Learning record whether a **completed** step is downstream-usable
   (`validation`), distinct from execution `status`.
2. Let a plan record **why** `revision` moved (`lineage`), without making
   lineage required.

Originating request §§5 and 7. Not §8 (`MentalState.extensions` — rejected).

## Why this shape

| Request want | Phase 3b answer |
|---|---|
| `validation?: { status, refs? }` on the step | Yes. Closed status enum |
| Helpers can require validated deps | Yes, **opt-in** flag on existing helpers. Default stays Phase 2 |
| `selectRunnablePlanSteps` as a second name | **No.** One function, optional options bag |
| `lineage` on `Plan` | Yes, optional |
| Zod-enforce monotonic `revision` across turns | **No.** Same as Phase 1: Learning bumps; Zod only checks `parentRevision < revision` when lineage is present |
| `MentalState.extensions` for evaluator state | **No.** `meta` / `worldModel` |

## APLRET ownership

| Concern | Owner |
|---|---|
| Write `validation` / `lineage` / bump `revision` | Learning only |
| Run an evaluator LLM/tool | Execution (effect) → observation → Learning writes `validation` |
| Perception `PlanSchema.parse` | Shape only. Does **not** call the evaluator |
| Choose to require validated deps | Policy, passing the flag into a **pure** helper over `M.plans` |

`validation` is cognition: “may downstream use this?” It is not:

- inbox envelope validity (`internal/validation.failed`);
- `Shield` / stage control;
- a substitute for `status: 'completed'`.

A step MAY be `completed` with `validation.status: 'invalid'`. Downstream
stays blocked **only** when Policy uses the opt-in flag.

## Normative schema

Home: `packages/core/src/types/plan.ts`. `.strict()`. Inferred types.

### Validation

```ts
export const ValidationStatusSchema = z.enum([
  'unknown',
  'pending',
  'valid',
  'invalid',
]);

export const ValidationStateSchema = z.object({
  status: ValidationStatusSchema,
  refs: z.array(z.string().min(1)).optional(),
}).strict();
```

Add optional `validation: ValidationStateSchema.optional()` on
`PlanStepSchema`.

`refs` are compact ids (output `name` / `ref`, artifact id, evidence id).
They are **not** payloads. Duplicate refs in one list are **accepted**
and treated as **one** ref (uniquify), same rule as `dependsOn`. Do not
reject `refs: ['art_1', 'art_1']`.

Omitted `validation` means “this agent does not use the gate.”

### Lineage

```ts
export const PlanRevisionCauseKindSchema = z.enum([
  'initial',
  'observation',
  'failure',
  'user_change',
  'optimization',
  'manual',
]);

export const PlanRevisionCauseSchema = z.object({
  kind: PlanRevisionCauseKindSchema,
  ref: z.string().min(1).optional(),
}).strict();

export const PlanRevisionLineageSchema = z.object({
  parentRevision: z.number().int().nonnegative().optional(),
  cause: PlanRevisionCauseSchema.optional(),
  evidenceRefs: z.array(z.string().min(1)).optional(),
}).strict();
```

Add optional `lineage: PlanRevisionLineageSchema.optional()` on
`PlanSchema`.

`PlanSchema` superRefine:

| `params.errorCode` | Condition |
|---|---|
| `PLAN_LINEAGE_PARENT` | `lineage.parentRevision` is set and `parentRevision >= revision` |

Do not require `lineage` on `revision === 0`. Do not require `cause`.

Default Learning SHOULD, when it bumps `revision`:

- set `lineage.parentRevision` to the previous revision;
- set `cause` when it knows why (failure vs observation vs initial).

That is a convenience, not a schema require. Custom Learning that omits
lineage is still valid.

## Ready helper extension (Phase 2 contract preserved)

File: `packages/core/src/plans/planGraph.ts`.

```ts
export const SelectReadyPlanStepsOptionsSchema = z.object({
  requireValidatedDependencies: z.boolean().optional(),
}).strict();

export function selectReadyPlanSteps(
  plan: Plan,
  options?: SelectReadyPlanStepsOptions
): readonly PlanStep[]

export function selectBlockedPlanSteps(
  plan: Plan,
  options?: SelectReadyPlanStepsOptions
): readonly PlanStep[]
```

Default / omitted options: **identical to Phase 2** (dep satisfied iff
`status === 'completed'`). Validation is ignored. This is load-bearing:
simple agents and Phase 2 tests must not change.

When `requireValidatedDependencies: true`:

- a dependency is satisfied iff `status === 'completed'` **and**
  `validation?.status === 'valid'`;
- omitted `validation`, `unknown`, `pending`, and `invalid` do **not**
  satisfy;
- ready/blocked still apply only to `pending` steps;
- helpers still ignore `cursor` and `plan.status` (ADR 0002).

Do not export `selectRunnablePlanSteps`. Do not add other options in this
phase (`requireOutputs`, scheduling, …).

Lookups (`getPlanDependants` / ancestors / descendants) do **not** take
this flag. They are graph structure, not readiness.

## Tests

### Schema

`planning.model.test.ts`:

Accept: omitted validation; `{ status: 'valid' }`; `{ status: 'invalid', refs: ['art_1'] }`; `refs: ['art_1', 'art_1']`; omitted lineage; lineage with `parentRevision: 0` on `revision: 1`; cause `failure`.

Reject: `validation.status: 'done'`; extra evaluator scores on `ValidationState`; `parentRevision: 2` with `revision: 2`; `parentRevision: 3` with `revision: 1`; leftover `result`.

JSON round-trip preserves `validation` and `lineage`.

### Helpers

`planGraph.test.ts` (do not dump into schema tests):

Fixture: `A` completed, no validation; `C` pending depends on `A`.

- no options → `C` ready (Phase 2);
- `{ requireValidatedDependencies: true }` → `C` blocked;
- `A.validation.status = 'valid'` + flag → `C` ready;
- `A.validation.status = 'invalid'` + flag → `C` blocked;
- `A.validation.status = 'pending'` + flag → `C` blocked.

Phase 2 cursor-only and cancelled-plan cases still pass with **no**
options. Do not change those expectations.

### Type tests

`plan.types.test-d.ts`: options bag is optional; `requireValidatedDependencies`
is `boolean | undefined`; extra option keys are not part of the type
(inferred from `.strict()` schema).

### Loop

No default-Policy change. No turn-script that default Learning writes
validation. Agent-level tests MAY seed `validation` via `seedMentalState`
or `plan.step.updated`.

### Known regression review

| Failure | Action |
|---|---|
| Phase 2 ready tests now need the flag | **Bug.** Default must stay `completed`-only |
| Schema tests fail because validation is required | Keep it optional |
| `MentalState` generic blast from `extensions` | Do not add `extensions` |
| Lineage required on empty `create_plan` stub | Keep stub legal without lineage |

Run `yarn test` and `yarn test:types` in `packages/core`.

## Docs to update in the **same change set**

| Doc | What to change |
|---|---|
| `apps/docs/0-aplret_contracts.md` | PlanStep `validation`; Plan `lineage`. Invariants: validation is optional cognition; `parentRevision < revision` when set. Helpers: default vs `requireValidatedDependencies`. |
| `apps/docs/8-spec_goals_and_plans_in_aplret.md` | Completed ≠ validated. Policy that needs the gate calls the helper with the flag (still only `M`). |
| `apps/docs/9-how_to_implement_planning_without_breaking_policy_purity.md` | Evaluator is Execution; Learning writes `validation`. Sequential agents ignore the field. |
| `apps/docs/11-how_to_test_aplret_agents.md` | One case: completed-but-unvalidated blocks only when the flag is on. |
| `apps/docs/migration/plan-schema-one-truth.md` | Optional fields; old snapshots without them still parse. |

Do **not** rewrite originating request / historical 3.1.

## Out of scope

- `MentalState.extensions`
- ATG / EFE / belief types on `ValidationState`
- Making validation required
- `selectRunnablePlanSteps` alias
- `PlanPatch` (Phase 6)
- Changing default Policy
- Running evaluators inside `PlanSchema.parse`

## Acceptance

- Optional fields parse; illegal lineage parent fails with
  `PLAN_LINEAGE_PARENT`.
- Default ready helper matches Phase 2.
- Flag-on cases in Tests pass.
- Docs agree.
- `yarn test` and `yarn test:types` in `packages/core` are green.

## Implementation order

1. Schema fields + lineage superRefine + exports.
2. Options bag on ready/blocked helpers (default identical).
3. Schema tests, helper tests, tsd.
4. Docs in the table.
5. Full core `yarn test` + `yarn test:types`.
