# Spec: Goals and Plans in APLRET

This document is normative. It defines how goals and plans are represented and used in APLRET agents.

## Purpose

Goals and plans are cognition.

They exist to:

- make multi-step work explicit
- make progress observable
- make agent behavior testable and replayable
- support delegation and recovery

## Non-negotiable rules

1. **Single cognitive truth**
   - Goals and plans that influence decisions MUST live in `MentalState`.
   - Goals and plans MUST be written by Learning.

2. **Policy purity**
   - Policy remains synchronous and reads only `MentalState`.
   - Policy MUST NOT read `ctx` or `env`.

3. **Effect boundary**
   - Plan generation or repair that uses an LLM/tool is an effect and MUST happen in Execution.

4. **Turn discipline**
   - Plan outputs become available to Policy only after they re-enter through inbox and are written to `MentalState` by Learning.

## Data model

### Goal

A goal is a hierarchical objective.

Goals MAY have parents.

```ts
type GoalId = string;

type GoalStatus = 'active' | 'blocked' | 'done' | 'failed';

type GoalType = 'objective' | 'subtask' | 'constraint' | 'check';

type Goal = {
  id: GoalId;
  title: string;
  status: GoalStatus;
  type?: GoalType;
  priority?: number;
  parentId?: GoalId;
  context?: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
};
```

### Plan

A plan is a structured, versioned graph of steps. The runtime authority is
`PlanSchema` in `@a2arium/callagent-core`.

```ts
type PlanId = string;

type PlanStatus = 'proposed' | 'active' | 'stale' | 'completed' | 'failed' | 'cancelled';

type StepStatus = 'pending' | 'running' | 'completed' | 'failed' | 'skipped';

type StepKind = 'action' | 'subgoal' | 'internal';

type PlanStep = {
  id: string;
  kind: StepKind;
  goalId?: GoalId;
  title: string;
  status: StepStatus;
  intent?: ExecutableStepIntent; // prompt_user | answer_with_llm | call_tool | delegate_to_child | complete | wait | internal
  dependsOn?: string[];
  outputs?: Array<{ name?: string; kind: 'artifact' | 'memory' | 'evidence'; ref: string }>;
  validation?: { status: 'unknown' | 'pending' | 'valid' | 'invalid'; refs?: string[] };
  meta?: Record<string, PlanJsonValue>;
};

type Plan = {
  id: PlanId;
  goalId?: GoalId;
  steps: PlanStep[];
  cursor: number;
  status: PlanStatus;
  revision: number;
  lineage?: {
    parentRevision?: number;
    cause?: { kind: 'initial' | 'observation' | 'failure' | 'user_change' | 'optimization' | 'manual'; ref?: string };
    evidenceRefs?: string[];
  };
  meta?: Record<string, PlanJsonValue>;
  createdAt?: string; // ISO-8601 with offset or Z; optional forever
  updatedAt?: string;
};
```

`kind` is structural only. Execution interprets `step.intent`; it MUST NOT invent an intent from `kind`. Proposed or placeholder steps MAY omit `intent`.

Outputs are handles, not payloads. See [How-to: artifacts](./7-how_to_use_artifacts_correctly_aplret.md). `completed` is not the same as `validation.status === 'valid'`. Policy that needs the gate calls `selectReadyPlanSteps(plan, { requireValidatedDependencies: true })` (still only `M`).

`dependsOn` is stored and validated on parse (unique step ids; targets exist; no self-edge; no cycle). Duplicate ids in one `dependsOn` list are one edge. A dependency is **satisfied** iff that step’s `status === 'completed'` (`pending` / `running` / `failed` / `skipped` do not). Ready/blocked selection is `selectReadyPlanSteps` / `selectBlockedPlanSteps` from `@a2arium/callagent-core`; those helpers **ignore** `cursor` and `plan.status`. Sequential Policy still uses `cursor` + `execute_next_step`. DAG Policy reads helpers over `M.plans` (still only `M`; still not stage/`ctx`/`env`) and emits one `execute_step { planId, stepId }`. Execution does not check `dependsOn`. Sequential exhaustion (`cursor === steps.length`) stays a sequential invariant, not a DAG one.

### Planning decisions

Accepted decisions: [`planning-harness/adr/`](./planning-harness/adr/) (`0001`–`0009`) and [`planning-harness/specs/README.md`](./planning-harness/specs/README.md). This spec is the author-facing contract. Do not copy ADR bodies here. The harness folder remains until a later deletion PR.

### MentalState placement

Goals and plans MUST be stored in `MentalState`.

```ts
type GoalState = {
  goals: Record<GoalId, Goal>;
  activeGoalId?: GoalId;
};

type PlanState = {
  plans: Record<PlanId, Plan>;
  activePlanId?: PlanId;
};

type MentalState = {
  // ...
  goalState: GoalState;
  plans?: PlanState;
  // ...
};
```

### Cognitive State vs. Control Stage

It is critical to separate the cognitive state of a plan from the engine's control stage (e.g., `StageFacade`):

- **Plan State** (`proposed`, `active`, `stale`, `completed`) is **cognition**. It lives in `MentalState` and spans many turns.
- **Agent Stage** (`idle`, `awaiting_tool`, `awaiting_child`) is **control**. It lives in `StageFacade` / `env` and changes dynamically as individual plan steps are executed and awaited. 

