# `flow.md` Specification for APLRET Agents

## Status

Recommended companion document for non-trivial APLRET agents.

This document defines the canonical format and authoring rules for `flow.md`.

`flow.md` is the primary human- and LLM-readable behavior map for an agent. It explains what the agent does over time across turns, awaits, resumes, branches, and terminal outcomes.

It does **not** replace:

* the APLRET runtime contract
* `agent.ts`
* tests
* ADRs
* API/reference documentation

It complements them.

---

## Purpose

APLRET agents are structurally clear but procedurally distributed.

Behavior is spread across:

* Perception
* Learning
* Policy
* Execution
* Transition
* later resumed turns

That is good for correctness, replayability, and testability.
It is worse for quickly understanding:

* what happens first
* what happens next
* what happens on failure
* what happens after an await
* what conditions lead to completion

`flow.md` exists to solve that problem.

Its job is to answer:

> What does this agent do over time?

---

## Design goals

A valid `flow.md` should be:

### 1. Human-readable

A developer should understand the dominant behavior of the agent in a few minutes.

### 2. LLM-readable and LLM-writable

An LLM should be able to:

* summarize the agent flow
* update the document after code changes
* compare flow against code
* derive tests from the described branches

### 3. Structured

The document should use a fixed section order and stable headings.

### 4. Behavioral

It should describe agent behavior over turns, not dump implementation details.

### 5. Connected to code

The document should map its vocabulary to real code artifacts.

---

## When `flow.md` is required

An agent SHOULD include `flow.md` when any of the following are true:

* it uses `await_input`
* it uses `await_tool`
* it uses `await_child`
* it has multiple major branches
* it uses LLM-backed planning or structured extraction
* it has non-trivial failure or repair paths
* understanding the procedural flow requires reading multiple modules

Simple one-turn agents MAY omit `flow.md`.

---

## Normative role

`flow.md` is the canonical behavior map for the agent.

That means:

* code review SHOULD expect it to be updated when behavior changes
* tests SHOULD align with its major paths and branches
* examples SHOULD not contradict it

However, runtime behavior is still ultimately governed by:

* code
* framework invariants
* tests

`flow.md` is behavioral documentation, not executable runtime contract.

---

## Required format

A canonical `flow.md` MUST use the following section order.

```md
# Flow: <agent-name>

## Purpose

## Flow summary

## State vocabulary

### Stages
### Normalized observations
### Intents
### Execution result kinds
### Terminal outcomes

## Flow table

## Branches and failure paths

## Turn semantics

## Code map
```

Additional sections MAY be added after `Code map`, but the required sections MUST appear and MUST remain in this order.

---

## Section requirements

### 1. Title

Format:

```md
# Flow: <agent-name>
```

The title SHOULD use the same stable agent name used by the codebase.

---

### 2. Purpose

A short paragraph describing the agent’s core job.

Rules:

* 1–3 sentences
* describe the behavioral role of the agent
* do not include low-level implementation detail

Good example:

```md
This agent receives detail-page fetch context, validates it, dispatches HTML fetching, waits for completion, and returns fetched HTML or an explicit failure.
```

---

### 3. Flow summary

A short numbered narrative of the main path and major branches.

Rules:

* SHOULD be 4–10 steps
* SHOULD describe the dominant happy path
* MUST mention major failure branches
* MUST mention await/resume points when they exist

Purpose:

* optimize for quick human understanding
* give LLMs a compact behavioral summary

---

### 4. State vocabulary

This section defines the vocabulary used by the behavior.

It MUST contain the following subsections.

#### `### Stages`

List the stage names relevant to the agent.

Rules:

* names SHOULD match code exactly
* if the agent uses only base stages, list those used by the agent
* if the agent uses agent-specific stages, include them

#### `### Normalized observations`

List the normalized observation kinds the agent reasons over.

Rules:

* names SHOULD match code exactly
* list the normalized forms, not raw transport quirks
* use the agent’s canonical observation vocabulary

Recommended format:

```md
- `user/context.provided`
- `user/validation.failed`
- `child/html.fetched`
```

#### `### Intents`

List the intent kinds the Policy may emit.

Rules:

* names SHOULD match code exactly
* list domain-intent names, not framework-internal transport details

#### `### Execution result kinds`

List the success/failure result categories Transition consumes.

Rules:

* SHOULD match the closed execution payload vocabulary
* SHOULD be small and explicit

