# APLRET Contracts

## Status

Normative reference for loop-mode agents in the callagent framework.

This document defines the stable contract for building APLRET agents. If a behavior is documented here, users and tools may depend on it.

## Purpose

APLRET is a turn-based agent architecture with explicit separation between:

- cognition (MentalState)
- control (env.pending / env.control / inbox)
- effects (Execution only)
- observability (TurnTrace)

Its goals are:

- make the correct path obvious
- make invalid state transitions loud
- make effect boundaries explicit
- make resume flows replayable and testable
- make agent implementations predictable for humans and LLMs

## Core model

APLRET stands for:

- **A**ttention
- **P**erception
- **L**earning
- **R**easoning / Policy
- **E**xecution
- **T**ransition

Shield runs between Policy and Execution as a guard.

Canonical order per turn:

1. Attention
2. Perception
3. Learning
4. Policy
5. Shield
6. Execution
7. Transition

## Non-negotiable rules

### 1) Turn discipline

The runtime operates in discrete turns.

- Every effect result becomes available only on a later turn.
- Policy never reads future data.
- Inputs for the current turn come only from `env.inbox.current`.
- Results from Execution must flow through Transition as observations before they can influence cognition.

Canonical effect-to-cognition path:

`Execution -> ExecOutcome -> Transition -> Observation[] -> env.inbox.current (next turn) -> Perception -> Learning -> MentalState`

### 2) Single writer for cognition

Only Learning may update `MentalState`.

- Perception does not update memory.
- Policy does not update memory.
- Shield does not update memory.
- Execution does not update memory.
- Transition does not update memory.

### 3) Single effect boundary

Only Execution may perform side effects.

Examples:

- LLM calls
- tool calls
- child-agent dispatch
- outbound replies
- input requests
- writes to external systems

### 4) Inbox-only Perception

Perception reads only `env.inbox.current` plus Attention output.

If the runtime wants to provide clock ticks, environment snapshots, external events, or page state, it MUST inject them as observations into the inbox.

### 5) Sync, M-only Policy

Policy is synchronous and reads only `MentalState`.

Policy MUST NOT:

- read `env`
- read `ctx`
- read inbox directly
- await artifacts
- call tools
- call LLMs
- perform I/O

If configuration affects reasoning, that configuration MUST be materialized into `MentalState.policyParams` before Policy runs.

If artifact content affects cognition, Learning loads it.

If artifact content is needed only to act, Execution loads it.

### 6) Canonical execution shape

Execution always returns:

```ts
export type ExecOutcome<Data = unknown, Err = unknown> = {
  action: ExecAction;
  result: ExecResult<Data, Err>;
};
```

Transition always consumes that exact shape.

### 7) Explicit control ownership

Cognition and control are different systems.

- Cognitive state lives in `MentalState`
- Control state lives in `env.pending`, `env.control`, and inbox observations

Never persist cognition in control state.
Never persist control flags in `MentalState`.

---

## Canonical dataflow

### Turn input

At the start of a turn, the runtime presents:

- `env.inbox.current`: observations staged for this turn only
- `env.inbox.all`: append-only history of all prior observations
- `env.pending`: mechanical state for pending tools, children, inputs, and control variables
- `env.control`: current control snapshot and last execution metadata

Perception reads only `env.inbox.current`.

### Turn output

Execution returns an `ExecOutcome`.

Transition converts that outcome into one of:

- `continue`
- `await_input`
- `await_tool`
- `await_child`
- `complete`
- `fail`

When Transition returns `continue`, it MUST include `observations: Observation[]`.

Those observations become available to the next turn through `env.inbox.current`.

---

## Public types

### MentalState

`MentalState` is the single source of truth for cognition.

Goals and plans that influence decisions are cognition and MUST live in `MentalState`.

Recommended shape:

```ts
export type GoalId = string;
export type PlanId = string;

export type GoalStatus = 'active' | 'blocked' | 'done' | 'failed';
export type PlanStatus = 'draft' | 'active' | 'stale' | 'completed' | 'failed';
export type StepStatus = 'todo' | 'doing' | 'done' | 'failed' | 'skipped';
export type StepKind = 'ask_user' | 'call_tool' | 'delegate_child' | 'llm' | 'internal';

export type Goal = {
  id: GoalId;
  title: string;
  status: GoalStatus;
  type?: 'objective' | 'subtask' | 'constraint' | 'check';
  priority?: number;
  parentId?: GoalId;
  context?: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
};

export type PlanStep = {
  id: string;
  goalId?: GoalId;
  title: string;
  kind: StepKind;
  args?: Record<string, unknown>;
  dependsOn?: string[];
  status: StepStatus;
};

export type Plan = {
  id: PlanId;
  goalId?: GoalId;
  status: PlanStatus;
  steps: PlanStep[];
  cursor: number;
  revision: number;
  createdAt: string;
  updatedAt: string;
};

export type MentalState<Sensory = unknown> = {
  /** Cognition memory strata (Learning-owned writes). */
  memory: {
    sensory?: Sensory;
    window?: unknown;
    scratch?: unknown;
    longTerm?: {
      episodic?: unknown[];
      semantic?: Record<string, unknown>;
      procedural?: Record<string, unknown>;
    };
  };

  /** Beliefs and derived state used for decisions. */
  worldModel?: Record<string, unknown>;

  /** Hierarchical objectives (cognition). */
  goalState: {
    goals: Record<GoalId, Goal>;
    activeGoalId?: GoalId;
  };

  /** Multi-step plans (cognition). */
  plans?: {
    plans: Record<PlanId, Plan>;
    activePlanId?: PlanId;
  };

  /** Reward/budget signals (if used). */
  reward?: Record<string, unknown>;

  /** Reasoning-relevant config materialized into cognition. */
  policyParams?: Record<string, unknown>;
};
```

