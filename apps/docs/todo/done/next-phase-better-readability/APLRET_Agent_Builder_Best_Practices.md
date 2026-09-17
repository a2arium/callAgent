# Best Practices for APLRET Agent Builders

**Purpose:** practical conventions for teams building agents on top of APLRET.

This document is about builder discipline. It does not replace the runtime contract. It shows how to express that contract in source code so the result is easy to read, safe to evolve, and predictable for both humans and LLMs.

APLRET is designed to make **vibe coding work for real agent repositories**: fast for AI to generate, but structured enough for humans and AI to understand, debug, test, and evolve.

The goal is not to reduce AI-assisted speed. The goal is to keep that speed useful after the first draft, when the agent must still be inspected, repaired, extended, and trusted.

---

## 1. Core stance

Write agents so the architecture and behavior are visible from the source tree.

A strong agent should be understandable from:

- its types
- its normalized observation vocabulary
- its selectors
- its reducers
- its effect handlers
- its transition mapping
- its `flow.md`

A reviewer should not have to reverse-engineer intent from transport wrappers, deeply nested ad hoc conditionals, or distributed turn logic spread across unrelated files.

For non-trivial agents, the repository should answer two questions quickly:

1. **What pieces exist?**
2. **What does this agent do over time?**

The first question is answered by code structure.  
The second is answered by `flow.md`.

---

## 2. AI-coding stance

APLRET is designed to support vibe coding for real agent repositories.

The goal is to keep AI-assisted agent creation fast, while making the resulting agents easier to understand, debug, test, and evolve.

In practice, that means:

- behavior is made visible through small stable vocabularies
- flow is documented explicitly for non-trivial agents
- prompts, contracts, normalizers, reducers, and effects have clear homes
- changes stay localized and reviewable
- test cases can be derived from explicit branches and turn outcomes

This is not structure for its own sake.  
It is structure that keeps vibe coding effective as the repository grows.

---

## 3. Golden rules

- Keep `agent.ts` declarative. It should wire modules together, not contain most of the logic.
- Define the domain vocabulary first: `Sensory`, `Obs`, `AgentIntent`, `ExecData`, `ExecError`, `Stage`.
- Normalize transport details early in Perception and keep the rest of the agent transport-agnostic.
- Keep Policy selector-driven and small.
- Keep Learning reducer-like and explicit.
- Split Execution into named effect handlers.
- Keep Transition table-like and exhaustive.
- For non-trivial agents, keep a `flow.md` file as the canonical behavior map.
- Keep behavior changes localized and easy to map across code, flow, and tests.

---

## 4. Why this structure helps AI coding

This structure is optimized for AI-assisted development.

It helps because it makes the repository answer these questions quickly:

- what can come in
- what can be remembered
- what decisions exist
- what effects can happen
- what control outcomes can follow
- what the main flow is over time

This reduces the amount of code and context an AI must scan before making a safe change.

### Practical benefits for AI coding

- **Closed unions reduce search space.** The model sees the valid vocabulary instead of guessing.
- **`flow.md` reduces flow reconstruction cost.** The model does not need to rebuild the turn logic from several files every time.
- **`selectors.ts` reduces raw nested state traversal.** Policy inputs become compact and stable.
- **`reducers.ts` localizes cognition writes.** Learning logic becomes easier to patch safely.
- **`contracts/` reduces guessing.** Structured outputs and tool results are easier to validate and reuse.
- **`prompts/` makes wording discoverable.** Prompt changes do not require scanning execution code.
- **`normalizers/` isolate transport quirks.** Raw wrappers and payload oddities do not leak into the whole agent.
- **Explicit tests and flow branches reduce iteration cost.** The model can map behavior to checks instead of making large speculative edits.

The result is not just better code style.  
It is lower cognitive load for both humans and LLMs.

---

## 5. Canonical file layout

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

Use this when there are few effect paths, very little normalization complexity, and no difficult multi-turn behavior.

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

### Notes

