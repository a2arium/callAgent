# How-to: Agent repository layout for APLRET

This guide defines **how to lay out an agent repository** so behavior is visible, changes stay localized, and both humans and AI assistants can navigate quickly.

It expresses the same standards as [APLRET contracts](./0-aplret_contracts.md) (repository structure, closed vocabularies, selectors, reducers, normalizers, `flow.md`).

**Related:** [`flow.md` guide](./13-flow_md_for_aplret_agents.md) · [Keep Policy pure](./3-how_to_keep_policy_pure.md) · [Use LLMs in APLRET](./10-how_to_use_llm_in_aplret.md) · [Test APLRET agents](./11-how_to_test_aplret_agents.md) · [Debug with TurnTrace](./12-how_to_debug_with_turn_trace.md) · [Best practices for agent builders (extended playbook)](./todo/next-phase-better-readability/APLRET_Agent_Builder_Best_Practices.md)

---

## Goals

- Answer **what pieces exist** from the tree and `types.ts`.
- Answer **what happens over time** from `flow.md` (non-trivial agents).
- Keep **transport quirks** at the edge (normalizers, effects).
- Keep **Policy** small and **Learning** explicit.

APLRET is designed so **vibe coding stays useful after the first draft**: structure is operational leverage, not ceremony for its own sake.

**Packages:** agent-facing **types and manifest schemas** also ship from `@a2arium/callagent-types`; the **runtime loop, harness, and orchestration** surface lives in `@a2arium/callagent-core`. The [APLRET contracts](./0-aplret_contracts.md) **Public API inventory** lists which symbols belong to which package and their stability.

---

## Golden rules

- Keep **`agent.ts` declarative** — wiring only.
- Define **domain vocabulary first** in `types.ts`: `Sensory`, `Obs`, intents, execution payloads, stages — as **closed unions**.
- **Normalize early** in Perception; keep downstream modules transport-agnostic.
- **Selector-driven** Policy; **reducer-style** Learning; **named** execution handlers.
- **Exhaustive, table-like** Transition.
- Non-trivial agents: add **`flow.md`** next to `agent.ts` (see [guide](./13-flow_md_for_aplret_agents.md)).

---

## Canonical file layout

Scaffold note:

- In downstream projects, run scaffold from your app root (for example via `node node_modules/@a2arium/callagent-core/dist/scaffold/scaffoldCli.js ...`).
- `yarn create-agent --preset minimal` is the convenience script in this monorepo and generates the minimal baseline tree.
- `yarn create-agent --preset non-trivial` (same CLI) generates the non-trivial baseline with `flow.md`, selectors/reducers, normalizers, and flag-gated `effects/`, `prompts/`, `contracts` placeholders.
- Treat generated placeholders as starting points; replace them with domain handlers/contracts as behavior grows.

### Minimal layout (simple agents)

Use when effect paths are few, normalization is light, and multi-turn flow is easy to hold in memory:

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

Optional: `attention.ts`, `shield.ts` as needed.

### Recommended layout (non-trivial agents)

Use when you have awaits, major branches, planning/repair, structured LLM steering, or heavy normalization:

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

**Notes**

- Do **not** create `effects/children/` unless you have a strong reason; child dispatch can live in execution modules (separate runtime path).
- **Expand when complexity justifies it** — not for folder symmetry.

### Split by responsibility, not symmetry

**Split when:** one file mixes responsibilities; the main flow is hard to explain; transport leaks into Policy/Learning; execution is a giant switch.

**Do not split when:** the only result is more navigation with no clarity gain.

---

## Where things live (decision map)

| If it answers… | Put it in… |
|----------------|------------|
| What should we ask the model? | `prompts/` |
| How do we run this LLM-backed intent? | `effects/llm/` |
| What structured shape must the model return? | `contracts/llm/` |
| How do we invoke this tool? | `effects/tools/` |
| What args/results are valid for this tool? | `contracts/tools/` |
| How do raw inbox rows become normalized `Obs`? | `normalizers/` |
| How does normalized input update cognition? | `reducers.ts` (called from Learning) |
| What decision-ready view should Policy read? | `selectors.ts` |
| What happens over turns and awaits? | `flow.md` |

