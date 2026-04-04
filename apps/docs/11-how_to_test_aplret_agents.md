# How-to: Test APLRET agents

Use this guide to build tests that are robust under async resumes, retries, and LLM variability.
See also: [TurnTrace debugging](./12-how_to_debug_with_turn_trace.md)

**Package:** `createTestHarness`, stubs, and assertion helpers are exported from **`@a2arium/callagent-core`** (there is no separate test-harness package).

---

## The testing model

APLRET tests work best as **turn scripts**. Each script is a sequence of:

1. Arrange current inbox and pending state
2. Run one turn
3. Assert the `TurnTrace` for that turn
4. If the turn awaited, inject the resume observation
5. Repeat

This model catches bugs that only show up between turns — when data is lost between modules, or when a resume observation is misrouted — and keeps tests readable even when the agent involves LLMs.

---

## Quick start

The minimal harness test — all defaults, one turn:

```ts
import { createTestHarness } from '@a2arium/callagent-core';

const h = createTestHarness({
    policy: (_m, _mem) => ({ kind: 'answer_with_llm', query: 'Hello.' }),
});

h.llmStub().enqueue({ role: 'assistant', content: 'Hi there!' });

await h.runTurn();

h.expectTurn(t => {
    t.expectIntent('answer_with_llm');
    t.expectTransition('continue');
});
expect(h.replies()[0]).toBe('Hi there!');
```

`createTestHarness(modules)` accepts **the same `Partial<Modules>` bag** used in `createAgent()`. Only provide the modules your test exercises; everything else falls back to framework defaults.

---

## Seeding state

Before running the first turn:

```ts
// Cognitive state — deep-merged onto initialM() defaults.
// Use the real MentalState shape: sensory data lives under memory.sensory (not a top-level `sensory` field).
h.seedMentalState({
    memory: { sensory: { userInput: 'inv_123' } },
});

// env.pending — same structure the loop uses (inputs, tools, children, groups, …)
h.seedPending({ tools: { 'tok-abc': { toolName: 'billing.lookup' } } });

// Control flow — stage, tokens, and other StageFacade / writeControlVar paths live here,
// NOT under MentalState.memory. Use nested objects so dot paths resolve (e.g. fetch.token → fetch: { token: … }).
h.seedControlVars({
    stage: 'idle',
    fetch: { token: 'tok-abc' },
});
```

To read back sensory state after a turn, use the same path:

```ts
expect(h.currentM().memory.sensory.userInput).toBe('inv_123');
```

**MentalState vs control vars:** `MentalState` (see the type in `loop/types`) has `memory.sensory`, `memory.longTerm`, `worldModel`, `goalState`, etc. It does **not** have a `memory.vars` field. Anything you previously put into "vars" for stage or tokens belongs in **control vars** — seed with `seedControlVars`, or let `Stage.set` / `writeControlVar` set them during the turn.

---

## Injecting observations and running turns

Always `await h.runTurn()`. Injection is chainable with it:

```ts
// Turn 1
await h.injectUserInput('Find invoice inv_123').runTurn();

h.expectTurn(t => {
    t.expectIntent('call_tool');
    t.expectTransition('await_tool');
    t.expectAwaitToken('tok-abc');
});

// Turn 2 — resume with tool result
const token = h.lastAwaitToken(); // 'tok-abc'
await h.injectToolCompleted({ token, tool: 'billing.lookup', result: { status: 'paid' } }).runTurn();

h.expectComplete();
```

**All injection helpers:**

| Method | Observation created |
|--------|-------------------|
| `injectUserInput(value)` | `source: 'user', kind: 'input.provided'` |
| `injectToolCompleted({ token, tool, result })` | `source: 'tool', kind: 'tool.completed'` |
| `injectToolFailed({ token, tool, error })` | `source: 'tool', kind: 'tool.failed'` |
| `injectChildCompleted({ token, agentId, result })` | `source: 'child', kind: 'child.completed'` |
| `injectChildFailed({ token, agentId, error })` | `source: 'child', kind: 'child.failed'` |
| `injectObservation(obs)` | Raw observation (validated via `normalizeObservationInbox`) |

