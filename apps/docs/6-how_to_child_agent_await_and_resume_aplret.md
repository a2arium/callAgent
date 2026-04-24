# How-to: Child-Agent Await and Resume (APLRET)

Use this guide when an agent needs to delegate work to a child agent and correctly handle async completion.

## Goal

- Delegate to a child agent **without** blocking the loop.
- Suspend the parent loop with `await_child(token)`.
- Resume correctly when the child completes.
- Make the child result visible to Policy only after it flows through inbox → Perception → Learning → `MentalState`.

## Non-negotiable rules

- Policy is sync and reads only `MentalState`.
- Perception reads only `env.inbox.current`.
- Child dispatch is an effect and happens only in Execution.
- Child completion re-enters only as a `child.completed` observation.

## Phase 3: `sendTaskToAgent` and threads

`sendTaskToAgent` is implemented over **`ctx.conversation.startThread` / `send`** (plus A2A). That means a **durable thread message** and inbox observations align with direct conversation usage. **`A2ACallOptions.timeout` is enforced** (maps to conversation-level timeouts / races).

To continue an existing thread across multiple child calls, pass **`A2ACallOptions.conversation: ThreadRef`** (thread-only). The child can read the `ThreadRef` from its inbox and answer with **`ctx.conversation.send(threadRef, ...)`**.

## The canonical flow (two turns)

### Turn N (dispatch)

1. Policy emits an intent to delegate.
2. Shield passes/transforms/defers/vetoes.
3. Execution calls `sendTaskToAgent(..., { awaitCompletion: false })`.
4. Execution extracts `handle.token` immediately.
5. Execution returns `ExecOutcome` where `action.kind = 'child'` and includes the token.
6. Transition returns `await_child(token)`.

### Turn N+1 (resume)

1. Runtime injects `source:'child', kind:'child.completed'` into `env.inbox.current`.
2. Perception validates the child completion payload.
3. Learning writes a compact, reasoning-ready summary into `MentalState`.
4. Policy branches on that durable fact.

## Minimal types

### Intent

Keep this small and explicit.

```ts
type Intent =
  | { kind: 'request_profile'; userId: string }
  | { kind: 'use_profile' }
  | { kind: 'wait' };
```

### Observation taxonomy (child)

Runtime injects child completion as:

- `source: 'child'`
- `kind: 'child.completed'`

Payload envelope must include at least:

- `token`
- `result` (or `error`)
- identifiers: `agentId`, `childTaskId` when available

## TurnTrace and child calls

Each turn’s **TurnTrace** can include **`childCalls`**: an array of **ChildCallTrace** entries for child tasks dispatched or completed in that turn. Each entry has:

- **`token`**, **`agentId`**, **`childTaskId`**, **`awaitCompletion`**
- **`durationMs`**, **`status`** (`'dispatched'`, `'completed'`, `'failed'`, `'input_required'`)
- **`parentTurnId`**, **`childAgentNodeId`**, **`childTraceId`** for linking to the parent turn or the child’s trace
- **`resultSummary`**, **`error`** when applicable

Parent and child traces are linked in telemetry via **ChildCallNode** (node type `'child'`): the parent turn’s span has a child span for each dispatched child, and optional `childTraceId` / `childAgentNodeId` connect to the child run’s trace. Use **`trace.childCalls`** when debugging or testing to verify which child was dispatched, with which token, and when it completed.

## Step-by-step implementation

### Step 1: Make Policy request delegation using only `MentalState`

Policy should request delegation when a durable fact is missing.

```ts
policy: (m) => {
  const profile = m.worldModel?.profile;
  if (!profile) {
    return { kind: 'request_profile', userId: m.worldModel?.userId };
  }
  return { kind: 'use_profile' };
}
```

Important:

- Policy does not check pending tokens.
- Policy does not check await state.

Policy reasons only from durable facts.

### Step 2: Execute delegation and extract token immediately

```ts
execution: async (intent, ctx) => {
  if (intent.kind !== 'request_profile') {
    return {
      action: { kind: 'internal', done: true },
      result: { status: 'ok', data: { skipped: true } }
    };
  }

  const handle = await ctx.sendTaskToAgent(
    'profile-agent',
    { userId: intent.userId },
    { awaitCompletion: false }
  );

  // Always extract token immediately as a primitive.
  const token = handle.token;

  return {
    action: { kind: 'child', token },
    result: {
      status: 'ok',
      data: { requested: true, token, agentId: 'profile-agent' }
    }
  };
};
```

Rules:

- Never return a complex handle object in results.
- Token must survive serialization.

### Step 3: Transition to await_child using the same token

