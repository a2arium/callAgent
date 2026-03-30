# How-to: Test APLRET agents using TurnTrace

Use this guide to build tests that are robust under async resumes, retries, and LLM variability.

## Goal

- Make each test assert the **turn-by-turn contract**, not just the final output.
- Catch partial changes where data gets lost between modules.
- Make tests readable and maintainable for humans and LLMs.

## Preconditions

Your runtime (or harness) must capture TurnTrace per turn and expose it to tests.

### Using `collectTraces: true` with `runLoop`

When you drive the loop via **`runLoop`** (e.g. in a test or harness), pass **`collectTraces: true`** (and optionally **`manifestProvenance`**) in the options:

```ts
const result = await runLoop(ctx, M, env, modules, {
  maxTurns: 10,
  collectTraces: true,
  manifestProvenance: { agentCardSource: 'inline', runtimeManifestSource: 'inline', agentCardHash: '...', runtimeManifestHash: '...' },
});
// result.traces is TurnTrace[] — one entry per turn
expect(result.traces).toBeDefined();
expect(result.traces!.length).toBeGreaterThanOrEqual(1);
const first = result.traces![0];
expect(first.turn).toBe(1);
expect(first.turnId).toBeDefined();
expect(first.agentCardHash).toBeDefined();
expect(first.inboxCurrent).toEqual(expect.any(Array));
expect(first.timings.totalMs).toBeGreaterThanOrEqual(0);
```

You can then assert on **`result.traces`** per turn (intent, shield, transition, stage, pendingAfter, llmCalls, toolCalls, childCalls, etc.) without attaching a separate collector.

When asserting `trace.llmCalls`, include contract metadata checks when structured output is expected:

- `trace.llmCalls[n].hasOutputContract === true`
- `trace.llmCalls[n].outputContractName === '<schema-name>'`
- `trace.llmCalls[n].outputContractStatus === 'matched'` (or `'failed'`)

A test should be able to access:

- `trace.turn`, `trace.turnId`
- `trace.inboxCurrent`
- `trace.intent`
- `trace.shield`
- `trace.execAction`, `trace.execResult`
- `trace.transition`
- `trace.stageBefore`, `trace.stageAfter`
- `trace.stageTransition`, `trace.stageInvariantChecks`, `trace.stageInvariantError` (if using StageFacade — typed as `InvariantErrorPayload` when present)
- `trace.pendingAfter`
- `trace.agentCardSource`, `trace.runtimeManifestSource`, `trace.agentCardHash`, `trace.runtimeManifestHash`

## The testing model

APLRET tests work best when they are **turn scripts**.

Each script is a sequence of:

1. arrange current inbox and pending state
2. run one turn
3. assert the TurnTrace
4. inject a resume observation if the turn awaited
5. repeat

This style keeps the system testable even when the agent is non-deterministic.

## Minimum test suite

### 1) Golden path (happy path)

A golden path is the smallest realistic flow that reaches completion.

**Assert per turn:**

- expected inbox kinds for that turn
- chosen intent kind
- shield action
- expected execAction kind
- expected transition kind
- stage movement (before/after, or via `stageTransition` if using StageFacade)

**Also assert:**

- terminal result shape on completion
- no hidden awaits remain in `pendingAfter`

### 2) Resume path (await/resume)

You must have at least one test for each await category you use:

- `await_input`
- `await_tool`
- `await_child`

**Key invariant:** effect results influence Policy only on a later turn after they re-enter via inbox and Learning.

### 3) Failure path

Include at least:

- malformed observation rejected by Perception
- Shield veto or defer
- timeout or retry exhaustion
- idempotency key collision handling

### 4) Invariant enforcement

Include at least:

- awaiting state without a token is rejected → throws `InvariantError` with `detail.type === 'transition_invariant'`
- invalid source-kind observation is rejected → injects `validation.failed` observation
- terminal state forbids additional awaits → throws `InvariantError` with `detail.type === 'transition_invariant'`
- StageFacade invariant errors (missing required tokens, forbidden state transitions) throw `InvariantError` with `detail.type === 'stage_invariant'` — assert via `e.invariant.detail.required` / `e.invariant.detail.forbidden`
- module failures throw `ModuleExecutionError` with typed `module` field (e.g., `'perception'`, `'execution'`)
- manifest versions and sources match test expectations

### 5) Stage transitions and invariants (when using StageFacade)

When the agent uses **`createStageFacade`**, add tests that:

- **Current stage:** Use **`Stage.get(ctx)`** (or assert on TurnTrace `stageBefore` / `stageAfter`) to verify the stage after a turn or after a resume.
- **Transitions:** Call **`Stage.set(ctx, nextStage)`** in tests (or trigger the code path that does); assert on the returned **`StageTransitionResult`** (`from`, `to`, `autoMarksApplied`, `invariantChecks`) when you need to verify transition details.
- **Invariants:** Use **`Stage.assert(ctx, stage?)`** to assert that the current control state satisfies the invariants for the given stage; or trigger a transition that should fail (e.g. missing required token) and expect **`InvariantError`** with **`e.detail.type === 'stage_invariant'`** and inspect **`e.detail.required`** / **`e.detail.forbidden`**.
- **Summary:** **`Stage.summary(ctx)`** returns a normalized shape `{ current, hasPendingInput, hasPendingTool, hasPendingChild, markCount }`; use it in tests to assert control state without depending on raw control keys.