This shape is extensible, but the ownership rules are fixed.

### Memory guidance

Use memory strata intentionally.

#### Sensory memory

Short-lived, normalized view of the latest user-visible or system-visible facts needed by Policy.

Examples:

- latest validated user message
- latest validated tool summary
- latest child result summary

#### Window / scratch

Small, short-lived working set owned by Learning.

Use for:

- temporary planning context
- intermediate extraction summaries
- compact execution receipts needed for one or two future turns
- plan proposals before validation (optional)

Do not use for:

- raw large payloads
- control flags
- permanent truth

Authoritative plans MUST be stored under `plans` after validation.

#### Episodic memory

Append-only summaries of meaningful observations and outcomes.

Use for:

- turn history
- audit summaries
- coarse replay support
- later explanation or introspection

Store summaries, not giant blobs.

#### Semantic memory

Stable, reason-ready facts.

Use for:

- user preferences
- validated entities
- durable constraints
- known task facts
- deduplicated child outcomes

#### Procedural memory

Stable skills or house-style procedures.

Optional. Use only when the agent benefits from durable internal playbooks.

### What must not go into MentalState

Do not store these in `MentalState`:

- pending tokens
- await flags
- retry counters for in-flight work
- unvalidated raw inputs
- massive HTML, images, or JSON blobs inline
- raw transport handles (e.g., TaskHandle objects, tool client instances)

Use artifacts for large payloads and keep only handles and derived facts in memory.

---

## Observation model

Observations are the only runtime input to Perception.

Each observation has:

- `source`
- `kind`
- `payload`
- provenance such as token, timestamp, correlation id, tool/agent identifiers

Recommended source taxonomy:

- `user`
- `tool`
- `child`
- `internal`
- `env`

### Canonical source-kind taxonomy

Use a small, stable vocabulary.

User:

- `user / input.provided`
- `user / input.cancelled`

Tool:

- `tool / tool.completed`
- `tool / tool.failed`
- `tool / tool.progress` (optional)

Child:

- `child / child.completed`
- `child / child.failed`
- `child / child.progress` (optional)

Internal:

- `internal / llm.responded`
- `internal / plan.proposed`
- `internal / plan.updated`
- `internal / goal.updated`
- `internal / validation.failed`

Env:

- `env / config.updated`
- `env / clock.tick`
- `env / snapshot.available`

### Taxonomy rules

- each `source` must have a small finite set of supported `kind` values
- invalid source-kind pairs must fail validation loudly
- if a new kind becomes common, promote it into the shared taxonomy

---

## ctx and working memory (runtime context)

The framework may provide `ctx.*` namespaces. They MUST NOT create a second cognitive truth.

### Authoritative cognition

- `MentalState` is authoritative
- only Learning writes it
- Policy reads only it

### `ctx.world` (read-only)

`ctx.world` exposes a **read-only** view of `MentalState.worldModel`:

- **`ctx.world.read()`** returns a deep read-only copy of the current world model (no mutation of `MentalState`).
- There is no `ctx.world.update()` or `ctx.world.patch()`; only Learning may mutate `worldModel` via `MemoryWriter.world.set()`.

### Thoughts / telemetry

If `ctx.thoughts` exists, it is telemetry:

- append-only
- not authoritative
- SHOULD be exportable in TurnTrace/logs

### Goals and decisions

If `ctx.goals` or `ctx.decisions` exist, they MUST NOT directly mutate authoritative cognition.

Allowed models:

- they emit internal observations (`internal/goal.updated`, `internal/decision.recorded`) which Learning applies next turn

Policy MUST depend on goals/decisions stored in `MentalState`, not on `ctx.*`.

---

## Canonical payload envelopes

These envelopes define the minimum stable shape of observations in `env.inbox.current`.

### User

```ts
type UserObservation<T> = {
  source: 'user';
  kind: 'input.provided' | 'input.cancelled';
  payload: {
    token: string;
    value: T;
    ts?: string;
    correlationId?: string;
  };
};
```

### Tool

```ts
type ToolObservation<T> = {
  source: 'tool';
  kind: 'tool.completed' | 'tool.failed' | 'tool.progress';
  payload: {
    token: string;
    tool: string;
    result?: T;
    error?: unknown;
    ts?: string;
    correlationId?: string;
  };
};
```

### Child

```ts
type ChildObservation<T> = {
  source: 'child';
  kind: 'child.completed' | 'child.failed' | 'child.progress';
  payload: {
    token: string;
    agentId?: string;
    childTaskId?: string;
    result?: T;
    error?: unknown;
    executionMetadata?: {
      state?: string;
      timestamp?: string;
      timings?: unknown;
      rewards?: unknown;
    };
    ts?: string;
    correlationId?: string;
  };
};
```

### Internal

Internal observations are framework/agent-generated events that must flow through the same inbox pipeline.

```ts
type InternalObservation<T> = {
  source: 'internal';
  kind:
    | 'llm.responded'
    | 'plan.proposed'
    | 'plan.updated'
    | 'goal.updated'
    | 'validation.failed'
    | 'state.noted';
  payload: {
    value: T;
    ts?: string;
    correlationId?: string;
  };
};
```

### Env

Environment observations represent external runtime signals. They must be injected into the inbox.