- Keep `agent.ts` small.
- Keep `flow.md` close to `agent.ts`. It is the primary behavior map for the agent.
- Do not create `effects/children/` unless your codebase truly benefits from it. Child-agent dispatch can stay in execution-side code because it is its own runtime call path.
- Expand structure only when complexity justifies it. Do not fragment a tiny agent for the sake of symmetry.

### Split by responsibility, not by symmetry

Do not create files just to satisfy a pattern.

Split when:

- a file mixes multiple responsibilities
- a reader can no longer explain the main flow quickly
- transport quirks start leaking into cognition or policy
- execution paths stop being easy to scan

Do not split when the result only adds navigation overhead.

The goal is lower cognitive load, not maximal folder count.

---

## 6. `flow.md` for non-trivial agents

For non-trivial agents, `flow.md` should be treated as a first-class artifact.

Its purpose is to answer:

> What does this agent do over time?

`flow.md` is especially useful when the agent uses:

- `await_input`
- `await_tool`
- `await_child`
- multiple major branches
- planning or repair loops
- structured LLM outputs
- non-trivial failure paths

### What `flow.md` should contain

A good `flow.md` should explain:

- the main success path
- major branches
- await/resume behavior
- terminal outcomes
- turn semantics that matter for this agent
- the code map for major behavior

### Why `flow.md` matters for vibe coding

Turn-based agents spread behavior across:

- Perception
- Learning
- Policy
- Execution
- Transition
- later resumed turns

That is good for runtime discipline, but harder to read procedurally.

`flow.md` solves that by giving humans and LLMs a compact behavior map without forcing them to reconstruct the full algorithm from source every time.

### Maintenance rule

If behavior changes materially, `flow.md` should change in the same PR.

Examples of behavior changes that require `flow.md` updates:

- new intent kinds
- new major branches
- new terminal outcomes
- changed await/resume behavior
- changed stage vocabulary
- repair/retry logic that changes the control flow

---

## 7. Where prompts, LLM calls, and tool calls should live

| Concern | Recommended location | Why |
|---|---|---|
| Prompt text or prompt builders | `prompts/` | Keep wording discoverable and keep execution files procedural. |
| Actual LLM invocation | `effects/llm/` | The effect boundary stays explicit and testable. |
| LLM structured output schemas | `contracts/llm/` | The expected output contract stays visible and reusable. |
| Actual tool invocation | `effects/tools/` | Policy and Learning stay free of tool plumbing. |
| Tool arg/result schemas | `contracts/tools/` | Validation stays discoverable instead of being buried inside a switch. |
| Child-agent dispatch | execution-side code | Use the separate runtime call path directly. No `effects/children/` folder is required. |

### Decision rule

Use this simple map:

- **Put it in `prompts/`** if it answers: *What should we ask the model?*
- **Put it in `effects/llm/`** if it answers: *How do we execute this LLM-backed intent?*
- **Put it in `contracts/llm/`** if it answers: *What structured shape must the model return?*
- **Put it in `effects/tools/`** if it answers: *How do we invoke this tool?*
- **Put it in `contracts/tools/`** if it answers: *What args/results are valid for this tool?*
- **Put it in `normalizers/`** if it answers: *How do raw runtime observations become normalized agent observations?*
- **Put it in `reducers.ts`** if it answers: *How does normalized input update cognition?*
- **Put it in `selectors.ts`** if it answers: *What decision-ready view should Policy read?*

---

## 8. Best practices by module

### `agent.ts`

Keep it short.

It should mostly do this:

```ts
export default await createAgent({
  attention,
  perception,
  learning,
  policy,
  shield,
  execution,
  transition
}, import.meta.url);
```

Do not let `agent.ts` become the place where transport decoding, prompt text, effect helpers, reducer logic, and branch-specific handling all accumulate.

---

### `types.ts`

Define the domain vocabulary first.

This file should make it easy to answer:

- what can come in
- what can be remembered
- what decisions exist
- what execution outputs exist
- what stages exist

Closed unions are strongly preferred.

This is one of the highest-value files for AI coding, because it gives the model the valid behavioral vocabulary before it opens implementation files.

---

### `perception.ts`

Perception should return normalized observations only.

