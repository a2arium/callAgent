# Archive note

**Status:** archived originating request. The **implemented** contract is
[`apps/docs/planning-harness/adr/`](../../planning-harness/adr/) (`0001`–`0009`)
and [`apps/docs/planning-harness/specs/README.md`](../../planning-harness/specs/README.md),
not this document.

This file is the historical problem statement. Several items here were
**rejected** (including `Plan.scheduling`, `MentalState.extensions`, and
output `kind: 'value'`). Do not implement from this document.

---

# Improvement Request: Dependency-Aware Planning, Extensibility, Provenance, and Replay Support in CallAgent / APLRET

## Summary

We would like to extend CallAgent / APLRET with several capabilities that are needed for more advanced planning, recovery, observability, and experimentation.

The immediate motivation is a research agent that uses dependency-aware task graphs, hierarchical beliefs, repair, and cross-episode learning. However, the proposed changes should **not** introduce ATG-specific or active-inference-specific concepts into the framework.

The goal is instead to strengthen several generic framework capabilities:

- dependency-aware plans rather than mainly sequential plans;
- extensible plan and cognition metadata;
- explicit validation and output provenance for plan steps;
- revision lineage and eventually structured plan patches;
- extensible TurnTrace telemetry;
- observable durable-memory reads;
- deterministic snapshot fork/replay for testing and counterfactual evaluation.

These capabilities should be useful for many non-trivial agents, including workflow agents, coding agents, research agents, compliance agents, multi-step tool agents, and agents that perform planning and local recovery.

The existing APLRET contracts are already a strong fit for this direction. In particular, we want to preserve the current invariants:

- Learning is the only writer of `MentalState`;
- Policy is synchronous and reads only `MentalState`;
- Execution is the only effect boundary;
- effect results re-enter cognition only through observations;
- cognition and control remain separate;
- TurnTrace remains the runtime unit of truth. fileciteturn1file0

The changes below are intended to extend those contracts rather than bypass them.

---

# 1. Motivation

The current planning model already supports:

```ts
type PlanStep = {
  id: string;
  goalId?: GoalId;
  title: string;
  kind: StepKind;
  args?: Record<string, unknown>;
  dependsOn?: string[];
  status: StepStatus;
};

type Plan = {
  id: PlanId;
  goalId?: GoalId;
  status: PlanStatus;
  steps: PlanStep[];
  cursor: number;
  revision: number;
  createdAt: string;
  updatedAt: string;
};
```

This is enough for simple multi-step plans and already contains the seed of a graph model through `dependsOn`. fileciteturn1file0

For more advanced agents, however, several additional concerns become important:

1. multiple steps can be ready simultaneously;
2. a completed step is not necessarily a validated step;
3. step outputs should be traceable without storing large payloads inline;
4. plan repair should preserve unaffected work;
5. revisions should have lineage;
6. different agents need domain-specific metadata without modifying core types;
7. debugging requires knowing not just the selected intent, but sometimes the alternatives and memory retrieved before the decision;
8. tests should be able to replay exactly the same cognitive/control snapshot under different policies.

We propose addressing these as generic framework improvements.

---

# 2. Design Principles

The changes should follow these principles.

## 2.1 Do not make CallAgent ATG-specific

Do not add core types such as:

```text
AtomicTaskGraph
BeliefNode
ExpectedFreeEnergy
HierarchicalBelief
NegativeTransfer
```

These belong to agent implementations.

The framework should provide primitives that make such agents possible.

## 2.2 Preserve APLRET module ownership

The proposal must not weaken:

```text
Perception → normalize evidence
Learning   → update cognition
Policy     → choose intent
Shield     → enforce constraints
Execution  → perform effects
Transition → create next-turn observations
```

In particular, advanced planners or inference systems should remain implementations inside the existing APLRET cognitive cycle rather than introducing new framework phases.

## 2.3 Prefer typed extension points over `Record<string, unknown>`

Advanced agents need extensibility, but arbitrary maps everywhere reduce safety.

Where possible, use generics so extensions remain statically typed.

## 2.4 Keep large data outside MentalState and TurnTrace

Continue using references and artifacts rather than embedding large results.

## 2.5 Make advanced behavior observable