#### `### Terminal outcomes`

List the terminal outcomes visible to users or callers.

Examples:

* success: HTML returned
* failure: validation error
* failure: child fetch failed

---

### 5. Flow table

This is the most important section.

It compresses distributed turn-based behavior into one readable table.

The table MUST include these columns:

* `Current condition`
* `Policy emits`
* `Execution does`
* `Transition outcome`
* `Next turn consequence`

Recommended format:

```md
| Current condition | Policy emits | Execution does | Transition outcome | Next turn consequence |
|---|---|---|---|---|
```

Rules:

* each row SHOULD represent a major branch or behavior path
* rows SHOULD describe behavior at the level of agent reasoning, not internal helper names
* await paths MUST explicitly show the await outcome
* terminal paths MUST explicitly show completion/failure outcome

The flow table is the primary compact behavior map.

---

### 6. Branches and failure paths

This section makes important branches explicit.

It MUST describe:

* major failure paths
* major non-happy-path branches
* any repair or retry branches if used

Recommended format:

```md
### B1: Validation failure
- Trigger:
- Recorded by:
- Policy response:
- Outcome:
```

Branch IDs such as `B1`, `B2`, `B3` are strongly recommended.

Why branch IDs help:

* easier code review
* easier test mapping
* easier LLM reasoning
* stable references in docs

---

### 7. Turn semantics

This section explains the APLRET-specific turn behavior that matters for this agent.

It should be short and explicit.

It SHOULD answer questions like:

* when does data become decision-available?
* what is awaited?
* what resumes the flow?
* what does not directly affect cognition?

Examples:

* child results influence behavior only after re-entering through inbox
* HTML becomes decision-visible only after Perception + Learning
* `await_child` suspends the loop until matching completion observation arrives

This section prevents imperative misreading of turn-based logic.

---

### 8. Code map

This section maps behavioral concepts to code locations.

Rules:

* use file paths or module names
* keep it short
* point to major behavioral artifacts, not every helper

Recommended entries:

* entry wiring
* normalized observation definitions
* main normalizers
* reducers / learning updates
* policy logic
* execution effect handlers
* transition rules

This section is essential for LLM maintainability.

---

## Authoring rules

### Rule 1: use code names exactly

Observation kinds, intent kinds, stages, and result kinds SHOULD match code spelling exactly.

Do not paraphrase code vocabulary in the state vocabulary or flow table.

---

### Rule 2: describe normalized behavior, not transport quirks

`flow.md` should describe what the agent reasons over.

Avoid describing raw runtime wrapper shapes unless they are behaviorally important.

Prefer:

* “child/html.fetched”

instead of:

* “child result contained data.html or data.content or captured_html”

Transport archaeology belongs in code, not in the flow description.

---

### Rule 3: optimize for procedural understanding

A reader should be able to answer:

* what starts the agent
* what it waits for
* what causes completion
* what causes failure
* what happens after resume

If the document does not make those clear, it is incomplete.

---

### Rule 4: keep the document concise

`flow.md` should describe dominant behavior and major branches.

It should not become a full implementation commentary.

If the document becomes too long, split complexity into:

* additional docs
* ADRs
* reference material

while keeping `flow.md` short and navigable.

---

### Rule 5: update `flow.md` when behavior changes

Any PR that changes one or more of the following SHOULD update `flow.md`:

* stage vocabulary
* normalized observation vocabulary
* intent vocabulary
* terminal outcomes
* await behavior
* major branches
* retry / repair logic
* flow control semantics

---

### Rule 6: keep the flow table authoritative for major paths

If a major behavior path exists in code but not in the flow table, the document is incomplete.

---

## Optional front matter

A small YAML front matter block MAY be added.

Recommended example:

```md
---
agent: fetch-detail-page
entry: ./agent.ts
uses_llm: false
uses_tools: false
uses_children: true
uses_plans: false
terminal_outcomes:
  - success
  - failure
---
```

This is optional, but useful for future tooling.

---

## Optional test mapping

A `Covered by tests` subsection MAY be added under branches or at the end.

Example:

```md
## Covered by tests

- B1 validation failure -> `tests/failure.test.ts`
- B2 child failure -> `tests/failure.test.ts`
- B3 success path -> `tests/golden.test.ts`
```

This is useful, but not required by the spec.

---

## Review checklist

A reviewer should be able to confirm:

