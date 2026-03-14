# APLRET Framework Improvements

**Purpose:** platform-level improvements that make APLRET agents easier to create, understand, debug, test, and evolve.

This document is about framework responsibilities. It does not restate the runtime contract. It describes what the framework should provide, encourage, or standardize so that agent repositories work well for both humans and AI.

APLRET should be designed to make **vibe coding work for real agent repositories**: fast for AI to generate, but structured enough for humans and AI to understand, debug, test, and evolve.

The goal is not to reduce AI-assisted speed. The goal is to keep that speed useful after the first draft, when the agent must still be inspected, repaired, extended, and trusted.

---

## 1. Core stance

APLRET already provides strong runtime discipline:

- explicit turn boundaries
- explicit cognition ownership
- explicit effect boundaries
- explicit control outcomes
- explicit observability

That is a strong base.

What the framework must improve now is **behavioral legibility** and **AI-coding ergonomics**.

The hardest part of working with turn-based agents is often not understanding what each module is supposed to do. It is understanding:

- what the agent does first
- what happens next
- what happens after an await
- what causes completion
- what causes failure
- how the full algorithm unfolds across turns

So the framework should optimize for two things:

1. **local clarity** — each module is easy to read and edit
2. **flow clarity** — the full behavior over time is easy to inspect and reconstruct

Both matter for humans.  
Both matter even more for AI coding.

---

## 2. AI-coding stance

APLRET should explicitly support vibe coding for real repositories.

That means the framework should help AI systems:

- generate agents quickly
- discover repository structure quickly
- understand behavior without scanning too much code
- localize bugs without broad speculative edits
- write tests from explicit flow and contracts
- evolve agents without silently breaking existing behavior

In practice, that means the framework should prefer:

- small stable vocabularies
- explicit behavioral artifacts
- predictable file structure
- reusable helpers for common runtime shapes
- examples that teach one canonical style
- tools that make branch and flow behavior visible

This is not structure for its own sake.  
It is structure that keeps vibe coding effective as the repository grows.

---

## 3. What the framework should optimize for

APLRET should make it easy for a human or LLM to answer these questions quickly:

- what observations may arrive
- what cognition may be written
- what decisions may be emitted
- what effects may occur
- what turn outcomes may follow
- what the main flow is over time
- where to go when something breaks

The framework should minimize the need to reverse-engineer these answers from:

- transport wrappers
- large callback objects
- scattered string literals
- deeply nested ad hoc conditionals
- undocumented multi-turn behavior

---

## 4. Make `flow.md` a first-class artifact

This is the most important improvement.

APLRET agents are procedurally distributed by design. Behavior is spread across:

- Perception
- Learning
- Policy
- Execution
- Transition
- later resumed turns

That is excellent for runtime correctness.  
It is worse for quick procedural understanding.

### Framework improvement

For non-trivial agents, APLRET should standardize `flow.md` as the canonical behavior map.

A non-trivial agent is any agent that uses one or more of:

- `await_input`
- `await_tool`
- `await_child`
- multiple major branches
- planning or repair loops
- structured LLM output that influences future decisions
- non-trivial failure paths

### What `flow.md` gives the ecosystem

`flow.md` makes the full behavior visible without forcing the reader to reconstruct it from source each time.

It should explain:

- the main success path
- major branches
- await/resume behavior
- terminal outcomes
- important turn semantics
- code map for major behavior

### Why this matters for AI coding

Without `flow.md`, an AI often has to rediscover the algorithm by reading several files and inferring hidden connections.

With `flow.md`, the agent gets a compact procedural map first, and code second.

This lowers:

- cognitive load
- token usage for understanding non-trivial behavior
- number of repair iterations
- risk of local edits that violate the real flow

### Framework action

APLRET should:

- document a canonical `flow.md` format
- include `flow.md` in agent templates for non-trivial agents
- recommend updating `flow.md` in the same PR as behavior changes
- teach examples that include `flow.md`

---

## 5. Provide a canonical file and folder structure

The framework should define a recommended layout that maps directly to APLRET concerns.

### Minimal layout for simple agents

```txt
my-agent/
  agent.ts
  types.ts
  perception.ts
  learning.ts
  policy.ts
  execution.ts
  transition.ts
  prompts.ts
  contracts.ts
```

### Recommended layout for non-trivial agents