If memory retrieval, graph repair, or candidate selection affects behavior, the framework should make it possible to trace that behavior without requiring every agent to fork the core tracing implementation.

---

# 3. P0: Typed Plan and PlanStep Extensibility

## Problem

Different planning systems need additional step-level and plan-level state, but adding all possible fields to the core `PlanStep` would make the framework increasingly domain-specific.

Agents currently have to either overload `args`, store parallel state elsewhere, or use untyped nested structures.

## Proposal

Make `PlanStep` and `Plan` generic over extension metadata.

For example:

```ts
export type PlanStep<
  StepMeta = unknown
> = {
  id: string;
  goalId?: GoalId;
  title: string;
  kind: StepKind;

  args?: Record<string, unknown>;

  dependsOn?: string[];

  status: StepStatus;

  meta?: StepMeta;
};

export type Plan<
  StepMeta = unknown,
  PlanMeta = unknown
> = {
  id: PlanId;
  goalId?: GoalId;
  status: PlanStatus;

  steps: PlanStep<StepMeta>[];

  cursor: number;
  revision: number;

  meta?: PlanMeta;

  createdAt: string;
  updatedAt: string;
};
```

Existing users should remain source-compatible.

## Example use cases

ATG-style planning:

```ts
type GraphStepMeta = {
  inputSchemaRef?: string;
  outputSchemaRef?: string;

  parentNodeId?: string;
  refinementId?: string;

  tool?: string;
  idempotent?: boolean;
};
```

Other use cases:

- cost estimates;
- SLA metadata;
- approval requirements;
- scheduling information;
- planner confidence;
- domain-specific identifiers;
- UI rendering hints;
- human review state.

## Acceptance criteria

- `Plan` and `PlanStep` support typed custom metadata.
- Existing plans require no migration or only a trivial generic default.
- Metadata is preserved through plan serialization, snapshots, and Learning writes.

---

# 4. P0: Formalize Dependency-Aware Plan Semantics

## Problem

`dependsOn` exists, but its runtime semantics are currently underspecified.

The presence of `cursor` also makes the planning model appear primarily sequential, even though dependencies allow DAG-style execution.

## Proposal

Make dependency semantics part of the public planning contract.

At minimum:

- every referenced dependency must exist;
- a step must not depend on itself;
- dependency cycles must be rejected for DAG-mode plans;
- the framework should be able to derive ready and blocked steps deterministically.

Introduce a scheduling mode:

```ts
type PlanScheduling =
  | { mode: 'sequential' }
  | { mode: 'dependencies' };
```

Then:

```ts
type Plan<...> = {
  ...
  scheduling?: PlanScheduling;
  cursor?: number;
};
```

For `sequential`, current cursor semantics remain.

For `dependencies`, readiness is derived from dependency and status state rather than only from `cursor`.

## Proposed helpers

```ts
validatePlanGraph(plan)

selectReadyPlanSteps(plan)

selectBlockedPlanSteps(plan)

getPlanDependants(plan, stepId)

getPlanAncestors(plan, stepId)

getPlanDescendants(plan, stepId)
```

Optionally:

```ts
selectRunnablePlanSteps(plan, {
  requireValidatedDependencies: true,
});
```

## Why this helps beyond our use case

This benefits:

- parallel tool workflows;
- child-agent fan-out/fan-in;
- build-like dependency graphs;
- approval workflows;
- research pipelines;
- recovery planning;
- multi-branch agents.

## Acceptance criteria

`validatePlanGraph()` should detect at least:

```text
missing dependency
self dependency
dependency cycle
```

with structured error codes rather than arbitrary strings.

---

# 5. P0: Distinguish Execution Status from Validation Status

## Problem

For agentic workflows:

```text
step completed
```

does not necessarily mean:

```text
step result can safely be used downstream
```

APLRET already enforces validation of structured LLM, tool, and child results before authoritative cognitive writes. The planning model should be able to represent this distinction as well. fileciteturn1file0

## Proposal

Add optional validation state to plan steps.

For example:

```ts
export type ValidationStatus =
  | 'unknown'
  | 'pending'
  | 'valid'
  | 'invalid';

export type ValidationState = {
  status: ValidationStatus;
  refs?: string[];
};
```

Then:

```ts
type PlanStep<Meta = unknown> = {
  ...
  status: StepStatus;
  validation?: ValidationState;
  meta?: Meta;
};
```

