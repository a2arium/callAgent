# How-to: Implement Planning Without Breaking Policy Purity

Use this guide when you want your agent to plan (including multi-step or hierarchical plans) while keeping APLRET rules intact.

## Goal

- Add planning without turning Policy into an effectful planner.
- Keep Policy sync and M-only.
- Make plan generation, repair, and execution replayable and testable.
- Make plan state visible in TurnTrace and resilient under await/resume.

## The key rule

**Planning computation is an effect. Plan state is cognition.**

- Plan computation (LLM/tool) happens in Execution.
- Plan state (steps, cursor, status) lives in `MentalState`, written by Learning.

## When you need planning

Planning is justified when:

- tasks span multiple turns
- you use tools or child agents
- you need recovery after partial failure
- you want predictable progress and testability

Do not add planning for trivial single-turn agents.

## Minimal planning loop (canonical)

Your Policy should implement a tiny state machine:

1. No goal -> ask user
2. Goal exists, no plan -> create plan
3. Plan exists -> execute next step
4. Step failed / plan stale -> repair plan or ask user
5. Plan completed -> complete

This keeps Policy small.

## Step-by-step implementation

### Step 1: Define a plan schema (strict)

Use `PlanSchema.parse` or `validatePlanGraph` from `@a2arium/callagent-core`. Learning writes with the same parse (`PlanSchema.parse` / `safeParse`), not a separate `validatePlan` helper.

Sequential Policy uses `cursor` + `execute_next_step`. DAG Policy may call `selectReadyPlanSteps(plan)` (pure, `M` only) to see ready steps, then emit **one** `execute_step { planId, stepId }`. Cursor-only plans look “all pending ready” to the helper; sequential Policy simply does not call it. Do not emit two intents. Default Execution dispatches the named (or cursor) step’s stored `intent` and does not check `dependsOn` — Policy must not name a blocked step. Default Learning correlates pending tokens and `plan.step.updated`.

If the planner loads prior plans from semantic memory, that is Learning hydration, not a `plan.proposed` replay unless a **new** observation actually arrived.

After a tool/child completes, Learning writes `outputs` with the handle (`artifact | memory | evidence`). Policy never awaits the artifact. An evaluator is an Execution effect; Learning writes `validation`. Sequential agents may ignore `validation`.

```ts
type PlanStep = {
  id: string;
  title: string;
  kind: 'action' | 'subgoal' | 'internal';
  intent?: ExecutableStepIntent;
  status: 'pending' | 'running' | 'completed' | 'failed' | 'skipped';
  dependsOn?: string[];
  goalId?: string;
};

type Plan = {
  id: string;
  goalId?: string;
  status: 'proposed' | 'active' | 'stale' | 'completed' | 'failed' | 'cancelled';
  steps: PlanStep[];
  cursor: number;
  revision: number;
};
```

Keep it strict and versionable. Do not put action-kinds (`call_tool`, `ask_user`) on the step; put the action in `intent`.

### Step 2: Put plan state into MentalState

```ts
type MentalState = {
  // ...
  goalState: { activeGoalId?: string; goals: Record<string, Goal> };
  plans: { activePlanId?: string; plans: Record<string, Plan> };
};
```

Learning is the only writer.

### Step 3: Add planning intents

Use explicit intent kinds.

```ts
type Intent =
  | { kind: 'prompt_user'; prompt: string }
  | { kind: 'create_plan'; goalId: string }
  | { kind: 'execute_next_step'; planId: string }
  | { kind: 'execute_step'; planId: string; stepId: string }
  | { kind: 'repair_plan'; planId: string; reason: string }
  | { kind: 'wait' }
  | { kind: 'complete'; result: unknown };
```

### Step 4: Keep Policy tiny and M-only

Policy does not compute the plan.

It only decides which of the small intents to emit.

```ts
policy: (m) => {
  const goalId = m.goalState?.activeGoalId;
  if (!goalId) return { kind: 'prompt_user', prompt: 'What should I do?' };

  const planId = m.plans?.activePlanId;
  if (!planId) return { kind: 'create_plan', goalId };

  const plan = m.plans.plans[planId];
  if (!plan) return { kind: 'create_plan', goalId };

  if (plan.status === 'failed' || plan.status === 'stale') {
    return { kind: 'repair_plan', planId, reason: `plan_${plan.status}` };
  }

  if (plan.cursor >= plan.steps.length) {
    return { kind: 'complete', result: { ok: true } };
  }

  return { kind: 'execute_next_step', planId };
}
```