Good shape:

- route inbox entries
- call source-specific normalizers
- produce a compact `Obs` union

Bad shape:

- mix inbox routing, child/tool result archaeology, artifact handling, and business logic in one long function

---

### `normalizers/`

Put source-specific decoding here.

Examples:

- `normalizeUserEntry`
- `normalizeToolEntry`
- `normalizeChildEntry`
- `normalizeInternalEntry`

This is the right place for:

- raw payload quirks
- wrapper decoding
- artifact-vs-string handling
- schema-version handling

This is **not** the right place for:

- writing cognition
- making policy decisions
- deciding terminal outcomes

---

### `learning.ts` and `reducers.ts`

Learning should feel like a reducer pipeline.

Prefer:

- start from defaults
- handle a closed set of normalized observations
- write compact, validated facts and summaries
- keep the write logic in reducers

Avoid:

- long imperative mutation chains inline
- mixing transport quirks into Learning
- writing raw wrappers or oversized payloads into `MentalState`

---

### `selectors.ts`

Policy should not read raw nested memory everywhere.

Instead, expose compact selector views.

Example:

```ts
type PolicyView = {
  hasContext: boolean;
  hasError: boolean;
  errorMessage?: string;
  targetUrl?: string;
  html?: string;
};
```

Then Policy reads `readPolicyView(m)` rather than scattered deep reads.

---

### `policy.ts`

Policy should be the easiest file to scan.

Good Policy code:

- reads selectors
- emits domain-named intents
- stays synchronous
- uses shallow branching

Policy should feel close to prose.

Bad signs:

- raw nested state reads everywhere
- prompt construction inside Policy
- transport-specific conditionals inside Policy
- tool or LLM knowledge leaking into Policy details

---

### `effects/llm/`

LLM calls belong here.

Each handler should:

- receive typed intent input
- load any needed artifacts
- build prompt input
- call `ctx.llm.call(...)`
- apply output contract validation
- return typed `ExecOutcome`

Keep prompt wording out of these files when it grows beyond trivial size. Put wording in `prompts/`.

---

### `effects/tools/`

Tool calls also belong here.

Each handler should:

- receive typed intent input
- call the runtime tool API
- normalize the immediate result shape
- return typed `ExecOutcome`

Do not hide tool calls inside random helper utilities that can be reached from anywhere.

---

### `transition.ts`

Transition should answer one question only:

**What control outcome follows from this execution result?**

Good Transition code:

- switches on typed execution outputs
- maps explicitly to `continue`, `await_*`, or `complete`
- handles all result kinds exhaustively

Bad Transition code:

- does additional payload archaeology
- relies on loosely shaped `data?.kind` logic everywhere
- quietly falls through without a clearly defined outcome

---

### `flow.md`

`flow.md` should make the dominant procedure visible.

A good `flow.md` should let a reader explain:

- what starts the agent
- what major branches exist
- what is awaited
- what resumes the agent
- what causes completion
- what causes failure

Use the canonical `flow.md` format consistently so both humans and LLMs know where to look.

---

### `tests/`

Test the agent as a turn script.

Prefer assertions over:

- intent sequence
- shield outcomes
- transition kinds
- awaited token flow
- resume behavior
- failure observations
- plan create/repair flows when plans are used

Do not test only final text.

If `flow.md` exists, its major rows and branches should be reflected in tests.

At minimum, tests should cover:

- the dominant success path
- each await/resume path
- each major failure branch
- any repair/retry branch that changes behavior materially

---

## 9. Debugging ergonomics

A readable agent should make failure localization obvious.

A human or LLM should be able to tell quickly whether a bug belongs to:

- normalization
- cognition update
- decision logic
- effect execution
- transition / await-resume behavior

### Recommended mapping

- raw payload or schema issue -> `normalizers/`
- wrong remembered fact -> `reducers.ts` / Learning
- wrong next action -> `selectors.ts` / `policy.ts`
- bad external behavior -> `effects/`
- wrong wait/resume or terminal outcome -> `transition.ts` and `flow.md`

### Operational rule