```ts
type EnvObservation<T> = {
  source: 'env';
  kind: 'config.updated' | 'clock.tick' | 'snapshot.available';
  payload: {
    value: T;
    ts?: string;
    correlationId?: string;
  };
};
```

## Canonical observation rules

* Perception validates and normalizes inbox observations.
* Perception never mutates memory.
* Structured perception errors should become normalized observations (e.g., `internal/validation.failed`) rather than cross-module throws when possible.
* Transition must emit observations for all continue-style outcomes.
* Every observation should carry enough provenance to explain where it came from and how it relates to the current turn.

---

## Memory model

`MentalState` stores cognition, not transport details.

### Memory placement table

| Concern                              | Recommended location                          | Why                                      |
| ------------------------------------ | --------------------------------------------- | ---------------------------------------- |
| latest validated user message        | `memory.sensory`                              | easy synchronous access for Policy       |
| latest compact tool summary          | `memory.sensory` or `memory.window`           | short-lived decision support             |
| latest compact child outcome summary | `memory.sensory` or `worldModel`              | decision support without wrappers        |
| active goal + goal tree              | `goalState`                                   | cognition; Policy must read it           |
| active plan + step statuses          | `plans`                                       | cognition; Policy must read it           |
| temporary plan draft/proposal        | `memory.window`                               | staging before validation                |
| intermediate extraction notes        | `memory.scratch`                              | disposable cognition owned by Learning   |
| important past turn summary          | `memory.longTerm.episodic`                    | audit and retrospective reasoning        |
| stable facts and entities            | `memory.longTerm.semantic` or `worldModel`    | durable reasoning state                  |
| durable skills or recipes            | `memory.longTerm.procedural`                  | repeatable internal methods              |
| pending input/tool/child token       | `env.pending` / `env.control`                 | control, not cognition                   |
| raw 10MB HTML / image / JSON         | artifact handle in memory, raw data offloaded | protects snapshot size and replay health |
| runtime stage                        | control state                                 | orchestration, not reasoning             |

### Write rules

* Learning writes summaries and validated facts, not raw transport wrappers.
* Prefer compact derived facts over storing raw payloads.
* If a value is needed only to act, keep a handle and load it in Execution.
* If a value changes what the agent knows, derive and store the reasoning-relevant subset in memory.

### Memory anti-patterns

Do not:

* store pending tokens in memory
* store `await_*` flags in memory
* store duplicate truths in both control state and cognition
* store unbounded chat history inline without summarization
* store entire tool or child transport wrappers when a normalized summary is enough
* store raw large payloads inline (use artifacts)


---

## Module contracts

### Attention

Purpose: reduce noise and focus Perception.

Contract:

```ts
attention(prevM, env) => AttentionSignal
```

Rules:

- reads `MentalState` and runtime state
- no side effects
- no memory writes
- no decisions about external actions

Attention is optional for simple agents.

### Perception

Purpose: normalize and validate current-turn observations.

Contract:

```ts
perception(env, attention) => ObservationNormalized
```

Rules:

- reads only `env.inbox.current` and Attention output
- validates schemas, ranges, units, provenance
- emits structured perception errors instead of throwing when possible
- does not update `MentalState`
- does not perform effects

### Learning

Purpose: update cognition from normalized observations.

Contract:

```ts
learning(prevM, prevAction, observation, reward?) => M | Promise<M>
```

Rules:

- only writer of `MentalState`
- must return a new state
- may be async only to load artifacts or perform minimal cognition-related reads needed for the update
- no external side effects
- should prefer compact, validated writes

### Policy

Purpose: decide what should happen next.

Contract:

```ts
policy(m) => Intent
```

Rules:

- synchronous
- reads only `MentalState`
- no effects
- no memory writes
- no access to `env` or `ctx`
- no artifact loading

### Shield

Purpose: enforce safety, compliance, and budgets.

Contract:

```ts
shield(m, intent) => ShieldOutcome
```

Canonical outcomes:

```ts
type ShieldOutcome<I> =
  | { action: 'pass'; intent: I }
  | { action: 'transform'; intent: I; note?: string }
  | { action: 'defer'; askUser: string; reason?: string }
  | { action: 'veto'; reason: string };
```

Rules:

- no effects
- no memory writes
- must be observable

### Execution

Purpose: perform effects and package their result.

Contract:

```ts
execution(intent, ctx, m) => Promise<ExecOutcome>
```

Canonical output:

```ts
type ExecOutcome<Data = unknown, Err = unknown> = {
  action: ExecAction;
  result: ExecResult<Data, Err>;
};
```

Rules:

- only effect boundary
- responsible for timeouts, bounded retries, idempotency keys, correlation ids
- must not write `MentalState`

### Transition

Purpose: convert execution results into control flow and next-turn observations.

Contract:

```ts
transition(env, exec, m) => TurnOutcome
```

Rules:

- no memory writes
- no external side effects
- must enforce await invariants
- if `continue`, must include observations

---

## Intent and stage models

### Intent 

Intents are a closed discriminated union.

Example:

```ts
type Intent =
  | { kind: 'prompt_user'; prompt?: string }
  | { kind: 'answer_with_llm'; query: string; contextKey?: string }

  // Tools / children
  | { kind: 'call_tool'; toolName: string; args: Record<string, unknown>; mode: 'sync' | 'async' }
  | { kind: 'delegate_to_child'; agentId: string; input: unknown }

  // Planning
  | { kind: 'create_plan'; goalId: string }
  | { kind: 'execute_next_step'; planId: string }
  | { kind: 'repair_plan'; planId: string; reason: string }

  // Terminal / idle
  | { kind: 'complete'; result: unknown }
  | { kind: 'wait' };
```