```txt
my-agent/
  agent.ts
  flow.md
  types.ts

  attention.ts
  perception.ts
  learning.ts
  policy.ts
  shield.ts
  execution.ts
  transition.ts

  selectors.ts
  reducers.ts
  builders.ts

  normalizers/
    user.ts
    tool.ts
    child.ts
    internal.ts

  effects/
    llm/
      answerWithLlm.ts
      createPlan.ts
      repairPlan.ts
    tools/
      fetchPage.ts
      search.ts
      validateUrl.ts

  prompts/
    answerWithLlm.ts
    createPlan.ts
    repairPlan.ts

  contracts/
    llm/
      createPlan.schema.ts
      repairPlan.schema.ts
    tools/
      fetchPage.schema.ts
      search.schema.ts

  tests/
    golden.test.ts
    resume.test.ts
    failure.test.ts
    invariant.test.ts
```

### Framework rule

The framework should make it clear that structure should grow with complexity, not with aesthetics.

The goal is:

- lower cognitive load
- better discoverability
- easier localization of changes
- smaller high-signal context windows for LLMs

Not maximal folder count.

---

## 6. Standardize closed behavioral vocabularies

The framework should strongly encourage closed discriminated unions for agent-facing behavior.

This applies to:

- normalized observations
- intents
- execution result payloads
- stages
- terminal outcome categories

### Why this matters

Closed vocabularies improve:

- readability
- exhaustiveness
- reviewability
- testability
- LLM navigation
- edit safety

### Framework guidance

Avoid agent patterns like:

```ts
type Obs = {
  source: string;
  kind: string;
  payload: any;
};
```

Prefer agent patterns like:

```ts
type Obs =
  | { source: 'user'; kind: 'context.provided'; payload: { fetchContext: FetchTaskContext } }
  | { source: 'user'; kind: 'validation.failed'; payload: { message: string } }
  | { source: 'child'; kind: 'html.fetched'; payload: { html: string; targetUrl?: string } }
  | { source: 'child'; kind: 'child.failed'; payload: { message: string } };
```

### Framework action

Examples, templates, and docs should consistently use closed unions.

The framework should make stringly typed agent vocabularies an explicit anti-pattern.

---

## 7. Encourage domain-named intents

The framework should encourage agent-facing intent unions that express domain meaning directly.

### Prefer

```ts
type AgentIntent =
  | { kind: 'wait_for_context' }
  | { kind: 'start_fetch'; fetchContext: FetchTaskContext }
  | { kind: 'complete_success'; html: string; targetUrl: string }
  | { kind: 'fail'; message: string };
```

### Avoid

```ts
{ kind: 'internal', intent: 'start_fetch', data: ... }
```

### Why this matters

Domain-named intents:

- make Policy easier to scan
- make Execution easier to route
- make `flow.md` easier to write
- improve LLM understanding because meaning is visible in one field

### Framework action

Templates and examples should use direct domain intent names.

---

## 8. Standardize selector and reducer patterns

APLRET already has the right ownership boundaries. The framework should make the read/write pattern explicit.

### Selectors

Selectors should be the canonical way to expose decision-ready views to Policy.

### Reducers

Reducers should be the canonical way to apply normalized observations into cognition.

### Why this matters

This prevents two common readability failures:

- Policy doing scattered deep reads into raw nested memory
- Learning becoming a long imperative mutation block

### Framework action

The framework should recommend:

- `selectors.ts` for decision-ready views
- `reducers.ts` for cognition write logic

Docs and examples should teach this consistently.

---

## 9. Standardize normalizer patterns

Perception becomes hard to read when source routing, wrapper decoding, validation, and business interpretation all sit inline in one function.

### Framework improvement

APLRET should recommend a canonical Perception structure:

- one inbox dispatcher
- one source-specific normalizer per source family
- small helpers for transport quirks

### Example shape

- `normalizers/user.ts`
- `normalizers/tool.ts`
- `normalizers/child.ts`
- `normalizers/internal.ts`

### Why this matters

This keeps transport complexity at the edge and prevents it from leaking into:

- Learning
- Policy
- Transition
- tests
- `flow.md`

---

## 10. Provide execution-side integration structure

The framework should standardize where execution-side integration concerns live.

### Recommended locations

| Concern | Recommended location | Why |
|---|---|---|
| Prompt text or prompt builders | `prompts/` | Wording stays discoverable and separate from execution mechanics. |
| Actual LLM invocation | `effects/llm/` | The effect boundary remains explicit and testable. |
| LLM structured output schemas | `contracts/llm/` | Output contracts stay visible and reusable. |
| Actual tool invocation | `effects/tools/` | Tool plumbing stays out of Policy and Learning. |
| Tool arg/result schemas | `contracts/tools/` | Validation stays discoverable. |
| Child-agent dispatch | execution-side code | Use the separate runtime path directly; no required `effects/children/`. |

