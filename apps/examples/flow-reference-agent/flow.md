---
agent: flow-reference-agent
entry: ./agent.ts
uses_llm: true
uses_tools: true
uses_children: true
uses_plans: true
terminal_outcomes:
  - success
  - failure
---

# Flow: flow-reference-agent

## Purpose

Demonstrate canonical non-trivial repository layout for APLRET agents.
The agent normalizes user input and either awaits more input or completes with an echoed result.

## Flow summary

1. Perception reads `env.inbox.current` and normalizes user input.
2. Learning applies normalized observations through reducers.
3. Policy reads selectors and branches:
   1. no text -> emit `wait`
   2. text available -> emit `complete`
4. Execution maps `wait` to `prompt_user` with a resume token.
5. Transition maps `prompt_user` to `await_input`.
6. After resume with user input, Policy emits `complete`.
7. Execution returns internal completion and Transition returns `complete`.

## State vocabulary

### Stages
- `idle`
- `running`
- `completed`
- `failed`
The scaffold baseline keeps stage progression simple for readability.

### Normalized observations
- `idle`
- `user_message`

### Intents
- `wait`
- `complete`

### Execution result kinds
- `ok`
- `error`

### Terminal outcomes
- Success: transition returns `complete` after a valid `complete` intent path.
- Failure: transition returns `fail` for unexpected execution action shapes.

## Flow table

| Current condition | Policy emits | Execution does | Transition outcome | Next turn consequence |
|---|---|---|---|---|
| No user text in selector view | `wait` | Request input and emit `prompt_user(token)` | `await_input(token)` | Loop pauses until input resume |
| User text present | `complete` | Return internal done with echoed payload | `complete` | Task finishes |

## Branches and failure paths

### B1: await path for missing user input
- **Trigger**: selector returns no `latestUserText`
- **Response**: policy emits `wait`, execution requests input
- **Outcome**: transition returns `await_input` with resume token

### B2: unexpected execution action
- **Trigger**: action shape not handled by transition
- **Response**: transition emits `fail`
- **Outcome**: terminal failure path for invariant/debug coverage

## Turn semantics

Data becomes decision-visible only after normalized observations flow through Learning into memory.
The loop resumes from `await_input` when a new user input observation is injected.

## Code map

- `agent.ts`, `types.ts`, `perception.ts`, `learning.ts`, `policy.ts`, `execution.ts`, `transition.ts`
- `normalizers/` (source-specific decoding)
- `selectors.ts` (decision-ready read model)
- `reducers.ts` (Learning-owned state updates)
- `effects/`, `prompts/`, `contracts/` placeholders for split non-trivial execution concerns