### Await token propagation

When a turn ends with `await_tool`, `await_child`, or `await_input`, the framework tracks a **token** that ties the dispatched operation to its resume observation. This token must flow consistently through three places:

```
execution produces it → transition carries it → resume observation matches it
       ↑                        ↑                          ↑
 trace.execAction.token   trace.transition.token    injectToolCompleted({ token })
```

The `transition` module is responsible for reading the token from the execution outcome and placing it in the `TransitionOut`. If either step drops the token, the resume observation won't match the pending entry and the agent will either re-trigger the action or stall.

**Assert token propagation explicitly:**

```ts
h.expectTurn(t => {
    t.expectTransition('await_tool');
    t.expectAwaitToken('tok-abc'); // asserts transition.token, not execAction.token
});
```

To also assert the token made it through execution:
```ts
const trace = h.lastTrace();
expect(trace.execAction?.token).toBe('tok-abc');       // execution produced it
expect(trace.transition?.token).toBe('tok-abc');        // transition carried it
```

**Always capture the token dynamically for resume injection.** Never hardcode it — even when you control the execution mock, the framework may generate or transform the token:

```ts
// ✅ Correct — token-agnostic, works even if the value changes
const token = h.lastAwaitToken();
await h.injectToolCompleted({ token, tool: 'billing.lookup', result: {} }).runTurn();

// ❌ Fragile — breaks silently if token generation changes
await h.injectToolCompleted({ token: 'tok-abc', tool: 'billing.lookup', result: {} }).runTurn();
```

`lastAwaitToken()` reads `trace.transition.token` from the last trace and throws a descriptive error if no token is present (which catches cases where the transition kind was wrong).

### Multi-turn lifecycle (what `runTurn()` does between calls)

Each **`await h.runTurn()`** runs one outer loop iteration, then in a **`finally`** block the harness:

- increments **`state.turnCount`** and **`env.turn`**
- appends a snapshot of **`env.inbox.current`** to **`inboxAll`**, then either **clears** `env.inbox.current` or **re-stages** it when the turn’s trace shows **`transition.kind === 'continue'`** and there were observations (so internal feedback such as `state.noted` is visible to **perception** on the next `runTurn()`)

For **`await_*`**, **`complete`**, **`fail`**, and similar outcomes, the inbox is cleared so the next turn starts from what you **`inject*`** (or an empty inbox). That avoids endlessly re-processing the same external observation while still supporting multi-step **`continue`** chains across harness turns. The **`turn`** field on each **`TurnTrace`** is the loop’s turn index for that run (it follows **`env.turn`** at the start of that `runTurn()` / `runLoop` call).

If you enable **`CALLAGENT_DEBUG_HARNESS`**, the log line prints **`state.turnCount` before that increment**, so the first completed turn is labeled **`Turn 0 finished`** — that is “zeroth completed turn,” not “env.turn is stuck at 0.”

---


## Assertions

### Top-level harness assertions

| Method | What it checks |
|--------|---------------|
| `expectComplete()` | `transition.kind === 'complete'` |
| `expectFail()` | `transition.kind === 'fail'` |
| `expectInvariantError(fn)` | An `InvariantError` was thrown; passes it to `fn` |
| `expectModuleError(fn)` | A `ModuleExecutionError` was thrown; passes it to `fn` |

### `expectTurn(fn)` — per-turn trace assertions

Passed a `TurnAssertionContext`. All methods throw `HarnessAssertionError` with `expected`, `actual`, and `turn` on mismatch. All methods chain.

| Method | Checks |
|--------|--------|
| `expectIntent(kind)` | `trace.intent?.kind` (typed: `Intent['kind']`) |
| `expectShield(action)` | `trace.shield?.action` (typed: `ShieldOutcome['action']`) |
| `expectTransition(kind)` | `trace.transition?.kind` (typed: `TransitionOut['kind']`) |
| `expectAwaitToken(token)` | `trace.transition?.token` |
| `expectStageTransition(from, to)` | `trace.stageTransition` |
| `expectStageBefore(stage)` | `trace.stageBefore` |
| `expectStageAfter(stage)` | `trace.stageAfter` |
| `expectInboxKinds(kinds)` | All expected kinds appear in `trace.inboxCurrent` |
| `expectMemoryChanged()` | `mentalStateAfterHash !== mentalStateBeforeHash` |