| Concern | Location | Why |
|---------|----------|-----|
| Prompt text / builders | `prompts/` | Wording is discoverable; execution stays procedural |
| LLM invocation | `effects/llm/` | Effect boundary stays explicit and testable |
| LLM output schemas | `contracts/llm/` | Contracts visible and reusable |
| Tool invocation | `effects/tools/` | No tool plumbing in Policy/Learning |
| Tool schemas | `contracts/tools/` | Validation discoverable |
| Child dispatch | execution-side | Uses runtime child path directly |

### Decision rule (quick routing)

Use this map when choosing where a change belongs (same content as the table above, in a form that is easy for humans and AI assistants to apply):

- **Put it in `prompts/`** if it answers: *What should we ask the model?*
- **Put it in `effects/llm/`** if it answers: *How do we execute this LLM-backed intent?*
- **Put it in `contracts/llm/`** if it answers: *What structured shape must the model return?*
- **Put it in `effects/tools/`** if it answers: *How do we invoke this tool?*
- **Put it in `contracts/tools/`** if it answers: *What args or results are valid for this tool?*
- **Put it in `normalizers/`** if it answers: *How do raw runtime observations become normalized agent observations?*
- **Put it in `reducers.ts`** if it answers: *How does normalized input update cognition?*
- **Put it in `selectors.ts`** if it answers: *What decision-ready view should Policy read?*
- **Put it in `flow.md`** if it answers: *What happens over turns, awaits, and resumes?*

### Why these boundaries help (AI-assisted work)

- **Closed unions in `types.ts`** narrow the valid vocabulary so edits stay inside known shapes.
- **`flow.md`** avoids reconstructing multi-turn logic from many files on every change.
- **`selectors.ts`** keeps Policy from deep-reading nested state ad hoc.
- **`reducers.ts`** localizes cognition writes so Learning stays reviewable.
- **`contracts/`** makes structured IO explicit instead of buried in execution branches.
- **`prompts/`** keeps wording discoverable so execution files stay procedural.
- **`normalizers/`** isolate transport quirks so Policy and Learning stay transport-agnostic.

---

## Module-by-module guidance

### `agent.ts`

Mostly:

```ts
export default await createAgent({
  attention,
  perception,
  learning,
  policy,
  shield,
  execution,
  transition,
}, import.meta.url);
```

Avoid accumulating decoding, prompts, reducers, and branch logic here.

### `types.ts`

Highest-value file for AI-assisted work: define **closed** `Obs`, intent, execution data/error, and stage unions **before** large implementation files.

### `perception.ts`

- Route inbox → **normalizers** → single compact `Obs` union.
- **Bad:** one function mixing routing, archaeology, artifacts, and business rules.

### `normalizers/`

- Decoding, wrapper quirks, artifact vs string, schema version handling.
- **Not** for cognition writes, policy decisions, or terminal outcomes.

### `learning.ts` + `reducers.ts`

- Reducer pipeline: closed `switch (obs.kind)`, immutable updates, compact validated facts.
- **Avoid:** long imperative chains; transport in Learning; huge raw payloads in `MentalState`.

### `selectors.ts`

Expose e.g. `readPolicyView(m)` with a small `PolicyView` type so Policy does not deep-read nested state.

### `policy.ts`

- Read selectors; emit **domain-named** intents; stay sync and shallow.
- **Bad:** prompts in Policy; transport conditionals; scattered deep `M` reads.

### `effects/llm/` and `effects/tools/`

- Typed intent in → validate contracts → `ExecOutcome` out.
- Keep non-trivial prompt text in `prompts/`.
- **`execution.ts` should dispatch** to named handlers (per intent or per effect); avoid one endless switch that also holds prompts and schemas.
- **Bad:** mixing prompt strings, Zod schemas, and IO in a single unstructured block.

### `transition.ts`

- **Only:** map typed execution results → `continue` | `await_*` | `complete` | `fail`, exhaustively.
- **Bad:** extra payload archaeology; vague fallthrough.
- **Bad:** re-deriving business rules here; Transition should follow execution and vocabulary already defined in `types.ts` and `flow.md`.