### Why this matters

This gives AI systems a stable answer to:

- where to change wording
- where to change execution logic
- where to change structured contracts
- where to debug tool behavior

That lowers navigation cost and reduces accidental cross-layer edits.

---

## 11. Provide framework helpers that reduce boilerplate

The framework should provide helpers for repetitive runtime shapes so agent code becomes more declarative.

### Candidate helper areas

- observation builders
- exec result builders
- turn outcome builders
- stage helpers
- invariant helpers

### Example direction

```ts
const obs = createObservationBuilders<Obs>();
const exec = createExecBuilders<ExecData, ExecError>();
const turn = createTurnOutcomeBuilders();
```

### Why this matters

This reduces:

- object-literal noise
- repeated shape construction
- inconsistent naming
- visual clutter in examples and agent files

That improves both human readability and LLM generation consistency.

---

## 12. Strengthen examples as training data

Examples are not just documentation. They are effective training data for humans and AI.

### Framework improvement

Reference examples should always use the canonical readable style:

- small `agent.ts`
- closed unions
- selector/reducer split
- extracted normalizers
- named effect handlers
- explicit transitions
- `flow.md` for non-trivial agents

### Why this matters

If examples are inline, noisy, or stringly typed, the ecosystem will copy that style.

Templates and examples should teach the intended style by default.

---

## 13. Add explicit debugging ergonomics guidance

The framework should document how readable structure supports debugging.

### Debugging goal

A human or LLM should be able to tell quickly whether a bug belongs to:

- normalization
- cognition update
- decision logic
- execution effect
- transition / await-resume behavior

### Recommended mapping

- raw payload or schema issue -> `normalizers/`
- wrong remembered fact -> `reducers.ts` / Learning
- wrong next action -> `selectors.ts` / `policy.ts`
- bad external behavior -> `effects/`
- wrong wait/resume or terminal outcome -> `transition.ts` and `flow.md`

### Framework action

This mapping should appear in docs and examples.

The framework should not treat debugging as separate from readability. They are the same design problem viewed later in time.

---

## 14. Make testability flow-aware

APLRET already supports strong turn-script testing. The framework should connect tests to flow artifacts more explicitly.

### Framework improvement

When `flow.md` exists, its major paths should map naturally to tests.

At minimum, framework examples and guidance should encourage tests for:

- the dominant success path
- each await/resume path
- each major failure branch
- each repair/retry branch that changes behavior materially

### Strong recommendation

Use stable branch IDs in `flow.md` for non-trivial agents.

Example:

- `B1: Validation failure`
- `B2: Child failure`
- `B3: Successful child completion`

This makes it easier to align:

- docs
- tests
- bug reports
- AI-generated repair plans

---

## 15. Add a dedicated section: why this structure helps AI coding

The framework documentation should explicitly explain why this structure exists.

### Suggested message

This structure helps AI coding because it makes the repository answer these questions with minimal context:

- what can come in
- what can be remembered
- what decisions exist
- what effects happen
- what outcomes follow
- what the flow is over time

### Practical benefits

- smaller search space
- lower context cost
- fewer speculative edits
- easier diff review
- easier test generation
- easier repair after failure
- better long-term maintainability

This section matters because it turns “architecture preference” into “operational leverage.”

---

## 16. Review checklist for framework and example quality

Use this checklist when reviewing framework examples, templates, or helper APIs:

1. Does the example make the supported observations, intents, execution outputs, and stages easy to find?
2. Is `agent.ts` mostly wiring?
3. Are transport quirks isolated to normalizers and effect handlers?
4. Does Policy read from selectors rather than scattered deep memory access?
5. Does Learning write compact, validated cognition through reducers?
6. Are LLM prompts and schemas in discoverable locations?
7. Are execution result paths typed and explicitly handled by Transition?
8. Is `flow.md` present for a non-trivial example?
9. Does `flow.md` explain the main success path, await/resume path, and main failure path?
10. Could a new contributor or LLM explain the main flow in under 30 seconds after opening the type files and `flow.md`?

---

## 17. Bottom line

APLRET already has the right runtime instincts.

The next step is to make those instincts visible and easy to work with at repository scale.

The framework should do that by standardizing:

- closed vocabularies
- predictable file structure
- selector-driven Policy
- reducer-driven Learning
- source-specific normalizers
- named effect handlers
- explicit transitions
- `flow.md` for behavior over time
- examples and helpers that teach the canonical style

That is what will make vibe coding durable for real agent repositories.