DAG Policy is the same tiny machine, except it names one ready step. Call `selectReadyPlanSteps(plan)` (pure, `M` only), then emit **one** `execute_step`. Do not emit two intents. Sequential Policy stays on `execute_next_step` and does not need the helper.

```ts
import { selectReadyPlanSteps } from '@a2arium/callagent-core';

policy: (m) => {
  const goalId = m.goalState?.activeGoalId;
  if (!goalId) return { kind: 'prompt_user', prompt: 'What should I do?' };

  const planId = m.plans?.activePlanId;
  if (!planId) return { kind: 'create_plan', goalId };

  const plan = m.plans.plans[planId];
  if (!plan) return { kind: 'create_plan', goalId };

  if (plan.status === 'failed' || plan.status === 'stale') {
    return { kind: 'repair_plan', planId, reason: `plan_${plan.status}` };
  }

  const ready = selectReadyPlanSteps(plan);
  const step = ready[0];
  if (!step) {
    return { kind: 'complete', result: { ok: true } };
  }

  return { kind: 'execute_step', planId, stepId: step.id };
}
```

### Step 5: Prefer omitting Execution

Default Execution already dispatches `execute_next_step` / `execute_step` (`resolveStoredPlanStep` + stamp opts on `requestTool` / `requestInput` / `sendTaskToAgent`). Default `create_plan` proposes an empty plan. Default `repair_plan` does **not** invent a patch.

**Omit `execution` unless the agent generates or repairs with an LLM.** Providing `execution:` replaces default dispatch entirely. There is no compose helper: either omit Execution, or handle `create_plan`, `repair_plan`, and `execute_step` / `execute_next_step` in the same module. Do not return `skipped: true` for the other planning intents.

If you wrap Execution for LLM create/repair, one module handles all three:

- `create_plan` → `result.data.planProposed` (a `Plan`, not `{ value: plan }`), `done: false`
- `repair_plan` → `result.data.planPatch` (`{ planId, patch }` with `PlanPatchSchema`), `done: false`
- `execute_step` / `execute_next_step` → `resolveStoredPlanStep` + stamp opts on `requestTool` / `requestInput` / `sendTaskToAgent`

Do not set `done: true` on continue paths. Default Transition treats `action.kind === 'internal' && done === true` as `complete` **before** it emits `plan.proposed` / `plan.patch`.

The create prompt must name `PlanSchema` fields (`id`, optional `goalId`, `steps`, `cursor`, `status`, `revision`) — not “JSON with steps[] and cursor”. **`title` is on each step**, not on `Plan`. Each step needs `id`, `title`, structural `kind` (`action | subgoal | internal`), and optional `intent` / `dependsOn`.

```ts
import { resolveStoredPlanStep, PlanPatchSchema } from '@a2arium/callagent-core';

execution: async (intent, ctx, _mem, m) => {
  if (intent.kind === 'create_plan') {
    const goal = m.goalState.goals[intent.goalId];
    const prompt = `Create a Plan JSON for goal: ${goal.title}.
Plan fields: id, optional goalId, steps, cursor, status, revision. Title belongs on each step, not on the Plan. Each step needs id, title, structural kind (action | subgoal | internal), and optional intent / dependsOn.`;

    const res = await ctx.llm.call(prompt);
    const planJson = JSON.parse(res[0]?.content ?? '{}');

    return {
      action: { kind: 'internal', done: false },
      result: { status: 'ok', data: { planProposed: planJson } }
    };
  }

  if (intent.kind === 'repair_plan') {
    const res = await ctx.llm.call(
      `Repair plan ${intent.planId}: ${intent.reason}.
