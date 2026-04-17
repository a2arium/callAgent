# How-to: Keep Branching Consistent in APLRET

Use this guide when you notice branching logic drifting into inconsistent styles across modules (ifs here, switches there, ts-pattern somewhere else) and you want a consistent, powerful approach.

## Goal

- Keep branching style predictable for humans and LLMs.
- Keep union-driven decisions exhaustive.
- Keep validation logic readable and local.
- Prevent “semantic drift” where different modules encode different assumptions.

## The rule

Do not standardize on one syntax everywhere.

Standardize on **decision shape**.

> Same kind of decision → same branching style.

## The branching policy (canonical)

### Perception: guard-style branching

**Use:** `if` + early returns + small validator helpers.

Perception is mostly:

- selecting the right inbox observation
- validating required fields
- normalizing to a compact observation

That is predicate-heavy, so guard-style branching is the most readable.

**Avoid:** deep match trees and mixed validation + transformation in one giant block.

### Learning: event reducer branching

**Use:** `switch (obs.kind)` on a closed normalized observation union.

Learning is a reducer from normalized observations to `MentalState` updates.

Keep it boring:

- one `case` per observation kind
- immutable updates
- no effects

**Require:** exhaustiveness.

Learning’s `switch (obs.kind)` assumes a **closed discriminated union** for normalized observations — see [APLRET contracts](./0-aplret_contracts.md) (Observation model). Open `kind: string` shapes defeat exhaustiveness and reviewability.

### `flow.md` and branch IDs

For non-trivial agents, major branches in code should have **named counterparts** in **`flow.md`** (e.g. `### B1: Validation failure`). Stable IDs (`B1`, `B2`, …) tie together code review, tests, and debugging. See [How-to: `flow.md` for APLRET agents](./13-flow_md_for_aplret_agents.md).

### Policy: compact decision branching

**Use:**

- short `if` guards (1–2) for simple presence checks
- `switch` for closed unions

Policy should be:

- sync
- M-only
- compact

If Policy becomes a long if-pyramid, it is a sign that:

- the facts in `MentalState` are not compact enough, or
- the flow should be promoted to a more explicit state model.

### Shield: ordered check pipeline

**Use:** a pipeline of independent checks.

Shield is not a state machine. It is a gate.

Standardize it as:

- `checkBudget`
- `checkPII`
- `checkConsent`
- `checkPolicy`

with a strict precedence rule:

- veto wins
- defer wins
- transforms apply in order

### Execution: intent dispatch branching

**Use:**

- `switch (intent.kind)` **or** a typed handler map.

Execution handles a closed intent union and is effectful.

**Require:** exhaustiveness.

### Transition: action dispatch branching

**Use:** `switch (exec.action.kind)`.

Transition must be explicit, token-safe, and invariant-safe.

**Require:** exhaustiveness.

**Recommendation:** If the agent has multiple await states or strict token requirements, delegate the actual state mutation and invariant checks to **`Stage.set(ctx, newStage)`** (from `createStageFacade`) within the switch branches. The call returns a **`StageTransitionResult`** with `from`, `to`, `autoMarksApplied`, and `invariantChecks` for logging or assertions.

## Allowed tools

### `if`

Use only for:

- small local guards
- validation checks
- early exit conditions

### `switch`

Use for:

- discriminated unions (`kind` fields)
- core public contract decisions

### `ts-pattern`

Allowed when:

- it makes matching significantly clearer than `switch`
- the team has standardized on it
- it remains small and local

Not recommended as the default teaching path.

### Statecharts

Promote to statecharts when:

- you have many stages
- many guards/timeouts
- parallel waits
- multiple re-entry paths
- the dispatcher is becoming brittle

## Exhaustiveness rules

You must handle closed unions exhaustively in:

- Learning (normalized observation kinds)
- Execution (intent kinds)
- Transition (exec action kinds)

### Baseline exhaustiveness helper

Use a standard helper in the framework:

```ts
export function assertNever(x: never, msg?: string): never {
  throw new Error(msg ?? `Unhandled case: ${String(x)}`);
}
```

Example:

```ts
switch (intent.kind) {
  case 'prompt_user':
    return handlePrompt(intent);
  case 'call_tool':
    return handleTool(intent);
  default:
    return assertNever(intent);
}
```

## Review checklist (LLM-safe)

When reviewing a change, ask:

- Did the change introduce a new union member (intent/obs/stage/action)?
- If yes, did Learning/Execution/Transition add an explicit handler?
- Did Perception add a validator for new inbox payload shapes?
- Is Policy still short and branching only on compact facts?
- Did Shield remain a pipeline, not a mini-policy engine?
- Did we avoid mixing validation and decision logic across modules?

## Common anti-patterns and fixes

### Anti-pattern: Policy grows into a dispatcher

Symptoms:

- long if chains
- checks raw payload fields
- checks pending tokens

Fix:

- move validation to Perception
- move durable writes to Learning
- make Policy branch on compact facts only

### Anti-pattern: Learning branches on raw inbox shapes

Symptoms:

- Learning reads inbox directly
- Learning checks source/kind

Fix:

- Perception produces a normalized union
- Learning switches on that normalized union only

### Anti-pattern: Execution uses nested ifs by stage + intent

Symptoms:

- Execution becomes a state machine by accident

Fix:

- keep Execution dispatch on intent kind
- keep stage coordination in Transition/control state
- if complexity remains, promote to statecharts

## Recommended standard templates

### Perception template

- select observation from inbox
- validate
- return normalized obs

### Learning template

- `switch (obs.kind)`
- immutable update

### Policy template

- read compact facts
- short branching

### Execution template

- dispatch by intent kind
- return `{ action, result }`

### Transition template

- dispatch by `exec.action.kind`
- enforce await invariants

## Fast PR comment

> Branching style is drifting across modules. Please follow the APLRET branching policy: guard-style Perception, reducer-style Learning, compact Policy, pipeline Shield, exhaustive dispatch in Execution and Transition. Ensure new union members are handled exhaustively.

## Conversation invite branching note

When adding topic invite lifecycle behavior, keep the same branching discipline:

- Perception: guard-validate `topic.invite.received|accepted|declined|expired`
- Learning: reducer cases update `pendingInvites` / `invitesInbox`
- Execution: exhaustive `Intent` dispatch (`invite`, `join`, `decline`, `leave`, `post`)
- Transition: emit explicit conversation observations; do not hide invite state transitions in ad-hoc control flags