**Stage fields on `TurnTrace`:** `stageBefore` and `stageAfter` are filled from the **stage transition recorded when `Stage.set` runs in that turn** (the `__stageTrace` path inside the loop). If a turn **never** calls `Stage.set`, there is no transition row for that turn — the trace falls back to **`stageBefore === 'idle'`** (and `stageAfter` follows), even when **`readControlVar(ctx, 'stage')`** would already return a non-idle value carried over from a **previous** turn. For multi-turn scripts:

- Assert **`expectStageAfter('…')`** (or **`expectStageTransition`**) on the turn **where** the stage changes.
- To reason about **carry-over**, assert the **previous** trace’s `stageAfter`, use **`Stage.summary(ctx)`** in agent code, or seed **`seedControlVars({ stage: '…' })`** before the first turn — do not assume **`expectStageBefore('fetching_html')`** on turn 2 unless turn 2 itself performs a `Stage.set` that uses that as its `from` value.

Example — asserting multiple properties in one turn:

```ts
h.expectTurn(t => {
    t.expectIntent('call_tool');
    t.expectShield('pass');
    t.expectStageTransition('idle', 'awaiting_tool');
    t.expectTransition('await_tool');
    t.expectAwaitToken('tok-abc');
    t.expectMemoryChanged();
});
```

### Error assertions

```ts
// InvariantError — e.code and e.message are directly on the error
h.expectInvariantError(e => {
    expect(e.code).toBe('STAGE_REQUIRES_KEY');
    expect(e.invariant.detail.type).toBe('stage_invariant');
    expect(e.message).toContain('fetch.token');
});

// ModuleExecutionError
h.expectModuleError(e => {
    expect(e.module).toBe('perception');
    expect(e.originalMessage).toContain('null reference');
});
```

---

## LLM and tool stubs

### LLM stub

`createTestHarness()` injects a `DeterministicLLMStub` as `ctx.llm`. It implements `ILLMCaller` fully — including `getHistoryMode()` — so the default `answer_with_llm` execution module treats it as a configured LLM and actually calls it.

```ts
// Queue responses (FIFO); if queue is empty, returns 'default test response'
h.llmStub().enqueue({ role: 'assistant', content: 'Invoice paid.' });
h.llmStub().enqueueMany([
    'First response',
    { role: 'assistant', content: 'Second response' }
]);

await h.runTurn();

// Inspect what was called
const calls = h.llmStub().getCalls();
expect(calls[0].message).toBe('query string here');
```

### Tool stub

```ts
// 1. Register expected results before running the turn
h.toolStub().register('billing.lookup', { invoiceId: 'inv_123', status: 'paid' });

// 2. Run the turn — execution calls ctx.tools.invoke('billing.lookup', args)
await h.runTurn();

// 3. Inspect what was called after the turn
const calls = h.toolStub().getCalls();
expect(calls).toHaveLength(1);
expect(calls[0].tool).toBe('billing.lookup');
```

---

## Module signatures

> [!WARNING]
> The most common test migration failure is getting module parameter order wrong. **All mocks must match these exact signatures** from `Modules<Sensory>` in `oneTurn.ts`.

| Module | Signature |
|--------|-----------|
| `attention` | `(mPrev, env, mem) => Alpha` |
| `perception` | `(env, alpha, mem) => Obs` |
| `learning` | `(mPrev, prevAction, o, mem, writer, rPrev?) => MentalState` |
| `policy` | `(m, mem) => Intent \| Array<{ action: Intent; prob: number }>` |
| `shield` | `(m, a, mem) => ShieldOutcome` |
| `execution` | `(a, ctx, mem, m) => Promise<ExecOutcome>` |
| `transition` | `(env, exec, m, mem) => TransitionOut` |