Return a PlanPatchSchema JSON: baseRevision plus operations (add_step | remove_step | update_step | add_dependency | remove_dependency | set_cursor).`
    );
    const patch = PlanPatchSchema.parse(JSON.parse(res[0]?.content ?? '{}'));
    return {
      action: { kind: 'internal', done: false },
      result: { status: 'ok', data: { planPatch: { planId: intent.planId, patch } } }
    };
  }

  if (intent.kind === 'execute_next_step' || intent.kind === 'execute_step') {
    const resolved = resolveStoredPlanStep(intent, m);
    if (!resolved.ok) {
      return {
        action: { kind: 'internal', done: false },
        result: { status: 'error', error: { code: resolved.errorCode, message: resolved.message } }
      };
    }

    const { intent: stepIntent, planId, stepId, advanceCursor } = resolved;
    const stampOpts = { planId, stepId, advanceCursor };

    if (stepIntent.kind === 'call_tool') {
      const handle = await ctx.requestTool(stepIntent.toolName, stepIntent.args, {
        awaitCompletion: false,
        ...stampOpts,
      });
      return {
        action: { kind: 'call_tool', token: handle.token },
        result: { status: 'ok', data: { planId, stepId, token: handle.token } }
      };
    }

    if (stepIntent.kind === 'prompt_user') {
      const handle = await ctx.requestInput(stepIntent.prompt, {
        schema: stepIntent.schema,
        ...stampOpts,
      });
      return {
        action: { kind: 'prompt_user', token: handle.token },
        result: { status: 'ok', data: { planId, stepId, token: handle.token } }
      };
    }

    if (stepIntent.kind === 'delegate_to_child') {
      const handle = await ctx.sendTaskToAgent(stepIntent.agentId, stepIntent.input, {
        awaitCompletion: false,
        ...stampOpts,
      });
      return {
        action: { kind: 'delegate_to_child', token: handle.token },
        result: { status: 'ok', data: { planId, stepId, token: handle.token } }
      };
    }

    if (stepIntent.kind === 'wait' || stepIntent.kind === 'complete' || stepIntent.kind === 'internal') {
      return {
        action: { kind: 'internal', done: false },
        result: { status: 'ok', data: { planId, stepId, kind: stepIntent.kind } }
      };
    }
  }

  // handle any other Policy intents; do not skip planning kinds
};
```

Important:

- return the plan as `result.data.planProposed` (a `Plan`, not `{ value: plan }`)
- return the patch as `result.data.planPatch` (`{ planId, patch }`), not as `plan.updated`
- step interpretation happens in Execution (`step.intent`, not `step.kind`)
- stamps (`planId` / `stepId` / `advanceCursor`) go onto the same pending record that `requestTool` / `requestInput` / `sendTaskToAgent` writes
- Do not index `plan.steps[plan.cursor]` yourself and invoke the tool without stamps — Learning cannot correlate the completion

### Step 6: Prefer default Transition

Prefer **default** Transition. It maps `result.data.planProposed` through `PlanSchema` to `internal/plan.proposed` and `result.data.planPatch` through `PlanPatchSchema` to `internal/plan.patch`. Payloads are the Plan / patch object — not `{ value: T }`.

If you wrap Transition, `continue` after `planProposed` / `planPatch`. Do not `complete` on those paths: default Transition would have completed already if Execution set `done: true`, and a custom `complete` skips emitting the observation. Preserve `await_tool` / `await_child` / `await_input` for stamped steps.

### Step 7: Prefer default Learning

Prefer **default** Learning. It stores `plan.proposed`, applies `plan.patch` (`applyPlanPatch`), and correlates `env.pending[slot][token]` **then** the matching terminal bag (engine claim may have deleted pending; tombstones keep the stamps). A custom Learning that only handles `plan.proposed` will drop that token correlation.

If you wrap Learning for `plan.proposed`, parse with `PlanSchema.parse` (not `validatePlan`) and keep the same pending-then-terminal path for tool/child/input completions.

Learning responsibilities on `plan.proposed`:

- validate the plan shape (`kind` is `plan.proposed`; payload is a Plan)
- assign IDs if needed
- set `activePlanId`
- set `status: active`