TurnTrace fields **`stageBefore`**, **`stageAfter`**, **`stageTransition`**, **`stageAutoMarksApplied`**, **`stageInvariantChecks`** (and **`stageTrace`** when exposed by the runtime) are populated from the same data when **`Stage.set()`** runs and the framework records the transition.

## TurnTrace assertions that catch “lost between turns” bugs

These assertions are high signal:

1. **Observation present**
   - The expected `source` and `kind` appear in `trace.inboxCurrent`.

2. **Perception normalized**
   - The normalized perception output contains the expected fields.

3. **Learning wrote the durable fact**
   - `mentalStateAfterHash` changed (or a targeted memory field changed) when expected.

4. **Policy read only the durable fact**
   - `trace.intent` changes only after Learning has written the fact.

5. **Execution ran only after Shield pass**
   - `trace.shield.action` is `pass` or `transform` for effectful intents.

6. **Await token propagated**
   - `trace.execAction` contains the token and `trace.transition` awaits the same token.

If any of these fail, the change is usually incomplete.

## Recommended harness API (shape)

A harness should support:

- running one turn (or multiple via `runLoop`)
- injecting observations into inbox
- injecting tool/child completions by token
- capturing TurnTrace per turn (e.g. via **`runLoop(..., { collectTraces: true })`** → **`result.traces`**)
- asserting stage/pending state

When using **`runLoop`** with **`collectTraces: true`**, assert on **`result.traces`** (e.g. `result.traces![turnIndex].intent`, `result.traces![turnIndex].transition`, `result.traces![turnIndex].pendingAfter`). For a single-turn harness, **`result.traces![0]`** is the first turn’s TurnTrace.

Example shape:

```ts
const h = createHarness(agent)
  .seedMentalState(initialM)
  .injectUserInput({ text: 'Find invoice inv_123' })
  .runTurn();

h.expectTurn(t => {
  t.expectIntent('call_tool');
  t.expectShield('pass');
  t.expectStageTransition('idle', 'awaiting_tool');
  t.expectTransition('await_tool');
});

h.injectToolCompleted({
  token: h.lastAwaitToken(),
  tool: 'billing.lookup_invoice',
  result: { invoiceId: 'inv_123', status: 'paid' }
});

h.runTurn().expectComplete();
```

For invariant error assertions, the harness should support:

```ts
// Assert that a structured InvariantError was thrown
h.expectInvariantError(e => {
  expect(e.invariant.code).toBe('STAGE_REQUIRES_KEY');
  expect(e.invariant.detail.type).toBe('stage_invariant');
  expect(e.invariant.detail.required).toContain('fetch.token');
});

// Assert that a ModuleExecutionError was thrown
h.expectModuleError(e => {
  expect(e.module).toBe('perception');
});
```

The exact API is up to the framework, but the operations above must be possible.

## Test patterns

### Pattern A: Deterministic core, tolerant outer assertions

LLM output often varies.

Prefer testing:

- intent kind and transition kind
- presence of required structured data
- safety decisions
- whether Learning wrote expected facts

Avoid overly strict assertions on natural language text unless you control it tightly.

### Pattern B: Snapshot the trace, not the chat

For regression testing, snapshot TurnTrace fields (or a filtered subset).

Suggested snapshot fields:

- stageBefore/stageAfter
- inbox kinds
- intent kind
- shield action
- execAction kind
- transition kind
- pendingAfter summary

### Pattern C: Prove idempotency across resumes

If your agent may resume the same token twice, add a test:

- resume with the same tool completion twice
- assert that Execution does not repeat the external effect
- assert that the second resume is either ignored or produces a safe error observation

## A concrete example: async tool flow

### Arrange

- inject user input

### Turn 1 expectations

- intent: `call_tool` async
- execAction: `tool` token present
- transition: `await_tool` with same token

### Resume injection

- inject `tool.completed` with matching token

### Turn 2 expectations

- inbox has `tool.completed`
- Learning writes `latestInvoiceId` (or similar)
- Policy switches to next intent based on that fact

## A concrete example: child-agent flow

### Turn 1 expectations

- intent: `delegate_to_child`
- transition: `await_child`

### Turn 2 expectations (after injection)

- Perception validates `child.completed`
- Learning writes summarized child outcome
- Policy branches on the summarized fact

## How to test multi-module changes

Use this checklist when a change touches more than one module.

- intent union updated?
- observation taxonomy updated?
- Perception validates the new observation?
- Learning writes the new fact?
- Policy reads only the new fact?
- Execution and Transition propagate tokens correctly?
- TurnTrace captures the key decisions?
- tests include happy + malformed + resume + invariant cases?

## Review comment for tests

> Please assert the turn trace, not just the final output. A correct APLRET change should be visible in TurnTrace at the point where the new observation enters, where Learning writes the new fact, and where Policy reacts next turn.