When debugging, start with the smallest artifact that should know the truth:

- `flow.md` for procedural expectation
- `types.ts` for valid vocabulary
- `normalizers/` for raw input interpretation
- `reducers.ts` for cognition writes
- `policy.ts` for next-step choice
- `effects/` for side effects
- `transition.ts` for control outcome

This keeps debugging localized and reduces broad speculative edits.

---

## 10. AI-editable artifacts

For non-trivial agents, keep these artifacts small, stable, and reviewable:

- `flow.md` for behavior over time
- `types.ts` for domain vocabulary
- `selectors.ts` for decision-ready views
- `reducers.ts` for cognition writes
- `contracts/` for structured output rules
- `prompts/` for LLM wording
- `tests/` for executable behavior checks

These files should be easy to inspect in isolation and stable enough that AI can update them without rewriting the entire agent.

A good AI-editable artifact should:

- have one obvious purpose
- use a stable vocabulary
- avoid mixed responsibilities
- remain small enough to review quickly
- make drift visible in diffs

---

## 11. Do this, not that

| Prefer | Avoid | Reason |
|---|---|---|
| Closed `Obs` union | `kind: string` + `payload: any` | The valid vocabulary becomes visible and exhaustive. |
| Domain-named `AgentIntent` | `kind: 'internal'` plus nested intent | Meaning is readable from one field. |
| `readPolicyView` selector | Ad hoc deep reads inside Policy | Policy stays small and stable. |
| `reduceSensory` reducer | Long imperative mutation chains | Learning becomes easier to test and review. |
| Named effect handlers | One giant execution switch | Each effect path gets a clear home. |
| `contracts/` for schemas | Schemas buried inside execution branches | Validation rules stay discoverable. |
| `prompts/` for prompt builders | Prompt strings spread across execution code | Prompt wording becomes easier to inspect and maintain. |
| `flow.md` for procedural flow | Reconstructing flow from raw code every time | Behavior becomes easier to inspect, review, and update. |
| Branch-based tests | Testing only final output text | Control behavior and resumes stay visible. |

---

## 12. Operational rules that improve readability

- Keep logs structured and secondary. Logic should dominate the visual surface, not logging noise.
- Store compact reasoning-ready facts in cognition. Keep large payloads and raw wrappers out of `MentalState`.
- Use one naming system across the codebase. Repeated shapes teach both humans and LLMs how to navigate the repository.
- Prefer one obvious pattern for each concern. Multiple equivalent styles quickly make the codebase harder to scan.
- Keep behavioral artifacts close to code. A reader should not have to hunt through unrelated folders to understand flow.
- Use stable branch names or IDs in `flow.md` when the agent has meaningful branching. This makes test mapping and debugging easier.

---

## 13. Pull request review checklist

Use this checklist for agent reviews:

1. Can a reviewer identify the supported observations, intents, execution outputs, and stages by reading `types.ts`?
2. Is `agent.ts` mostly wiring?
3. Are transport quirks isolated to normalizers and effect handlers?
4. Does Policy read from selectors rather than raw nested state?
5. Does Learning write compact, validated cognition through reducers?
6. Are LLM prompts in `prompts/` and schemas in `contracts/` when the agent is non-trivial?
7. Are execution result paths typed and explicitly handled by Transition?
8. Is `flow.md` present for a non-trivial agent?
9. Does `flow.md` explain the main success path, await/resume path, and main failure path?
10. If behavior changed, was `flow.md` updated in the same PR?
11. Do tests cover the dominant path, resume behavior, and major failure branches?
12. Could a new contributor explain the main flow in under 30 seconds by reading `flow.md` and the main type files?

---

## 14. Bottom line

Readable APLRET agents do not happen by taste alone.

They come from a deliberate, repeatable structure that reduces ambiguity for both humans and AI:

- closed vocabularies
- normalized inputs
- selector-driven Policy
- reducer-driven Learning
- named effect handlers
- explicit transitions
- `flow.md` for behavior over time

Use this structure consistently and agents become easier to create, review, debug, test, and evolve in real repositories.

That is what makes vibe coding durable.