### `flow.md`

Canonical procedure for non-trivial agents — see [How-to: `flow.md`](./13-flow_md_for_aplret_agents.md) for required section order and format.

**Update `flow.md` in the same change** when behavior over time changes, for example:

- New or renamed intent kinds Policy may emit.
- New major branches or branch IDs (`B1`, `B2`, …).
- New or changed terminal outcomes (success vs failure semantics).
- Changed await/resume behavior (`await_input`, `await_tool`, `await_child`).
- Changed stage vocabulary or turn semantics that reviewers rely on.
- Planning/repair loops that alter control flow.

### `tests/`

Turn-script tests: intents, shield, transition, awaits, resumes, failures — not only final text. Align cases with `flow.md` branch IDs when present.

**Minimum coverage** for non-trivial agents:

- Dominant success path (often `golden.test.ts`).
- Each material await/resume path (often `resume.test.ts`).
- At least one major failure or unexpected execution path (often `failure.test.ts`).
- Invariants or impossible states when you use stages, strict reducers, or complex awaits (often `invariant.test.ts`).

---

## Debugging: fault localization

| Symptom | Look first |
|---------|------------|
| Raw payload / schema mismatch | `normalizers/` |
| Wrong remembered fact | `reducers.ts`, Learning |
| Wrong next action | `selectors.ts`, `policy.ts` |
| Bad external / IO behavior | `effects/` |
| Wrong wait, resume, or terminal | `transition.ts`, `flow.md` |

**When unsure where to edit:** start from **`flow.md`** (expected procedure), then **`types.ts`** (vocabulary), then apply the [decision map](#where-things-live-decision-map) before opening implementation files.

**Order of reading:** `flow.md` (expectation) → `types.ts` (vocabulary) → normalizers → reducers → policy → effects → transition.

---

## AI-editable artifacts

For non-trivial agents, keep these **small, stable, single-purpose**:

`flow.md`, `types.ts`, `selectors.ts`, `reducers.ts`, `contracts/`, `prompts/`, `tests/`.

---

## Rules of thumb for AI-assisted edits

- Prefer **one obvious pattern per concern** (e.g. one way to add a tool effect) so diffs stay predictable.
- Keep **cognition compact**: store decision-ready facts, not raw transport blobs, in `MentalState` unless normalization truly requires holding raw input briefly.
- Keep **logs and telemetry secondary** to readable control flow in module code.
- Keep **behavioral artifacts next to code** (`flow.md` beside `agent.ts`); avoid scattering “how it works” across unrelated folders.
- After a change, **map code ↔ `flow.md` ↔ tests** so branches and awaits stay aligned.

---

## Do this, not that

| Prefer | Avoid |
|--------|--------|
| Closed `Obs` union | `kind: string` + untyped payload |
| Domain-named intents | Generic wrapper + nested intent |
| `readPolicyView` | Deep ad hoc `M` reads in Policy |
| Reducers | Long inline mutation in Learning |
| Named effect modules | One giant execution switch |
| `contracts/`, `prompts/` | Schemas and prose buried in execution |
| `flow.md` + branch IDs | Reconstructing flow from scratch each time |
| Branch-level tests | Assertions only on final assistant text |

---

## Pull request review checklist

1. Observations, intents, execution outputs, and stages discoverable from `types.ts`?
2. `agent.ts` mostly wiring?
3. Transport isolated to normalizers and effects?
4. Policy uses selectors?
5. Learning uses reducers / compact writes?
6. For non-trivial LLM usage: prompts and schemas in `prompts/` and `contracts/`?
7. Transition exhaustive on execution results?
8. Non-trivial agent has `flow.md` with success, await/resume, and failure paths?
9. Behavior change includes `flow.md` update in the same PR?
10. Tests cover dominant path, resumes, major failures?
11. Could a newcomer explain the main flow quickly from `flow.md` + types?

---

## Bottom line

**Closed vocabularies**, **normalized inputs**, **selectors**, **reducers**, **named effects**, **explicit transition**, and **`flow.md`** for non-trivial flow — together they make agents easier to build, review, debug, test, and evolve for both people and AI.

