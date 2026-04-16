# How-to: Keep Policy pure when the implementation wants to put too much there

Use this guide when you notice code or design pressure pushing more work into Policy than Policy is allowed to do.

## Goal

Keep Policy:

- synchronous
- `MentalState`-only
- effect-free
- easy to test
- easy for LLMs to modify safely

## Recognize the smell

You are probably putting too much into Policy if you see any of these:

- reading `ctx`, `env`, `inbox`, or `pending`
- loading artifacts
- calling an LLM or tool
- checking transport details such as tokens or current await state
- checking current `stage` (e.g., branching on `Stage.get(ctx)` or other StageFacade reads)
- reading manifest config directly
- performing validation there because it feels like “reasoning”
- generating or repairing multi-step plans using an LLM directly in Policy
- mutating `ctx.goals`, `ctx.thoughts`, or `ctx.decisions` directly instead of returning an Intent

## The rule of thumb

When you want to add logic to Policy, ask:

### Question 1

**Is this changing what the agent knows?**

If yes, it belongs before Policy:

- Perception validates and normalizes
- Learning writes the result into `MentalState`
- Policy reasons on the resulting cognitive state

### Question 2

**Is this needed only to perform an action?**

If yes, it belongs after Policy:

- Policy emits the intent
- Execution performs the work

### Question 3

**Is this a control concern rather than a reasoning concern?**

If yes, it belongs in:

- `env.pending`
- `env.control`
- normalized inbox observations

not in Policy and not in `MentalState`

## Policy and selectors

Policy should stay **sync and `MentalState`-only**, but it should not **deep-read** arbitrary nested paths everywhere. The standard pattern is a **`selectors.ts`** module that exposes a compact **decision-ready view** (e.g. `readPolicyView(m)`), and Policy reads only that view before emitting a **domain-named** intent. That keeps Policy easy to scan and aligns with [APLRET contracts](./0-aplret_contracts.md) and [Agent repository layout](./14-agent_repository_layout_for_aplret.md).

```ts
// selectors.ts — example (MentalState is your agent’s cognition type from the framework)
type PolicyView = { hasInvoice: boolean; invoiceId?: string };

export function readPolicyView(m: MentalState): PolicyView {
  return { hasInvoice: !!m.worldModel?.latestInvoiceId, invoiceId: m.worldModel?.latestInvoiceId };
}

// policy.ts
policy: (m) => {
  const v = readPolicyView(m);
  if (!v.hasInvoice) return { kind: 'fetch_invoice' };
  return { kind: 'submit', invoiceId: v.invoiceId! };
},
```

## Rewrite patterns

### Case 1: “Policy wants config”

#### Bad

```ts
policy: (m, ctx) => {
  const budgetMode = ctx.config.runtimeManifestConfig.toolMode;
  return budgetMode === 'strict'
    ? { kind: 'safe_path' }
    : { kind: 'fast_path' };
}
```

#### Good

Materialize the reasoning-relevant config into `MentalState.policyParams` before Policy runs.

```ts
policy: (m) => {
  const mode = m.policyParams?.toolMode;
  return mode === 'strict'
    ? { kind: 'safe_path' }
    : { kind: 'fast_path' };
}
```

### Case 2: “Policy wants to validate a tool result”

#### Bad

```ts
policy: (m) => {
  const raw = m.memory?.window?.latestToolRaw;
  if (!raw?.invoiceId) return { kind: 'call_tool_again' };
  return { kind: 'continue' };
}
```

#### Good

Validate in Perception, store validated summary in Learning, and let Policy read only the validated fact.

```ts
policy: (m) => {
  if (!m.worldModel?.latestInvoiceId) {
    return { kind: 'call_tool_again' };
  }
  return { kind: 'continue' };
}
```

### Case 3: “Policy wants to read a document or artifact”

#### Bad