Rules:

- keep the union small and explicit
- handle all cases exhaustively
- new intent kinds require explicit changes to Policy, Shield, and Execution
- intent kinds are internal API; do not expose them as A2A skills unless intentional

### Stage

Stages are a closed union and represent control state, not cognition.

Example:

```ts
type BaseStage =
  | 'idle'
  | 'awaiting_input'
  | 'awaiting_tool'
  | 'awaiting_child'
  | 'running'
  | 'completed'
  | 'failed';

// Agent may refine:
type AgentStage =
  | BaseStage
  | 'awaiting_fetch'
  | 'analyzing'
  | 'awaiting_validation_fetch'
  | 'validating';
```

Rules:

- stage lives in control state, not `MentalState`
- transitions between stages must be explicit
- each await stage must have a corresponding token.
- Any stage whose name begins with awaiting_ MUST declare a require: [...] token invariant (StageFacade) OR use the base await stage and the standard pending slot.
- runtime should reject impossible combinations

**StageFacade** (`createStageFacade<St>({ stages, initial, ... })`) is the canonical API for stage management. The returned **`StageFacade<St>`** exposes:

- **`get(ctx)`** — current stage
- **`set(ctx, stage)`** — transition; returns **`StageTransitionResult<St>`** (`from`, `to`, `autoMarksApplied`, `invariantChecks`); stage and autoMarks are committed **atomically** (validate-before-commit); **`onEnter`** runs post-commit with **`StageEnterContext`** (only `progress` and `complete`) and is non-transactional (no rollback if it throws)
- **`is(ctx, stage)`** — equality check
- **`assert(ctx, stage?)`** — assert current-stage invariants
- **`summary(ctx)`** — **`StageSummary<St>`**: normalized, non-leaky shape `{ current, hasPendingInput, hasPendingTool, hasPendingChild, markCount }` (no raw control keys). Typed control keys: use **`defineControlKeys({ ... })`** from `@a2arium/callagent-core` for invariants and autoMarks.

Recommended invariant examples:

- `awaiting_input` requires an input token
- `awaiting_tool` requires a tool token
- `awaiting_child` requires a child token
- `completed` and `failed` are terminal

---

## Artifact model

Artifacts are handles for large payloads that must not be kept inline.

Rules:

- Policy never awaits artifacts
- Learning may await artifacts if content changes cognition
- Execution may await artifacts if content is needed only to act

---

## LLM usage model

LLM calls are effects. They belong in Execution.

### Rule

Policy may decide to use an LLM, but Policy never calls an LLM.

LLM outputs may influence decisions only after they flow through:

`Execution -> Transition (observations) -> inbox -> Perception -> Learning -> MentalState`

### Canonical patterns

#### Pattern 1: answer with LLM

* Learning stores validated user input in `M.memory.sensory`
* Policy emits `{ kind: 'answer_with_llm', ... }`
* Shield checks budget and policy
* Execution calls the LLM and emits a reply
* Transition emits observations describing the result
* Next turn Learning records the outcome

#### Pattern 2: extract structured data with LLM

* Policy emits an extraction intent
* Execution calls the LLM with an explicit schema/contract for the expected output
* Execution returns `{ action, result }` with the parsed candidate value or structured failure
* Transition emits an observation containing the structured result or structured failure
* Perception validates the observation payload shape
* Learning validates and writes stable facts into `M.worldModel` and/or `M.memory.longTerm.semantic`

#### Pattern 3: generate or repair a plan with LLM

Planning computation is an effect. Plan state is cognition.

* Policy emits `create_plan(goalId)` or `repair_plan(planId, reason)`
* Shield checks budgets/policy
* Execution calls the LLM to produce a structured plan object
* Transition emits `internal/plan.proposed` or `internal/plan.updated`
* Perception validates the plan schema
* Learning writes the plan into `M.plans` (sets `activePlanId`, bumps `revision`, updates `cursor/status`)
* Next turn Policy emits `execute_next_step(planId)`

### LLM output contract requirements

LLM calls are effects and belong in Execution.

#### Rule: structured output must be contracted

Unless the expected result is purely free text, the Execution module MUST supply an explicit output contract to the LLM call.

The contract MUST be provided as a Zod schema (or an equivalent JSON Schema wrapper supported by the framework).

#### Rule: contract failures are handled explicitly

If the LLM output does not conform to the contract:

- Execution MUST return a structured failure in `ExecResult` (do not throw across modules).
- Transition MUST emit an observation that represents the failure.
- Learning MUST write a durable fact that Policy can reason about (retry, repair, or ask user).

#### Example (contracted output)

```ts
const response = await ctx.llm.call(prompt, {
  data: simplifiedHtml,
  jsonSchema: { name: 'ListingStructure', schema: listingContract }
});
```

### Notes

* LLM calls MUST NOT be placed in Policy, Learning, Perception, Shield, or Transition.


---

## Tool usage model

Tools are effects. They belong in Execution.

### Rule

Policy may decide to use a tool, but Policy never calls a tool.

Tool outputs may influence decisions only after they flow through:

`Execution -> Transition (observations) -> inbox -> Perception -> Learning -> MentalState`

### Unified tool API

All tools (native or external) MUST be invoked through the unified tool API exposed by the runtime.

### Pattern A: inline tool call (blocking)