```ts
transition: (_env, exec, _m, _mem) => {
  if (exec.action.kind === 'child') {
    return { kind: 'await_child', token: exec.action.token };
  }

  return { kind: 'complete', result: { ok: true } };
};
```

Invariant:

- awaited token must match token produced by Execution.
- **StageFacade rule**: If the resulting stage name begins with `awaiting_`, the framework must declare a `require: [...]` token invariant OR use the base await stage with the standard pending slot.

### Step 4: Validate child completion in Perception

Perception reads only the staged inbox batch.

```ts
type Obs =
  | { kind: 'child_profile_received'; profile: { name: string; tier: string } }
  | { kind: 'child_failed'; reason: string }
  | { kind: 'idle' };

perception: (env) => {
  const childObs = env.inbox.current.find(
    o => o.source === 'child' && o.kind === 'child.completed'
  );

  if (!childObs) return { kind: 'idle' };

  const result = childObs.payload.result as any;

  // Validate the minimal fields you need.
  if (!result?.name || !result?.tier) {
    return { kind: 'child_failed', reason: 'invalid_profile_result' };
  }

  return {
    kind: 'child_profile_received',
    profile: { name: String(result.name), tier: String(result.tier) }
  };
};
```

Make Perception loud:

- validate required fields
- produce structured errors instead of silently returning idle

### Step 5: Write a compact durable fact in Learning

```ts
learning: (prev, _prevAction, obs) => {
  if (obs.kind === 'child_profile_received') {
    return {
      ...prev,
      worldModel: {
        ...prev.worldModel,
        profile: obs.profile,
        profileStatus: 'ready'
      }
    };
  }

  if (obs.kind === 'child_failed') {
    return {
      ...prev,
      worldModel: {
        ...prev.worldModel,
        profileStatus: 'failed',
        profileError: obs.reason
      }
    };
  }

  return prev;
};
```

Policy will now see `profileStatus` and branch correctly, without touching control state.

## Failure handling patterns

### Pattern A: child failed → write a durable failure fact

- Perception normalizes to `child_failed`
- Learning writes `profileStatus: 'failed'`
- Policy chooses a recover intent (retry, ask user, or abort)

### Pattern B: child result is malformed

- Perception returns `child_failed` with `reason: 'invalid_*'`
- Policy can choose to retry once, or escalate

### Pattern C: timeout

If the runtime supports child timeouts:

- runtime injects `source:'child', kind:'child.failed'` with timeout metadata
- Perception normalizes and Learning writes a failure fact

## Common bugs and how to spot them with TurnTrace

### Bug: token mismatch

Symptoms:

- `await_child(tokenA)` but completion arrives with `tokenB`

Fix:

- ensure Execution uses `handle.token`
- ensure Transition awaits `exec.action.token`

### Bug: Policy re-delegates repeatedly

Symptoms:

- Policy keeps emitting `request_profile`

Usually means:

- child completion never reached inbox
- Perception dropped it
- Learning never wrote `worldModel.profile`

Debug:

- check `inboxCurrent` for `child.completed`
- check Perception output
- check memory hash change

### Bug: child result used in the same turn

Symptoms:

- Policy appears to “see” the result immediately

Fix:

- ensure completion enters via inbox on the next turn
- ensure no ad-hoc writes to `MentalState` from Execution

## Testing checklist

Minimum tests:

- happy path: delegate → await_child → inject completion → policy uses profile
- malformed result: inject completion with missing field → perception fails → policy recovers
- token mismatch: inject completion with wrong token → invariant error
- double resume: inject same completion twice → idempotency or safe ignore behavior

In tests, assert TurnTrace fields:

- intent kind
- transition kind
- awaited token
- presence of `child.completed` in inbox on resume turn
- memory hash change on Learning write
- next intent changes only after Learning write

## Thread conversation interplay

`sendTaskToAgent` remains valid for child-await orchestration.  
 `ctx.conversation` is used for thread-native messaging.

- Use `sendTaskToAgent` when you want explicit child await semantics (`await_child(token)`).
- Use `ctx.conversation.startThread/send` when you need durable thread identity and multi-message follow-up.
- Both paths obey the same APLRET rule: effects in Execution, cognition updates only after observation re-entry.

## Topic invite interplay (Phase 2b)

Topic invites are conversation effects, not child-await primitives:

- issue invite in Execution via `ctx.conversation.invite(...)`
- receive invite as `conversation/topic.invite.received` observation on a later turn
- optionally auto-join when runtime manifest sets `communication.autoJoinInvitedTopics = true`
- use `ctx.conversation.join(...)` or `ctx.conversation.decline(...)` in Execution; never from Policy directly