Policy MUST NOT read the agent's control stage to determine what step of the plan to execute next. Sequential Policy uses `cursor` and `status` in `MentalState`. DAG Policy uses `selectReadyPlanSteps` / `selectBlockedPlanSteps` over `M.plans` (still only `M`).

## Invariants

### Goals

- Goal IDs MUST be stable within a run.
- Goal updates MUST be immutable.
- A goal with `status: done` or `failed` MUST NOT return to `active` unless explicitly reopened.

### Plans

- A plan MUST have a stable `id`.
- `cursor` MUST be within `0..steps.length`.
- When `cursor === steps.length`, plan SHOULD be `completed` unless there are failed steps.
- `revision` MUST increment when the plan changes meaningfully (steps or ordering).
- Step IDs MUST be unique within the plan.
- `dependsOn` targets MUST exist in the same plan; a step MUST NOT depend on itself; the graph MUST NOT contain a cycle.

### Steps

- A step MUST NOT be marked `completed` unless its required effect has completed or the step is explicitly skipped.
- A step MUST NOT store a Policy-level planning intent (`create_plan`, `execute_next_step`, `execute_step`, `repair_plan`).
- Execution MUST run `step.intent` (for example `prompt_user`, not a step `kind` of `ask_user`).

## Observation contract

Plan and goal changes that originate from effects MUST enter cognition via observations.

The framework MUST support internal observations for:

- `internal/goal.updated`
- `internal/plan.proposed`
- `internal/plan.updated`
- `internal/plan.step.updated`
- `internal/plan.patch`

These observations MAY be generated by:

- Transition (from Execution results)
- runtime injection (from external orchestrators)

Perception MUST validate these observations. Invalid `plan.*` payloads become `internal/validation.failed` (`reason: 'invalid_plan'`); they are not dropped. Default Learning does not write `M.plans` from `validation.failed`.

Learning MUST apply valid plan observations.

## Policy contract

Policy uses goals/plans by reading compact state.

Policy SHOULD implement a small state machine:

- no active goal -> prompt user or idle
- active goal but no plan -> create plan
- active plan -> execute next step (`step.intent`)
- plan failed/stale -> repair plan or prompt user

Policy MUST NOT generate long plans itself.

## Execution contract

Execution performs effectful operations such as:

- LLM plan creation
- LLM plan repair
- tool calls
- child delegation

Execution MUST return `{ action, result }`.

Transition MUST convert relevant execution outcomes into observations.

## Standard intents

Agents SHOULD model planning with explicit intent kinds.

Minimum recommended intent set:

```ts
type Intent =
  | { kind: 'create_plan'; goalId: GoalId }
  | { kind: 'execute_next_step'; planId: PlanId }
  | { kind: 'execute_step'; planId: PlanId; stepId: string }
  | { kind: 'repair_plan'; planId: PlanId; reason: string }
  | { kind: 'prompt_user'; prompt: string }
  | { kind: 'wait' }
  | { kind: 'complete'; result: unknown };
```

The internal intent set may be larger, but planning and execution should remain explicit.

## Turn templates

### Template A: Create plan

Turn N:

- Policy emits `create_plan(goalId)`
- Execution calls LLM to produce a structured plan
- Transition emits `internal/plan.proposed` observation
- Transition returns `continue` (or awaits if plan generation is async)

Turn N+1:

- Perception validates `plan.proposed`
- Learning stores plan and sets `activePlanId`
- Policy emits `execute_next_step(planId)`

### Template B: Execute next step

Turn N:

- Policy reads `cursor` and `steps[cursor].intent`
- Policy emits `execute_next_step(planId)` (sequential) or `execute_step { planId, stepId }` for a named DAG step
- Execution performs `step.intent` (for example `call_tool` / `delegate_to_child` / `prompt_user`)
- Transition emits completion observation(s)
- Transition sets the appropriate pending control stage (e.g., via `StageFacade`) and awaits if async

Turn N+1:

- Perception validates completion event
- Learning marks step `completed`/`failed` and advances cursor
- Policy chooses next step or `repair_plan` (including when plan status is `stale`)

### Template C: Repair plan

Turn N:

- Policy emits `repair_plan(planId, reason)`
- Execution returns `planPatch` on `result.data` (`{ planId, patch }`). The patch is an LLM/tool effect; Execution does not write `M.plans`. Default `repair_plan` does not invent a patch.
- Transition maps `result.data.planPatch` to `internal/plan.patch`. Do not send a patch as `plan.updated` (that payload is still a full `Plan`)

Turn N+1:

- Perception parses the patch; invalid → `validation.failed`
- Learning `applyPlanPatch` + `PlanSchema.safeParse`, bumps `revision`, sets `lineage.parentRevision`
- Policy continues

Planner candidates (ready-step ids, revision) belong in a TurnTrace extension (`planning.graph`), not in `M`.

## Testing requirements

Agents using goals/plans MUST have tests for:

- create plan flow
- execute-next-step flow
- repair plan flow
- resume behavior for tool/child steps

Tests MUST assert TurnTrace shows:

- plan-related observations entering inbox
- Learning writing plan state
- Policy selecting next intent only after Learning update

## Migration and compatibility

If the framework currently supports goal/decision APIs outside `MentalState`, they MUST be treated as non-authoritative.

Any authoritative goal/plan state that influences Policy MUST be stored in `MentalState` and updated by Learning.