Use when the result is needed immediately and blocking the loop is acceptable.

* Policy emits `call_tool` with `mode: 'sync'`
* Execution calls the tool with `awaitCompletion: true`
* Execution returns `{ action, result }` containing the tool result
* Transition emits `continue` with a tool-result observation
* Next turn Perception validates the tool observation and Learning writes durable facts

### Pattern B: async tool call (await/resume)

Use when the tool should suspend the loop.

* Policy emits `call_tool` with `mode: 'async'`
* Execution requests the tool with `awaitCompletion: false`
* Execution extracts the token immediately as a primitive string
* Execution returns `{ action, result }` with `action.kind = 'tool'` and the token
* Transition returns `await_tool(token)`
* On completion, runtime injects a `tool / tool.completed` observation into the next turn inbox

### Rule: validate structured tool results

If a tool result is used as structured input for reasoning (world model, goals, plans), it MUST be validated before Learning writes it into `MentalState`.

Canonical placement:

* Perception validates the tool payload shape (schema / zod / type guard)
* Learning writes compact, reasoning-relevant facts

Unvalidated raw tool payloads MUST NOT be written into `MentalState` as authoritative facts.

---

## Child-agent model

Child-agent dispatch is an effect. It belongs in Execution.

### Canonical child flow (async)

1. Policy emits `delegate_to_child`
2. Shield approves/blocks
3. Execution calls `sendTaskToAgent(..., { awaitCompletion: false })`
4. Execution extracts `handle.token` immediately as a primitive string
5. Execution returns `{ action, result }` with `action.kind = 'child'` and the token
6. Transition returns `await_child(token)`
7. Runtime pauses the parent loop
8. Child completion is injected into the parent inbox as `child / child.completed` (or `child / child.failed`)
9. Perception validates the child payload
10. Learning writes a summarized child outcome into `MentalState`
11. Policy decides the next intent

### Inline child call (blocking)

If the framework supports `awaitCompletion: true`, it MAY be used for tool-like child calls.

Even then, the output must become cognition only through the inbox pipeline:

* Transition emits an internal observation
* Next turn Learning writes the durable fact

### Child result storage guidance

Store compact, reasoning-ready data only:

* child task id
* child agent id
* summarized result
* completion time
* execution state
* optional performance summary

Do not store entire transport wrappers if the framework already provides a normalized child observation payload.

### Plan integration (when using plans)

If a child result completes a plan step:

* Perception normalizes the completion
* Learning marks the corresponding `M.plans.steps[stepId].status` as `done` or `failed`
* Learning advances `cursor` when appropriate

Policy remains small and reads only the updated `MentalState`.


---

## Planning model

Planning computation is an effect.

Rules:

- plan generation/repair via LLM/tool happens in Execution
- plan changes enter through observations (`internal/plan.proposed`, `internal/plan.updated`)
- Learning validates and writes plans into `MentalState.plans`
- Policy remains small: create plan, execute next step, repair plan

---

## TurnTrace

The runtime emits **exactly one** structured TurnTrace per turn (one-turn-one-trace model). No ModuleNode or per-module spans; module timings live in `TurnTrace.timings`.

TurnTrace is the primary unit of truth for debugging and testing. The normative shape is backed by Zod in `packages/core/src/types/turnTrace.ts` (`TurnTraceSchema`).

Recommended shape (matches implementation):

```ts
type TurnTrace = {
  turn: number;
  turnId: string;

  // Manifest provenance (required; persisted/resumed with snapshot)
  agentCardSource: 'defaultPath' | 'pathOverride' | 'inline';
  runtimeManifestSource: 'defaultPath' | 'pathOverride' | 'inline';
  agentCardHash: string;
  runtimeManifestHash: string;

  // Stage
  stageBefore: string;
  stageAfter?: string;
  stageTransition?: { from: string; to: string };
  stageAutoMarksApplied?: string[];
  stageInvariantChecks?: StageInvariantCheckResult[];
  stageInvariantError?: InvariantErrorPayload;

  // Inbox (compact summary: source, kind, token)
  inboxCurrent: InboxObservationSummary[];

  // Module outputs (compact)
  attention?: JsonValue;
  perception?: PerceptionTrace;
  mentalStateBeforeHash?: string;
  mentalStateAfterHash?: string;
  intent?: IntentTrace;
  shield?: { action: 'pass' | 'transform' | 'defer' | 'veto'; note?: string; reason?: string };
  execAction?: ExecActionTrace;
  execResult?: ExecResultTrace;
  transition?: TransitionTrace;

  // Pending state (normalized summary)
  pendingAfter?: PendingSummary;

  // Timing and usage
  timings: TurnTimings;
  usage?: TurnUsage;

  // Correlation
  correlationId?: string;
  traceId?: string;
  spanId?: string;

  // Sub-call summaries (LLM, tool, child calls during this turn; linked via ChildCallNode for children)
  llmCalls?: LLMCallTrace[];
  toolCalls?: ToolCallTrace[];
  childCalls?: ChildCallTrace[];

  // Error (if turn failed)
  error?: { code?: string; message: string; module?: FrameworkModule; detail?: JsonValue };
};
```

**Manifest provenance persistence/resume:** When TurnTrace is enabled, the runtime stores `ManifestProvenance` (agentCardSource, runtimeManifestSource, agentCardHash, runtimeManifestHash) on the task context and in snapshot meta. On resume, provenance is restored from snapshot so every TurnTrace carries the same provenance for the run. Identity (name/version) must match between Agent Card and Runtime Manifest or the loop will not start.