> [!IMPORTANT]
> **`execution` and `transition` are separate modules.** `execution` returns `ExecOutcome` — what action was taken and what the result was. `transition` reads that and decides the next state. Do not embed transition logic in the execution return value.

**`ExecOutcome` shape:**
```ts
import type { ExecOutcome, ExecResult } from '@a2arium/callagent-core';

// status: 'ok' | 'error' — NOT success: boolean
const outcome: ExecOutcome = {
    action: { kind: 'call_tool' },
    result: { status: 'ok', data: { invoiceId: '123' } } satisfies ExecResult,
};
```

---

## `TurnTrace` reference

Access via `h.lastTrace()` or `h.allTraces()`. Key fields for assertions:

| Field | Description |
|-------|-------------|
| `turn` | Loop turn index for that `runTurn()` (matches **`env.turn`** at the **start** of that call; successive harness turns typically show `0`, `1`, `2`, …) |
| `stageBefore` / `stageAfter` | From the **stage transition** captured when **`Stage.set`** runs this turn; default **`idle`** when no `Stage.set` occurred (see assertions section above) |
| `stageTransition` | `{ from, to }` when stage changed this turn |
| `stageAutoMarksApplied` | Control keys auto-set during transition |
| `inboxCurrent` | Compact summary of observations visible this turn |
| `intent` | Chosen intent: `{ kind, data }` |
| `shield` | Shield decision: `{ action, data }` |
| `execAction` | Action sent to execution: `{ kind, token?, data }` |
| `execResult` | Result: `{ status, data, error?, correlationId? }` |
| `transition` | Next state: `{ kind, token?, result? }` |
| `rewards` | `{ total: number }` — sum of extrinsic + intrinsic rewards |
| `mentalStateBeforeHash` / `mentalStateAfterHash` | Detect when Learning mutated M |
| `timings` | Per-module ms breakdown |
| `llmCalls` | Each LLM call: prompt, tokens, contract metadata |
| `toolCalls` / `childCalls` | Tool/child dispatches with status |
| `pendingAfter` | Pending input/tool/child tokens after this turn |

**High-signal assertions that catch "lost between turns" bugs:**

1. `trace.inboxCurrent` has the expected `source` + `kind`
2. `trace.mentalStateAfterHash !== trace.mentalStateBeforeHash` — Learning wrote a fact
3. `trace.intent.kind` changed exactly when Learning wrote the fact
4. `trace.shield.action === 'pass'` for effectful intents
5. `trace.execAction.token` matches `trace.transition.token`
6. `trace.pendingAfter` is empty after completion (`expectComplete()`)

When asserting `llmCalls` for structured output:
```ts
expect(trace.llmCalls![0].hasOutputContract).toBe(true);
expect(trace.llmCalls![0].outputContractName).toBe('InvoiceResult');
expect(trace.llmCalls![0].outputContractStatus).toBe('matched');
```

---

## Minimum test suite

Every agent should have at least these five categories. Each category can be one or more test cases.

### 1) Golden path

The smallest realistic flow to completion. Assert **per turn**: inbox kinds, intent, shield, execAction, transition, stage movement. At the end, assert terminal result shape and empty `pendingAfter`.

```ts
it('completes invoice lookup end-to-end', async () => {
    await h.injectUserInput('inv_123').runTurn();
    h.expectTurn(t => {
        t.expectIntent('call_tool');
        t.expectShield('pass');
        t.expectTransition('await_tool');
    });
    await h.injectToolCompleted({ token: h.lastAwaitToken(), tool: 'lookup', result: { status: 'paid' } }).runTurn();
    h.expectComplete();
});
```

### 2) Resume path

At least one test per await category you use: `await_input`, `await_tool`, `await_child`.

**Key invariant:** Tool/child results influence Policy only on the *next* turn, after re-entering via inbox and Learning.

```ts
it('resumes correctly after tool completion', async () => {
    await h.runTurn(); // turn ends with await_tool
    const token = h.lastAwaitToken();

    await h.injectToolCompleted({ token, tool: 'search', result: { found: true } }).runTurn();
    h.expectTurn(t => {
        t.expectInboxKinds(['tool.completed']);
        t.expectMemoryChanged(); // Learning wrote the tool result
    });
});
```