* the document uses the canonical section order
* the main path is understandable in the flow summary
* the flow table covers all major paths
* failure branches are explicit
* await/resume semantics are visible
* vocabulary matches code
* code map points to the right files
* the document changed when behavior changed

---

# Example `flow.md`

Below is a worked example for a fetch-detail-style agent.

---

```md
# Flow: fetch-detail-page

## Purpose

This agent receives detail-page fetch context, validates it, dispatches HTML fetching to a child agent, waits for completion, and returns fetched HTML or an explicit terminal failure.

## Flow summary

1. **Initialization**: Wait for fetch context (URL + siteConfig) to arrive through the current-turn inbox.
2. **Validation**: Validate that the context contains a usable `url` and valid `siteConfig`.
3. **Primary Fetch**: If validation succeeds and HTML is not yet available, Policy emits `start_fetch`. Execution delegates to the fetcher sub-agent.
4. **Suspension**: Transition enters `await_child` and suspends until child completion is injected into the inbox.
5. **Completion**: Once the sub-agent returns, the agent verifies the HTML. If usable, it completes successfully; otherwise, it terminates with a terminal error.

## State vocabulary

### Stages
- `idle`: Initial state, waiting for context.
- `fetching_html`: Waiting for the child fetcher agent to complete.
- `completed`: Terminal state (Success or Failure).

### Normalized observations (Obs/Kind)
- `user/context.provided`: Initial input arrived.
- `user/validation.failed`: Input failed sanity check.
- `child/html.fetched`: Success response from child.
- `child/child.failed`: Error response from child.
- `internal/idle`: No relevant input in the current turn.

### Intents
- `wait_for_context`: No-op, continue waiting for input.
- `start_fetch`: Request child delegation.
- `complete_success`: Terminate with payload.
- `fail`: Terminate with error reason.

### Execution result categories (status)
- `child_delegated`: Child task sent, leads to `await_child`.
- `final_complete`: Success prepared, leads to `complete`.
- `waiting`: No action taken.
- `fatal_error`: Failure prepared, leads to `complete(ok: false)`.

### Terminal outcomes
- **Success**: HTML and target URL returned.
- **Failure**: `VALIDATION_ERROR` (bad input) or `FETCH_FAILED` (sub-agent failure).

## Flow table

| Current condition | Policy emits | Execution does | Transition outcome | Next turn consequence |
|---|---|---|---|---|
| No fetch context in memory | `wait_for_context` | no external effect | `continue` | Waits for a context observation |
| Validation failure recorded | `fail` | Reports `VALIDATION_ERROR`| `complete` | Terminal failure |
| Valid context, no HTML | `start_fetch` | Dispatches child fetcher | `await_child(token)` | Suspended until child completion |
| Child returns usable HTML | `complete_success` | Prepares HTML payload | `complete` | Terminal success |
| Child returns error/no HTML | `fail` | Reports `FETCH_FAILED` | `complete` | Terminal failure |

## Branches and failure paths

### B1: Validation failure
- **Trigger**: user/runtime context is missing `url` or contains invalid `siteConfig`.
- **Response**: `fail` intent.
- **Outcome**: Terminal failure.

### B2: Child failure
- **Trigger**: child completion reports `ok === false` or empty payload.
- **Response**: `fail` intent.
- **Outcome**: Terminal failure.

### B3: Successful Fetch
- **Trigger**: child completion contains usable HTML.
- **Response**: `complete_success` intent.
- **Outcome**: Terminal success.

### B4: Idle/no-input turn
- **Trigger**: no relevant current-turn inbox entries.
- **Response**: `wait_for_context` intent.
- **Outcome**: Loop continues.

## Turn semantics

- **Strict Effect Boundary**: Execution never changes cognition directly.
- **Inbox-Gated Resumption**: Child results affect behavior only after they re-enter through the inbox on a later turn.
- **Await Model**: `await_child` suspends the loop until a matching child completion observation is injected.
- **Cognitive Loop**: Policy decides only from `MentalState`, ensuring determinism regardless of turn timing.

## Code map

- **Orchestration**: `agent.ts`
- **Typing**: `types.ts`
- **Input Processing**: `normalizers/user.ts`, `normalizers/child.ts`
- **State Reducers**: `reducers.ts`
- **Decision & Effects**: `policy.ts`, `execution.ts`
- **Control Flow**: `transition.ts`
```