A dependency-aware selector could then optionally require dependencies to be both:

```text
status = done
AND
validation.status = valid
```

before a downstream step becomes runnable.

## Acceptance criteria

- Validation is optional for simple agents.
- Validation state can be traced and snapshotted.
- Framework helpers can distinguish completed and validated dependencies.

---

# 6. P0: Output, Evidence, and Artifact References on Plan Steps

## Problem

Advanced plans need lineage between:

```text
step
→ result
→ evidence
→ downstream dependency
```

but large results should not be stored directly in `MentalState`.

## Proposal

Add typed lightweight output references.

For example:

```ts
export type PlanOutputRef = {
  name?: string;

  kind:
    | 'artifact'
    | 'memory'
    | 'evidence'
    | 'value';

  ref: string;
};
```

Then:

```ts
type PlanStep<Meta = unknown> = {
  ...
  outputs?: PlanOutputRef[];
};
```

Alternatively, if separation is preferred:

```ts
resultRefs?: string[];
evidenceRefs?: string[];
artifactRefs?: string[];
```

A unified `outputs` representation is likely more extensible.

## Important constraint

These should be **references**, not a mechanism for storing arbitrary large payloads in plans.

This is aligned with the existing APLRET artifact model. fileciteturn1file0

## Benefits

- provenance;
- auditability;
- selective invalidation;
- graph repair;
- visual execution graphs;
- reproducibility;
- explanation of downstream decisions.

---

# 7. P0: Plan Revision Lineage

## Problem

`revision: number` indicates that a plan changed, but does not explain:

- what revision it came from;
- why it changed;
- what observation or failure triggered it.

This becomes important for repair loops.

## Proposal

Add optional revision lineage.

For example:

```ts
export type PlanRevisionLineage = {
  parentRevision?: number;

  cause?: {
    kind:
      | 'initial'
      | 'observation'
      | 'failure'
      | 'user_change'
      | 'optimization'
      | 'manual';

    ref?: string;
  };

  evidenceRefs?: string[];
};
```

And:

```ts
type Plan = {
  ...
  revision: number;
  lineage?: PlanRevisionLineage;
};
```

## Benefits

- debugging;
- audit;
- repair attribution;
- visual diff;
- replay;
- plan evaluation;
- operator UI.

## Acceptance criteria

The framework should continue enforcing monotonic revisions and additionally allow lineage to identify the preceding revision.

---

# 8. P0: Typed MentalState Extension Space

## Problem

`MentalState` is intentionally extensible, but advanced agents currently risk putting custom cognition into generic structures such as:

```ts
worldModel: Record<string, unknown>
```

This reduces type safety.

## Proposal

Introduce an explicit generic cognition extension parameter.

For example:

```ts
export type MentalState<
  Sensory = unknown,
  Extensions extends Record<string, unknown> = {}
> = {
  memory: ...;

  worldModel?: Record<string, unknown>;

  goalState: ...;

  plans?: ...;

  reward?: Record<string, unknown>;
  policyParams?: Record<string, unknown>;

  extensions?: Extensions;
};
```

An advanced agent could then define:

```ts
type MyCognition = {
  planningGraph: MyGraphState;
  inferenceState: MyInferenceState;
};

type MyMentalState =
  MentalState<MySensory, MyCognition>;
```

## Why this is preferable

It lets CallAgent remain neutral about:

- probabilistic beliefs;
- planning algorithm;
- domain model;
- reasoning engine;

while still providing a clearly supported place for authoritative custom cognition.

---

# 9. P0: Extensible TurnTrace

## Problem

TurnTrace is already an excellent runtime source of truth, but advanced agents need custom observability that should not require adding domain-specific fields to the core schema. fileciteturn1file0

Examples include:

- planner candidates;
- retrieval decisions;
- evaluator state;
- custom scoring;
- graph revisions;
- belief/posterior summaries;
- compliance decisions.

## Proposal

Add versioned, namespaced TurnTrace extensions.

For example:

```ts
export type TurnTraceExtension = {
  namespace: string;
  version: string;
  data: JsonValue;
};
```

Then:

```ts
type TurnTrace = {
  ...
  extensions?: TurnTraceExtension[];
};
```

Example:

```json
{
  "namespace": "planning.graph",
  "version": "1",
  "data": {
    "planId": "plan-12",
    "revision": 4,
    "readySteps": ["step-b", "step-c"]
  }
}
```

Another agent might use:

```json
{
  "namespace": "retrieval.rag",
  "version": "1",
  "data": {
    "queryId": "q17",
    "documentsReturned": 8
  }
}
```

## Requirements

- core TurnTrace remains stable;
- extension payloads must be JSON serializable;
- namespace ownership should be explicit;
- trace extensions must be versioned;
- extensions must not become an alternative cognitive store.

---

# 10. P0/P1: Trace References to External Sidecar Artifacts

## Problem

Detailed custom traces can be too large for the primary TurnTrace.

## Proposal

Allow TurnTrace to link to external trace or artifact records.

For example:

```ts
export type TraceRef = {
  kind: string;
  id: string;
};
```

Then:

```ts
type TurnTrace = {
  ...
  related?: TraceRef[];
};
```

Examples:

```text
belief_snapshot
plan_revision
graph_patch
memory_retrieval
evaluation_record
```

This creates a clean pattern:

```text
TurnTrace
= compact runtime truth

Sidecar artifact
= detailed agent-specific trace

TurnTrace.related
= correlation
```

---

# 11. P0: Memory Read Telemetry

## Problem

APLRET strongly controls memory writes, but debugging sophisticated agents also requires knowing what durable information was **read** before a decision.

This matters for:

- RAG;
- procedural memory;
- prior task experience;
- stale-memory problems;
- latency analysis;
- explainability.

## Proposal

Instrument `MemoryReader` operations.

A minimal trace could be:

```ts
export type MemoryReadTrace = {
  operation: string;

  queryType?: string;

  returnedIds?: string[];

  durationMs?: number;
};
```

This could either become:

```ts
TurnTrace.memoryReads?: MemoryReadTrace[];
```

or use the generic extension mechanism.

The latter may preserve a cleaner core TurnTrace.

## Privacy and payload rule

Do not store retrieved content by default.

Record:

- IDs;
- counts;
- query type;
- latency;
- optionally relevance metadata.

Detailed content can remain in durable memory and be linked by reference.

---

# 12. P0: Normative Rule — Memory Retrieval Is Not a New Observation

We recommend adding a framework-level contract clarification.

### Proposed rule

> Reading durable memory does not itself constitute a new environment Observation.

Historical memory may affect cognition through Learning, but simply retrieving an existing fact or episode must not create duplicate evidence in `env.inbox.current`.

If historical memory affects cognition, Learning should treat it as:

- prior context;
- previously observed evidence;
- parameter state;
- procedural knowledge;

depending on the agent model.

This distinction is useful far beyond probabilistic agents.

It prevents patterns such as:

```text
tool failure observed once
→ saved to memory
→ retrieved five times
→ accidentally treated as six independent observations
```

The existing APLRET separation makes this rule natural because:

```text
env.inbox.current = new runtime observations
MemoryReader       = durable historical cognition
```

---

# 13. P1: Snapshot Fork and Replay Support in the Test Harness

## Problem

APLRET already emphasizes deterministic turns, resume, snapshots, and replayability. A natural extension is the ability to fork one exact state into multiple test branches. fileciteturn1file0

## Proposal

Expose a supported test API similar to:

```ts
const snapshot = harness.snapshot();

const branchA = harness.fork(snapshot);
const branchB = harness.fork(snapshot);
```

or:

```ts
const branchA = createTestHarness({
  fromSnapshot: snapshot,
});
```

All relevant state must be reproduced:

- MentalState;
- control state;
- pending state;
- current graph/plan;
- manifest provenance;
- deterministic clock state;
- RNG seed where applicable.

## Use cases

- compare alternative repair policies;
- test new planner version against old planner;
- reproduce failures;
- A/B agent policy testing;
- regression analysis;
- branch from a failure point;
- counterfactual evaluation.

For example:

```text
same exact snapshot
├── retry policy
├── inspect-first policy
└── replan policy
```

This is extremely useful for framework development independently of our research use case.

---

# 14. P1: Deterministic Randomness and Clock Support

For fully reproducible replay, the test harness should support controlled:

- clock;
- RNG seed;
- optional ID/token generators.

Suggested capabilities:

```ts
createTestHarness({
  clock,
  randomSeed,
});
```

or injectable providers.

This is especially important when:

- policies sample from distributions;
- retries use jitter;
- plans contain stochastic decisions;
- environments are simulated.

---

# 15. P1: Generic Decision Trace

## Problem

TurnTrace records the selected `Intent`, but some agents need to explain why it was chosen among alternatives.

## Proposal

Add an optional generic decision telemetry structure, possibly implemented through TurnTrace extensions.

For example:

```ts
export type DecisionTrace = {
  selectedId: string;

  candidates?: Array<{
    id: string;
    score?: number;
    reasonCode?: string;
  }>;
};
```

This is intentionally neutral.

It could represent:

- planner candidate plans;
- route selection;
- ranked tools;
- probabilistic policies;
- model selection;
- fallback choice.

It should remain telemetry only, not authoritative cognition.

---

# 16. P1: Structured PlanPatch API

Once dependency-aware plans are stable, we recommend introducing a generic repair representation.

For example:

```ts
export type PlanPatch<Step = PlanStep> = {
  baseRevision: number;

  operations: Array<
    | {
        op: 'add_step';
        step: Step;
      }
    | {
        op: 'remove_step';
        stepId: string;
      }
    | {
        op: 'update_step';
        stepId: string;
        patch: Partial<Step>;
      }
    | {
        op: 'add_dependency';
        stepId: string;
        dependsOn: string;
      }
    | {
        op: 'remove_dependency';
        stepId: string;
        dependsOn: string;
      }
  >;
};
```

Framework helpers:

```ts
validatePlanPatch(plan, patch)

applyPlanPatch(plan, patch)

diffPlanRevisions(before, after)
```

## Important ownership rule

Applying an authoritative plan patch is still a **Learning-owned cognition update**.

If an LLM or tool generates the patch:

```text
Policy
→ repair intent
→ Execution generates candidate patch
→ Transition emits observation
→ Perception validates
→ Learning applies patch
```

This preserves APLRET’s existing planning contract. fileciteturn1file0

---

# 17. P1: Plan Graph Diff Helpers

If PlanPatch exists, add generic diff utilities:

```ts
diffPlanGraph(before, after)
```

Possible output:

```ts
{
  addedSteps: string[];
  removedSteps: string[];
  changedSteps: string[];
  addedDependencies: ...;
  removedDependencies: ...;
}
```

Useful for:

- operator UI;
- debugging;
- repair audit;
- testing;
- graph-change metrics.

---

# 18. Optional: Concurrency Metadata

We do not recommend adding ATG-specific parallel execution semantics to the core Plan API yet.

Typed metadata should be sufficient for agents to express:

```ts
type SchedulingMeta = {
  parallelizable?: boolean;
  concurrencyGroup?: string;
  idempotent?: boolean;
};
```

If several agents start using similar semantics, these fields can later be promoted into the public planning contract.

---

# 19. Explicit Non-Goals

We specifically recommend **not** adding the following to CallAgent core:

- `AtomicTaskGraph` as a mandatory framework abstraction;
- active-inference modules;
- posterior/probability types in core `MentalState`;
- expected-free-energy fields;
- node/subgraph/task/domain belief hierarchy;
- negative-transfer concepts;
- research-specific evaluation state;
- automatic graph mutation from Policy;
- direct memory access from Policy;
- a second cognitive state outside `MentalState`.

Agents should implement these using the generic extension points above.

---

# 20. Suggested Final Generic Plan Shape

A possible end-state for the generic plan API could be:

```ts
export type ValidationState = {
  status:
    | 'unknown'
    | 'pending'
    | 'valid'
    | 'invalid';

  refs?: string[];
};

export type PlanOutputRef = {
  name?: string;

  kind:
    | 'artifact'
    | 'memory'
    | 'evidence'
    | 'value';

  ref: string;
};

export type PlanStep<
  Meta = unknown
> = {
  id: string;
  goalId?: GoalId;

  title: string;
  kind: StepKind;

  args?: Record<string, unknown>;

  dependsOn?: string[];

  status: StepStatus;

  validation?: ValidationState;

  outputs?: PlanOutputRef[];

  meta?: Meta;
};

export type PlanScheduling =
  | {
      mode: 'sequential';
    }
  | {
      mode: 'dependencies';
    };

export type PlanRevisionLineage = {
  parentRevision?: number;

  cause?: {
    kind:
      | 'initial'
      | 'observation'
      | 'failure'
      | 'user_change'
      | 'optimization'
      | 'manual';

    ref?: string;
  };

  evidenceRefs?: string[];
};

export type Plan<
  StepMeta = unknown,
  PlanMeta = unknown
> = {
  id: PlanId;
  goalId?: GoalId;

  status: PlanStatus;

  steps: PlanStep<StepMeta>[];

  scheduling?: PlanScheduling;

  cursor?: number;

  revision: number;
  lineage?: PlanRevisionLineage;

  meta?: PlanMeta;

  createdAt: string;
  updatedAt: string;
};
```

An ATG implementation could then remain entirely outside the framework:

```ts
type ATGStepMeta = {
  interface?: {
    inputSchemaRef?: string;
    outputSchemaRef?: string;
  };

  refinement?: {
    parentNodeId?: string;
    decompositionId?: string;
  };

  execution?: {
    tool?: string;
    idempotent?: boolean;
  };
};

type ATGPlanMeta = {
  graphKind: 'atomic-task-graph';
  rootGoalId?: string;
  refinementHistoryRefs?: string[];
};

type ATGPlan =
  Plan<ATGStepMeta, ATGPlanMeta>;
```

This is the boundary we recommend:

> CallAgent supports dependency-aware, validated, revisioned and observable plans. Individual agents decide whether those plans represent an Atomic Task Graph, workflow graph, human approval flow, or another planning model.

---

# 21. Priority Recommendation

## P0 — Recommended before advanced planning/research work

1. Typed `Plan` / `PlanStep` metadata.
2. Formal dependency semantics.
3. `validatePlanGraph()`.
4. Ready/blocked/dependant selectors.
5. Step validation state.
6. Output/evidence/artifact references.
7. Plan revision lineage.
8. Typed `MentalState.extensions`.
9. Namespaced TurnTrace extensions and external trace refs.
10. Memory-read telemetry.
11. Normative rule distinguishing durable memory retrieval from new observations.

These are all broadly useful framework capabilities.

## P1 — Recommended for advanced testing and recovery

1. Snapshot fork/replay API.
2. Controlled RNG/clock support.
3. Generic DecisionTrace.
4. `PlanPatch`.
5. Plan graph diff helpers.

---

# 22. Testing Requirements

The changes should extend the existing turn-script testing model. fileciteturn1file0

Add tests for:

### Dependency plans

- missing dependency rejected;
- self-dependency rejected;
- cycle rejected;
- ready set correct;
- blocked set correct;
- multiple independent steps can be ready simultaneously.

### Validation

- completed-but-unvalidated dependency does not become runnable when validation is required;
- invalid dependency blocks downstream step;
- validation refs survive snapshot/resume.

### Revision lineage

- revision remains monotonic;
- parent revision is preserved;
- lineage survives serialization.

### Trace extensions

- namespaced extension survives trace serialization;
- invalid JSON payload rejected;
- large external detail is referenced rather than embedded.

### Memory telemetry

- durable memory reads are visible;
- read telemetry does not create inbox observations;
- retrieved payload content is not logged by default.

### Snapshot fork

- both forks begin from identical authoritative cognition and control state;
- actions in one fork cannot affect the other;
- same seed and policy produce the same deterministic trace where dependencies are deterministic.

---

# 23. Expected Outcome

After these improvements, APLRET should support a wider class of sophisticated agents without becoming coupled to any specific reasoning algorithm.

The framework-level abstraction would become:

```text
explicit observations
→ authoritative cognition
→ dependency-aware plans
→ pure decisions
→ guarded effects
→ traceable outcomes
→ controlled revision and replay
```

This retains APLRET’s existing discipline while adding the primitives required for:

- graph-based planning;
- localized repair;
- parallel-ready work;
- evidence-backed outputs;
- cross-run learning;
- rich observability;
- counterfactual testing.

The core design principle should remain:

> Add generic capabilities for dependency-aware planning, provenance, observability, and experimentation — not framework-specific implementations of a particular planning or inference theory.