```ts
policy: async (m) => {
  const text = await m.memory?.window?.documentHandle;
  return text.includes('urgent')
    ? { kind: 'escalate' }
    : { kind: 'archive' };
}
```

#### Good

If the content changes what the agent knows, load it in Learning and store the derived fact.

```ts
policy: (m) => {
  return m.worldModel?.documentUrgency === 'high'
    ? { kind: 'escalate' }
    : { kind: 'archive' };
}
```

### Case 4: “Policy wants to look at tokens or await state”

#### Bad

```ts
policy: (m, env) => {
  if (env.pending?.children?.fetchProfile) {
    return { kind: 'wait' };
  }
  return { kind: 'delegate_to_child', agentId: 'fetch-profile', input: {} };
}
```

#### Good

Keep await logic in control state and let the runtime/Transition own suspension. Policy should reason from summarized facts, not transport state.

```ts
policy: (m) => {
  if (m.worldModel?.profileStatus === 'ready') {
    return { kind: 'use_profile' };
  }
  return { kind: 'request_profile' };
}
```

### Case 5: “Policy wants to generate or repair a multi-step plan”

#### Bad

```ts
policy: async (m, ctx) => {
  // ❌ Asynchronous policy, calling LLM directly
  const planSteps = await ctx.llm.call('Create a plan for...'); 
  return { kind: 'execute_plan', steps: planSteps };
}
```

#### Good

Planning computation (LLM usage) is an Execution effect. Policy should only decide *when* it's time to plan.

```ts
policy: (m) => {
  if (!m.plans?.activePlanId) {
    // ✅ Emits a simple intent. Execution calls the LLM, 
    // Transition emits a 'plan.proposed' observation, Learning stores it.
    return { kind: 'create_plan', goalId: m.goalState.activeGoalId }; 
  }
  return { kind: 'execute_next_step', planId: m.plans.activePlanId };
}
```

### Case 6: “Policy wants to branch on current Stage”

#### Bad

```ts
policy: (m, ctx) => {
  // ❌ Stage is control orchestration, not cognition
  if (Stage.is(ctx, 'awaiting_validation')) {
    return { kind: 'wait' };
  }
  return { kind: 'proceed' };
}
```

#### Good

Policy should remain stage-blind. 
If behavior must change after a stage transition, write a durable semantic fact into `MentalState` when entering the new phase, and let Policy read that fact. Alternatively, simply let Transition handle the `await` state unconditionally.

```ts
policy: (m) => {
  // ✅ Branching on a cognitive fact
  if (m.worldModel?.validationStatus === 'pending') {
    return { kind: 'wait' };
  }
  return { kind: 'proceed' };
}
```

## Safe implementation process

When a developer or LLM proposes a new piece of logic, do this in order:

1. Write down the desired decision in plain language.
2. Identify the exact fact Policy would need in order to make that decision.
3. Put that fact into one of three buckets:
   - validated observation
   - cognitive memory
   - execution-only input
4. If it is a validated observation, implement it in Perception.
5. If it is cognitive memory, write it in Learning.
6. If it is execution-only input, leave it out of Policy and use it in Execution.
7. Make Policy read only the compact, already-prepared fact.

## LLM-safe checklist before accepting a Policy change

- Does Policy remain synchronous?
- Does Policy read only `MentalState`?
- Did we remove any temptation to read `ctx` or `env`?
- Is the fact Policy depends on already validated?
- Is the fact already written into `MentalState`?
- Is any heavy data replaced with a summary or derived fact?
- Can Policy now be tested with a plain `MentalState` fixture only?
- Does Policy return a strictly typed `Intent` from the agent's known allowed intents without inventing new ones?

If any answer is no, the change is probably in the wrong module.

## Fast review comment you can leave on a PR

> This change crosses module boundaries. Please show the full turn story: Execution result, Transition outcome, inbox observation, Perception validation, Learning write, Policy read, and tests. Right now the change looks partial and may lose data between turns.