### 3) Failure path

- Malformed observation rejected by Perception
- Shield veto or defer
- Timeout or retry exhaustion
- Idempotency key collision

```ts
it('shield vetoes dangerous actions', async () => {
    await h.injectUserInput('delete everything').runTurn();
    h.expectTurn(t => {
        t.expectIntent('call_tool');
        t.expectShield('defer');     // shield blocked it
        t.expectTransition('await_input'); // asks user to confirm
    });
});
```

### 4) Invariant enforcement

- Awaiting without a token → `InvariantError` with `detail.type === 'transition_invariant'`
- Invalid source-kind observation → `validation.failed` observation injected
- Terminal state then another await → `InvariantError` with `detail.type === 'transition_invariant'`
- StageFacade missing required key → `InvariantError` with `detail.type === 'stage_invariant'`; assert `e.invariant.detail.required`
- Module failure → `ModuleExecutionError` with typed `module` field

```ts
it('throws InvariantError when transition awaits without token', async () => {
    await h.runTurn();
    h.expectInvariantError(e => {
        expect(e.invariant.detail.type).toBe('transition_invariant');
    });
});
```

### 5) Stage transitions (when using StageFacade)

- Assert `trace.stageBefore` / `trace.stageAfter` on turns where **`Stage.set`** actually runs (see **Stage fields on `TurnTrace`** under Assertions)
- Assert `trace.stageAutoMarksApplied` when marks auto-apply
- Trigger a failing transition; assert `e.code === 'STAGE_REQUIRES_KEY'` and `e.invariant.detail.required`
- Use `Stage.summary(ctx)` → `{ current, hasPendingInput, hasPendingTool, hasPendingChild, markCount }` for control state assertions

---

## Full example: async tool flow

```ts
import {
    createTestHarness,
    type MentalState,
    type EnvironmentState,
    type MemoryReader,
    type Intent,
    type ExecOutcome,
} from '@a2arium/callagent-core';

type Sensory = { userInput?: string };

const h = createTestHarness<Sensory>({
    perception: (env: EnvironmentState, _alpha, _mem: MemoryReader) => {
        const last = env.inbox?.current?.at(-1);
        return last?.source === 'user'
            ? { userInput: String((last.payload as Record<string, unknown>)?.value ?? '') }
            : {};
    },
    learning: (mPrev: MentalState<Sensory>, _prev, o, _mem, _writer) => ({
        ...mPrev,
        memory: {
            ...mPrev.memory,
            sensory: { ...mPrev.memory.sensory, ...(o as Record<string, unknown>) } as Sensory,
        },
    }),
    policy: (m: MentalState<Sensory>, _mem: MemoryReader): Intent =>
        m.memory.sensory?.userInput
            ? { kind: 'call_tool', toolName: 'billing.lookup', args: { id: m.memory.sensory.userInput }, mode: 'async' }
            : { kind: 'complete', result: 'done' },
    execution: async (a: Intent): Promise<ExecOutcome> => ({
        action: { kind: 'call_tool', token: 'tok-abc' },
        result: { status: 'ok', data: null },
    }),
    transition: (_env, _exec, m: MentalState<Sensory>) =>
        m.memory.sensory?.userInput
            ? { kind: 'await_tool' as const, token: 'tok-abc' }
            : { kind: 'complete' as const },
});

// Turn 1
await h.injectUserInput('inv_123').runTurn();
h.expectTurn(t => {
    t.expectIntent('call_tool');
    t.expectShield('pass');
    t.expectTransition('await_tool');
    t.expectAwaitToken('tok-abc');
    t.expectMemoryChanged();
});

// Turn 2 — resume
await h.injectToolCompleted({
    token: h.lastAwaitToken(),
    tool: 'billing.lookup',
    result: { status: 'paid' },
}).runTurn();
h.expectTurn(t => t.expectInboxKinds(['tool.completed']));
h.expectComplete();
```

