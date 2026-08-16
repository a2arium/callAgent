# ADR 0001: One Plan Truth

## Status

Accepted

Implementation contract: `specs/plan-schema.md`.

## Context

Three Plan shapes exist today:

1. **Contracts / spec / how-to** (`0-aplret_contracts.md`,
   `8-spec_goals_and_plans_in_aplret.md`,
   `9-how_to_implement_planning_without_breaking_policy_purity.md`):
   `title`, `dependsOn`, action-kinds (`ask_user` | `call_tool` | …),
   `args?: Record<string, unknown>`, statuses `todo`/`doing`/`done`, plan
   statuses `draft`/`stale`, ISO timestamps.
2. **Runtime schema** (`packages/core/src/types/plan.ts`): `description`,
   structural `kind` (`action` | `subgoal` | `internal`), optional `intent`,
   inline `result: unknown`, no `dependsOn`, statuses
   `pending`/`running`/`completed`, plan statuses `proposed`/`cancelled`,
   numeric timestamps.
3. **Improvement request** (`apps/docs/todo/improvements-planning-dependencies-etc.md`):
   extends shape (1), including generics and a `scheduling` mode.

Almost no agents depend on (2). Humans and LLMs follow (1). (2) is an incomplete
3.1 implementation (default execution still only stubs `create_plan`). Aligning
docs down to (2) would freeze the incomplete sketch. Copying (1) wholesale would
duplicate `Intent` as step `kind` + untyped `args`.

`GoalNode` already uses `title` and ISO timestamps. `IntentSchema` is already
the closed union Execution understands.

## Decision

Migrate `plan.ts` toward the documented *product language*, keeping the runtime
*execution model*. Docs then infer from the schema.

Keep from runtime:

- Structural `StepKind`: `action | subgoal | internal`.
- `intent?: ExecutableStepIntent` as the thing to execute.
- Step status: `pending | running | completed | failed | skipped`.
- Plan statuses `proposed` and `cancelled`.

Take from docs:

- `dependsOn?: string[]`.
- Field name `title` (same as `GoalNode`).
- Plan status `stale` (repair loops need it).
- ISO-8601 `createdAt` / `updatedAt`.

Drop:

- Action-kinds on the step (`call_tool`, `ask_user`, …).
- `args?: Record<string, unknown>`.
- `PlanStep.result: unknown` (replaced later by output refs).
- Dual documented vs runtime shapes.
- A source-compatibility promise for the old schema.

Target plan status:

```text
proposed | active | stale | completed | failed | cancelled
```

`ExecutableStepIntent` is `Intent` minus Policy-level planning intents
(`create_plan`, `execute_next_step`, `repair_plan`, and the forthcoming
`execute_step`). A plan step cannot contain “make a plan.”

TypeScript generics for `meta` are overlays on Zod JSON (`PlanMetaSchema`,
no `undefined`). They are not a second source of truth.

## Consequences

- One breaking schema change, one migration note, before public core freeze.
- Policy for sequential agents stays `execute_next_step` + `cursor`.
- DAG agents can store `dependsOn` without a new loop phase. Readiness is
  derived by helpers that ignore `cursor` (ADR 0002); `execute_step` is later.
- LLM-generated plans must emit `intent` objects that pass `IntentSchema`,
  not free-form `kind`+`args`.
- Contracts, spec, and how-to must be rewritten against the schema in the
  same change set as `plan.ts`.

## Non-Goals

- Do not add `scheduling` mode in this ADR.
- Do not add `execute_step`, output refs, validation state, or lineage here
  (later ADRs / specs).
- Do not put ATG fields on `PlanStep`.
- Do not add `MentalState.extensions`.