```ts
import { PlanSchema } from '@a2arium/callagent-core';

learning: (prev, _prevAction, obs) => {
  const inbox = Array.isArray(obs.inbox) ? obs.inbox : [];
  for (const item of inbox) {
    if (item.source !== 'internal' || item.kind !== 'plan.proposed') continue;

    const plan = PlanSchema.parse(item.payload); // payload is a Plan

    const planId = plan.id ?? crypto.randomUUID();
    const nextPlan: Plan = {
      ...plan,
      id: planId,
      status: 'active',
      revision: (plan.revision ?? 0) + 1,
      cursor: plan.cursor ?? 0
    };

    return {
      ...prev,
      plans: {
        activePlanId: planId,
        plans: {
          ...(prev.plans?.plans ?? {}),
          [planId]: nextPlan
        }
      }
    };
  }

  return prev;
};
```

The sample above is only the `plan.proposed` branch. If you ship it as the whole Learning module, cursor advance and `plan.patch` never run — use default Learning instead, or handle those observations too.

LLM produces `PlanPatch` in Execution, not in Policy. Learning is the only writer (`applyPlanPatch`).

### Step 8: Execute the next step (policy stays small)

Policy still only emits `execute_next_step` or one `execute_step`. Completion re-enters via observations. Learning advances cursor (`execute_next_step` / `advanceCursor`) or applies `plan.patch`.

Repair A/B in tests: `snapshot()` at failure, `fork` retry vs `repair_plan`. This is not production time-travel.

Transition should evaluate the `ExecOutcome`, set the appropriate control stage (e.g., via `StageFacade`), and await for async steps. Transition must store enough context in observations or pending state so the step can be marked complete on resume.

### Step 9: Mark step completion and advance cursor in Learning

On resume, Perception normalizes tool/child completion. Learning:

- looks up stamps on `env.pending` **then** on the matching terminal (claim may have deleted pending)
- marks current step completed/failed
- advances cursor when `advanceCursor` is true
- sets plan status to completed if at end

## Hierarchical planning (optional)

Start flat.

If you need hierarchy, add one of these patterns:

### Pattern A: goalId per step

Use `goalId` on steps to link to hierarchical goals.

### Pattern B: subplan expansion

Allow a step kind `expand_plan` whose execution produces a new plan and links it.

Rule:

- hierarchy is still stored in `MentalState`
- Policy remains small: create/execute/repair

## Testing requirements

Add tests as turn scripts.

Minimum tests:

1. create plan
2. execute next step
3. repair plan
4. async resume for a tool step

TurnTrace assertions:

- `internal/plan.proposed` enters inbox
- Learning writes plan state (hash change)
- Policy emits `execute_next_step` only after Learning
- step completion advances cursor only after resume
- repair: `internal/plan.patch` and a `revision` bump

## Common failure modes

### Failure: plan computed in Policy

Symptom:

- Policy becomes long, async, or reads ctx/env

Fix:

- move plan computation to Execution
- store result via observation -> Learning -> `MentalState`

### Failure: plan stored but not validated

Symptom:

- runtime crashes later due to missing fields

Fix:

- strict validator in Perception/Learning (`PlanSchema.parse`)

### Failure: step completion lost on resume

Symptom:

- agent repeats step

Fix:

- ensure completion enters inbox with token
- ensure Learning records step completion (pending **or** stamped terminals) and advances cursor

### Failure: plan drift

Symptom:

- plan becomes stale after new information

Fix:

- Policy detects staleness (based on durable fact)
- Policy emits `repair_plan` with reason

### Failure: custom Execution skips execute or sets done: true

Symptom:

- `execute_step` never runs, or `plan.proposed` / `plan.patch` never enter the inbox

Fix:

- omit Execution, or handle create + execute + repair in one module
- use `done: false` on continue paths

## Checklist for LLM-assisted changes

When asking an AI coder to add planning:

- confirm Policy remains sync and M-only
- omit `execution` unless LLM generate/repair is required; if provided, handle create + execute + repair
- ensure plan objects enter via observations (`plan.proposed` / `plan.patch`)
- ensure Learning writes plan state (prefer default Learning for token correlation)
- ensure Execution interprets `step.intent` (`resolveStoredPlanStep` + stamp opts)
- ensure TurnTrace shows plan lifecycle
- ensure tests assert the trace at plan creation, repair (`plan.patch`), and step completion