**Child tracing:** Child-agent dispatch and completion are recorded in `TurnTrace.childCalls[]`. Parent/child traces are linked via `ChildCallNode` (telemetry node type `'child'`) and optional `parentTurnId` / `childTraceId` / `childAgentNodeId` in `ChildCallTrace`.

### TurnTrace requirements

- One trace record per turn (no more, no fewer).
- Stable `turnId` per turn.
- Include stage before and after (and `stageTransition` when StageFacade is used).
- Include await token when relevant (in `pendingAfter` and transition).
- Include shield action.
- Include execution latency and cost metadata when available (`timings`, `usage`).
- Include enough data to reconstruct why Policy chose its intent (`intent`, `perception`, `inboxCurrent`).
- Sub-spans (LLM, tool, child) are logical children of the turn; child execution is linked via `ChildCallNode`.

### Correlation requirements

TurnTrace should support correlation across logs, traces, and execution artifacts.

At minimum:

- `turnId` should identify the turn inside the agent runtime
- `correlationId` should connect related actions across retries, tools, children, and replies
- `traceId` and `spanId` should be included when distributed tracing is enabled

This aligns with OpenTelemetry correlation practice, where log records may carry trace and span identifiers so signals from the same execution context can be joined reliably.

---

## Invariants and enforcement

APLRET depends on explicit invariants.

These invariants MUST be enforced by a combination of:

* type system constraints
* runtime validation
* structured error reporting
* tests

### Invariants table

| Invariant                                                                       | Type-level help | Runtime enforcement | Notes                                                                |
| ------------------------------------------------------------------------------- | --------------: | ------------------: | -------------------------------------------------------------------- |
| only Learning writes `MentalState`                                              |         partial |            required | framework should make other modules read-only with respect to memory |
| Policy reads only `MentalState`                                                 |         partial |            required | prevent accidental `env` / `ctx` access in Policy wiring             |
| Policy is synchronous                                                           |             yes |            required | keep reasoning deterministic and easy to test                        |
| Perception reads only `env.inbox.current`                                       |         partial |            required | any ambient input must be injected as an observation                 |
| `await_input` requires input token                                              |         partial |            required | reject missing token                                                 |
| `await_tool` requires tool token                                                |         partial |            required | reject missing token                                                 |
| `await_child` requires child token                                              |         partial |            required | reject missing token                                                 |
| `completed` and `failed` are terminal                                           |         partial |            required | no new awaits after terminal state                                   |
| invalid source-kind observation pairs are rejected                              |             yes |            required | e.g. `source='tool'` with `kind='input.provided'`                    |
| Execution returns `{ action, result }`                                          |             yes |            required | Transition consumes this exact shape                                 |
| continue-style outcomes include observations                                    |             yes |            required | avoid silent state changes                                           |
| raw large payloads are not stored inline in snapshots                           |              no |            required | use artifacts or pruning with loud warning                           |
| **Manifest identity matches** (`agent.runtime.json` name/version == Agent Card) |              no |            required | fail fast at startup                                                 |
| **Served Agent Card is resolved Agent Card** (`/.well-known/agent-card.json`)   |              no |            required | serving must not diverge from runtime resolution                     |
| **TurnTrace includes manifest provenance when enabled**                         |              no |            required | `agentCardSource/runtimeManifestSource` + hashes                     |
| **Goals and plans are written only by Learning**                                |         partial |            required | no direct cognition writes from `ctx.*`                              |
| **Plan invariants**: `cursor` in bounds, `revision` monotonic                   |         partial |            required | validate on Learning write                                           |
| **Structured LLM output uses output contract**                                  |         partial |            required | require zod/jsonSchema in `ctx.llm.call` when not free text          |
| **Structured tool/child results are validated before Learning writes facts**    |         partial |            required | Perception validates schema/type guards                              |

### Invariant error shape

Runtime invariant failures MUST be structured.

The normative shape is defined by the `InvariantErrorPayloadSchema` Zod schema in `packages/core/src/types/invariantError.ts`. The error payload uses a discriminated union for detail types to ensure context-specific fields are only present on the correct error type (Rule 4: illegal states must not compile).

Normative shape:

```ts
type InvariantErrorPayload = {
  code: InvariantErrorCode;  // closed enum, not arbitrary string
  message: string;
  stage?: string;
  detail: InvariantErrorDetail;  // discriminated union on 'type'
  correlationId?: string;
  turnId?: string;
};
```

`InvariantErrorDetail` discriminants: `stage_invariant`, `token_validation`, `observation_validation`, `transition_invariant`, `goal_invariant`, `budget_exceeded`.

Each discriminant carries only its own context (e.g., `stage_invariant` has `required`, `forbidden`, `pendingSnapshot`; `token_validation` has `category`, `token`, `reason`). There are no redundant top-level fields.

Module execution failures (module threw during a turn) use a separate `ModuleExecutionError` class, not the invariant error system, because they represent runtime failures rather than contract violations.

Notes:

* `turnId` is optional but recommended when TurnTrace is enabled.
* Error codes are a closed enum (`InvariantErrorCodeSchema`) — not arbitrary strings — to enable autocomplete and compile-time safety.
* The `throwInvariantError()` factory function centralizes error construction and should be used at all enforcement sites.
* `TaskContext.throw` accepts an optional fourth argument `InvariantErrorContext` (stage, correlationId, turnId). All runtimes (streaming, runner, task engine) delegate to `throwInvariantError()`, so `instanceof InvariantError` is reliable everywhere.
* Malformed observation envelopes at inbox normalization result in an injected `source: 'internal', kind: 'validation.failed'` observation rather than a thrown invariant, so Perception/Learning can handle them.

