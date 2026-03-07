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

Start with a flat plan.

```ts
type PlanStep = {
  id: string;
  title: string;
  kind: 'ask_user' | 'call_tool' | 'delegate_child' | 'llm' | 'internal';
  args?: Record<string, unknown>;
  status: 'todo' | 'doing' | 'done' | 'failed' | 'skipped';
  dependsOn?: string[];
  goalId?: string;
};

type Plan = {
  id: string;
  status: 'draft' | 'active' | 'stale' | 'completed' | 'failed';
  steps: PlanStep[];
  cursor: number;
  revision: number;
};
```

Keep it strict and versionable.

### Step 2: Put plan state into MentalState

```ts
type MentalState = {
  // ...
  goalState: { activeGoalId?: string; goals: Record<string, any> };
  plans: { activePlanId?: string; plans: Record<string, Plan> };
};
```

Learning is the only writer.

### Step 3: Add planning intents

Use explicit intent kinds.

```ts
type Intent =
  | { kind: 'ask_user'; prompt: string }
  | { kind: 'create_plan'; goalId: string }
  | { kind: 'execute_next_step'; planId: string }
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
  if (!goalId) return { kind: 'ask_user', prompt: 'What should I do?' };

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

### Step 5: Generate plan in Execution (effect)

Execution calls LLM (or another tool) to produce a structured plan.

Important:

- return the plan as data in `ExecResult`
- Transition converts it into an `internal/plan.proposed` observation

```ts
execution: async (intent, ctx, m) => {
  if (intent.kind !== 'create_plan') {
    return { action: { kind: 'internal', done: true }, result: { status: 'ok', data: { skipped: true } } };
  }

  const goal = m.goalState.goals[intent.goalId];
  const prompt = `Create a JSON plan with steps[] and cursor for goal: ${goal.title}`;

  const res = await ctx.llm.call(prompt);
  const planJson = JSON.parse(res[0]?.content ?? '{}');

  return {
    action: { kind: 'internal', done: true },
    result: { status: 'ok', data: { plan: planJson } }
  };
};
```

### Step 6: Package plan into an observation in Transition

```ts
transition: (_env, exec) => {
  if (exec.result.status === 'ok' && exec.result.data?.plan) {
    return {
      kind: 'continue',
      observations: [
        {
          source: 'internal',
          kind: 'plan.proposed',
          payload: { value: exec.result.data.plan }
        }
      ]
    };
  }

  return { kind: 'continue', observations: [] };
};
```

### Step 7: Validate and store plan in Learning

Perception should normalize the observation; Learning should validate schema and store it.

Learning responsibilities:

- validate the plan shape
- assign IDs if needed
- set `activePlanId`
- set `status: active`

```ts
learning: (prev, _prevAction, obs) => {
  if (obs.kind !== 'plan_proposed') return prev;

  const plan = validatePlan(obs.plan); // strict validator

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
};
```

### Step 8: Execute the next step (policy stays small)

In Execution, interpret the current step based on `kind`.

Important:

- step interpretation happens in Execution
- completion re-enters via observations
- Learning advances cursor

Example (tool step):

```ts
execution: async (intent, ctx, m) => {
  if (intent.kind !== 'execute_next_step') {
    return { action: { kind: 'internal', done: true }, result: { status: 'ok', data: { skipped: true } } };
  }

  const plan = m.plans.plans[intent.planId];
  const step = plan.steps[plan.cursor];

  if (step.kind === 'call_tool') {
    const handle = await ctx.requestTool(step.args.toolName, step.args, { awaitCompletion: false });
    return {
      action: { kind: 'tool', token: handle.token },
      result: { status: 'ok', data: { planId: plan.id, stepId: step.id, token: handle.token } }
    };
  }

  // other step kinds...

  return { action: { kind: 'internal', done: true }, result: { status: 'ok', data: { noop: true } } };
};
```

Transition should evaluate the `ExecOutcome`, set the appropriate control stage (e.g., via `StageFacade`), and await for async steps. Transition must store enough context in observations or pending state so the step can be marked complete on resume.

### Step 9: Mark step completion and advance cursor in Learning

On resume, Perception normalizes tool/child completion. Learning:

- marks current step done/failed
- advances cursor
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

- strict validator in Perception/Learning

### Failure: step completion lost on resume

Symptom:

- agent repeats step

Fix:

- ensure completion enters inbox with token
- ensure Learning records step completion and advances cursor

### Failure: plan drift

Symptom:

- plan becomes stale after new information

Fix:

- Policy detects staleness (based on durable fact)
- Policy emits `repair_plan` with reason

## Checklist for LLM-assisted changes

When asking an AI coder to add planning:

- confirm Policy remains sync and M-only
- ensure plan objects enter via observations
- ensure Learning writes plan state
- ensure Execution interprets step kinds
- ensure TurnTrace shows plan lifecycle
- ensure tests assert the trace at plan creation and step completion