---

## Full example: child-agent flow

```ts
import { createTestHarness } from '@a2arium/callagent-core';

// Separate harness — each example is self-contained
const h = createTestHarness({
    policy: () => ({ kind: 'delegate_to_child', agentId: 'pricing-agent', input: { sku: 'X' } }),
    // execution and transition use framework defaults
});

await h.injectUserInput('Delegate to pricing').runTurn();
h.expectTurn(t => {
    t.expectIntent('delegate_to_child');
    t.expectTransition('await_child');
});

await h.injectChildCompleted({
    token: h.lastAwaitToken(),
    agentId: 'pricing-agent',
    result: { price: 99 },
}).runTurn();
h.expectTurn(t => {
    t.expectInboxKinds(['child.completed']);
    t.expectMemoryChanged(); // Learning wrote the result
});
h.expectComplete();
```

---

## Test patterns

### Pattern A: Deterministic core, tolerant outer assertions

LLM output varies. Test intent kind, transition kind, presence of structured data, safety decisions, and whether Learning wrote expected facts. Avoid strict assertions on natural-language text.

### Pattern B: Snapshot the trace, not the chat

For regression tests, snapshot a filtered subset of `TurnTrace`: `stageBefore/After`, inbox kinds, intent kind, shield action, execAction kind, transition kind, `pendingAfter` summary.

### Pattern C: Prove idempotency across resumes

Resume with the same token twice. Assert Execution does not repeat the external effect. Assert the second resume is ignored or produces a safe error observation.

---

## Harness configuration

`createTestHarness` accepts an optional second argument. It is validated at construction time by **`HarnessConfigSchema`** (Zod); invalid values throw immediately.

```ts
const h = createTestHarness(modules, {
    maxTurns: 1,              // schema default; see note below
    deterministicTime: true,
    seedTokens: true,
    manifestProvenance: {
        agentCardSource: 'inline',
        runtimeManifestSource: 'inline',
        agentCardHash: 'abc123',
        runtimeManifestHash: 'def456',
    },
});
```

**Practical note:** Multi-turn tests are written as **multiple** `await h.runTurn()` calls (each run appends traces and advances harness / env turn state). The harness implementation may still evolve which config fields are wired through to `runLoop`; if a field appears to have no effect, prefer relying on explicit per-turn scripts and check the current `TestHarness` source for the latest behavior.

---

## Test file organization

Recommended structure:

```
packages/<your-agent>/tests/
├── golden-path.test.ts        # happy-path turn scripts
├── resume-flows.test.ts       # await/resume for each category
├── failure-paths.test.ts      # malformed obs, shield vetoes, timeouts
├── invariant-checks.test.ts   # transition & stage invariant violations
└── stage-transitions.test.ts  # StageFacade-specific (if applicable)
```

Each file creates its own harness instance. Do **not** share a harness across `describe` blocks — it's cheap to create and has no external dependencies.

---

## Low-level alternative: `runLoop` with `collectTraces`

For integration tests where `createTestHarness` is too restrictive:

```ts
const result = await runLoop(ctx, M, env, modules, {
    maxTurns: 10,
    collectTraces: true,
});
// result.traces is TurnTrace[]
expect(result.traces![0].transition?.kind).toBe('continue');
```

Prefer `createTestHarness` for all unit/integration tests. Use `runLoop` directly only when testing the loop driver itself, or in full integration rigs where you control context construction externally.

---

## How to test multi-module changes

When a change touches more than one module:

- [ ] Intent union updated?
- [ ] Observation taxonomy updated?
- [ ] Perception validates the new observation?
- [ ] Learning writes the new fact?
- [ ] Policy reads only the new fact?
- [ ] Execution and Transition propagate tokens correctly?
- [ ] TurnTrace captures the key decisions?
- [ ] Tests include happy + malformed + resume + invariant cases?

---

## Review comment for PRs

> Please assert the turn trace, not just the final output. A correct APLRET change should be visible in TurnTrace at the point where the new observation enters, where Learning writes the new fact, and where Policy reacts next turn.