### Enforcement guidance

The framework MUST enforce invariants as close to the boundary as possible.

Examples:

* reject malformed observations before Perception runs
* reject invalid source/kind pairs at injection time
* reject impossible await outcomes in Transition validation
* reject terminal-state re-entry without explicit restart semantics
* reject child/tool resume events whose tokens do not match pending control state

Manifest enforcement:

* validate both manifests at startup
* fail fast if name/version mismatch
* serve the resolved Agent Card content, not an unrelated file

Planning enforcement:

* validate plan schema before writing to `MentalState`
* enforce `cursor` bounds and `revision` monotonicity

LLM/tool enforcement:

* require output contracts for structured LLM outputs
* validate structured tool/child results in Perception before Learning writes authoritative facts

---

## Testing contract

Agents MUST be testable as turn scripts.

Tests SHOULD assert TurnTrace fields rather than only final user-visible text.

### Minimum required tests

#### 1) Golden path

Test the normal path from first input to completion.

Assert (via TurnTrace):

* stage changes
* intent sequence
* shield outcomes
* execution action/result kinds
* transition outcomes
* final result

#### 2) Resume path

Test await/resume for every await type the agent uses:

* `await_input`
* `await_tool`
* `await_child`

Assert:

* awaited token matches the token produced by Execution
* completion observation appears in inbox on the next turn
* effect results influence behavior only after they re-enter through inbox and Learning

#### 3) Failure path

Test at least:

* Shield veto
* Shield defer
* malformed tool result (schema/type validation failure)
* malformed child result (schema/type validation failure)
* idempotency collision or duplicate resume handling

If the agent uses structured LLM output (non-free-text), test:

* LLM returns non-conforming output
* system produces a structured failure observation
* Learning writes a durable failure fact
* Policy chooses a recovery intent (retry, repair plan, or ask user)

If timeouts/retries are framework-internal and not configurable at the agent level, they are covered by framework tests and are not required per-agent.

#### 4) Invariant path

Test runtime rejection of impossible control states.

Examples:

* awaiting tool with no token
* completed with pending await token
* invalid observation kind for source
* resume event token does not match pending token

#### 5) Manifest provenance (when TurnTrace enabled)

If TurnTrace is enabled, tests MUST be able to assert:

* `agentCardSource` and `runtimeManifestSource`
* `agentCardHash` and `runtimeManifestHash`

This detects configuration drift between environments.

### Planning tests (required when plans are used)

If the agent uses `M.plans`, it MUST include tests for:

* create plan flow (`internal/plan.proposed` enters inbox; Learning writes `M.plans.activePlanId`)
* execute next step flow (cursor advances only after completion re-enters via inbox)
* repair plan flow (`internal/plan.updated`; `revision` increments; plan returns to `active`)

### Recommended harness shape

The framework SHOULD provide a turn-based harness with deterministic injection of:

* current inbox observations
* tool completions
* child completions
* timing control
* manifest sources (default/path/inline) when testing provenance

The harness SHOULD expose helpers to assert:

* intent kinds
* shield outcomes
* transition kinds and awaited tokens
* manifest provenance fields

---

## Error model

Errors MUST be explicit and structured.

### Perception errors

Perception SHOULD emit structured normalized errors when possible.

Examples:

* schema invalid
* missing token
* wrong source-kind combination
* unsupported payload version

Perception errors should not silently disappear; they should be visible to Learning/Policy as durable facts (after Learning writes them).

### Invariant errors

Invariant failures MUST throw `InvariantError` (from `packages/core/src/utils/errors.ts`) with a structured `InvariantErrorPayload`. The payload MUST include:

* `code` — closed enum from `InvariantErrorCodeSchema` (e.g., `'STAGE_REQUIRES_KEY'`, `'GOAL_NOT_FOUND'`)
* `message` — human-readable description
* `detail` — discriminated union carrying context specific to the error type:
  * `stage_invariant`: stage name, required keys, forbidden keys, pending snapshot
  * `token_validation`: token category, token value, reason (missing/expired/mismatch)
  * `observation_validation`: source, kind, reason, inbox summary (used when validation is enforced by throwing)
  * `session_config`: reason (session_not_found, limit_max_prompts_exceeded), taskId, limit, actual
  * `transition_invariant`: transition kind, reason, pending snapshot
  * `goal_invariant`: goal ID, reason (not_found/has_active_children/priority_out_of_range)
  * `budget_exceeded`: budget type, limit, actual value
* `correlationId` — optional, for distributed tracing
* `turnId` — optional, for TurnTrace correlation

All enforcement sites MUST use the `throwInvariantError()` factory function, not `throw new Error(string)`.

Callers inspect errors via `instanceof InvariantError` and `e.invariant.detail.type` discriminant narrowing.

### Module execution errors

Module failures (when a module throws during `oneTurn`) MUST throw `ModuleExecutionError` (from `packages/core/src/utils/errors.ts`). This is semantically distinct from invariant errors — it represents a runtime failure, not a contract violation.

`ModuleExecutionError` carries:

* `module` — typed enum: `'attention'`, `'perception'`, `'learning'`, `'policy'`, `'shield'`, `'execution'`, `'transition'`
* `originalMessage` — the original error message from the module
* `originalCode` — optional, if the original error had a code

### Execution errors

Execution errors MUST preserve:

* action kind
* correlation id
* typed or structured error payload

Framework-internal retry/timeout details MAY be included when available, but tests should not depend on them unless they are part of the public contract or configured by the agent.


---

## Public API discipline

A framework is a contract.

The following MUST be treated as stable public surface when documented:

* module signatures
* intent shapes
* stage names
* observation source taxonomy
* canonical observation payload envelopes
* execution outcome shape (`ExecOutcome`)
* transition outcome shape (`TurnOutcome`)
* invariant rules
* normalized child and tool observation payloads
* TurnTrace schema fields that users are instructed to depend on
* manifest defaults + resolution rules + canonical serving behavior
* structured JSON Part schema rule for `application/json` Parts

Implementation details MUST NOT leak into the public contract unless the framework is willing to support them over time.

### Public vs internal surfaces

Use this distinction consistently.

#### Stable public surface

Users may depend on these:

* `createAgent(...)` module contract
* default manifest filenames (`agent-card.json`, `agent.runtime.json`)
* manifest resolution precedence (inline > path > default)
* canonical Agent Card serving at `/.well-known/agent-card.json`
* `MentalState` ownership rules (Learning is the only writer)
* canonical `Intent` and `Stage` unions (or documented agent-specific stage unions)
* `ExecOutcome` and `TurnOutcome` shapes
* normalized observation envelopes and taxonomy
* documented helper APIs for input, tool, and child dispatch
* documented artifact handle behavior
* documented StageFacade behavior (invariant semantics, autoMarks semantics, onEnter restrictions)
* documented TurnTrace fields, including manifest provenance:

  * `agentCardSource`, `runtimeManifestSource`
  * `agentCardHash`, `runtimeManifestHash`

#### Internal or unstable surfaces

Users should not depend on these unless the framework explicitly promotes them:

* raw internal snapshot layouts
* undocumented `controlVars` structure
* internal validator helper names
* internal stage helper namespaces not part of StageFacade
* internal telemetry exporter implementation
* internal hashing/canonicalization algorithm details (users may depend on hash stability, not the method)
* temporary compatibility shims
* transport-specific wrapper details before normalization

### Rule for examples

Reference examples MUST use only stable public surface.

If an example requires an internal helper, either:

* promote that helper into the public API first, or
* rewrite the example to avoid it

---

## Minimal canonical example

This example demonstrates one canonical path:

- inbox-only Perception
- Learning as single writer of memory
- sync M-only Policy
- Execution returns `{ action, result }`
- Transition controls await vs complete explicitly

```ts
import { createAgent } from '@a2arium/callagent-core';

type Sensory = {
  latestUserText?: string;
};

type Obs =
  | { kind: 'user_message'; text: string }

type Intent =
  | { kind: 'prompt_user'; prompt: string }
  | { kind: 'answer_with_llm'; query: string }
  | { kind: 'wait' };

export const agent = createAgent<Sensory, Obs, unknown, Intent, unknown>({
  // Manifests resolve automatically from agent-card.json + agent.runtime.json

  attention: (_m, env) => ({
    hasCurrentInput: env.inbox.current.some(o => o.source === 'user')
  }),

  perception: (env) => {
    const userObs = env.inbox.current.find(
      o => o.source === 'user' && o.kind === 'input.provided'
    );

    if (!userObs) {
      return { kind: 'idle' };
    }

    const value = userObs.payload.value;
    const text = typeof value === 'string' ? value : value.text;

    return { kind: 'user_message', text };
  },

  learning: (prev, _prevAction, obs) => {
    if (obs.kind !== 'user_message') return prev;

    return {
      ...prev,
      memory: {
        ...prev.memory,
        sensory: {
          ...(prev.memory?.sensory ?? {}),
          latestUserText: obs.text
        }
      }
    };
  },

  policy: (m) => {
    const text = m.memory?.sensory?.latestUserText;

    if (!text) {
      return { kind: 'prompt_user', prompt: 'Your message' };
    }

    return { kind: 'answer_with_llm', query: text };
  },

  shield: (_m, intent) => {
    return { action: 'pass', intent };
  },

  execution: async (intent, ctx) => {
    if (intent.kind === 'prompt_user') {
      const handle = await ctx.requestInput(intent.prompt);

      return {
        action: { kind: 'ask_user', token: handle.token },
        result: {
          status: 'ok',
          data: { promptRequested: true }
        }
      };
    }

    if (intent.kind === 'answer_with_llm') {
      const res = await ctx.llm.call(intent.query);
      const text = res[0]?.content ?? 'Ok.';

      await ctx.reply(text);

      return {
        action: { kind: 'internal', done: true },
        result: {
          status: 'ok',
          data: {
            replied: true,
            text
          }
        }
      };
    }

    return {
      action: { kind: 'internal', done: true },
      result: {
        status: 'ok',
        data: { idle: true }
      }
    };
  },

  transition: (_env, exec) => {
    if (exec.action.kind === 'ask_user') {
      return {
        kind: 'await_input',
        token: exec.action.token
      };
    }

    return {
      kind: 'complete',
      result: { ok: true }
    };
  }
}, import.meta.url);
```

---

## Final design guidance

This framework is strict by design.

Prefer:

- fewer intent kinds
- fewer stages
- compact observations
- summarized memory writes
- one canonical path for each task
- explicit invariants
- structured telemetry

Avoid:

- hidden config reads in Policy
- async Policy
- direct memory mutation
- storing raw large payloads in memory
- mixing cognition with control
- multiple equivalent public patterns for the same job

A stable framework gives users less ambiguity, not more.

