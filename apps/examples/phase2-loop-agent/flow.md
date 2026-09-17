# Flow: phase2-loop-agent

## Purpose

`phase2-loop-agent` is a canonical loop-mode APLRET example for validating durable orchestration. It demonstrates one await/resume path and one direct-complete path without legacy `handleTask` logic.

## Flow summary

1. Attention records whether the current inbox contains runtime input.
2. Perception normalizes user observations into compact domain observations.
3. Learning stores the latest user text in `Sensory`.
4. Policy asks for one extra detail when the user requests input/detail/prompt behavior and the agent has not already asked.
5. Execution calls `ctx.requestInput` for that branch, and Transition returns `await_input`.
6. On resume, the new user input is learned, Policy emits a summary reply intent, Execution replies, and Transition completes.
7. If the initial input does not require more detail, the agent replies and completes in one segment.

## State vocabulary

### Stages

- `observe`
- `ask_for_missing_detail`
- `answer_with_summary`
- `complete_idle`

### Normalized observations

- `user/input_provided`
- `runtime/no_input`

### Intents

- `prompt_user`
- `internal` with `intent: "reply_with_summary"`
- `complete`

### Execution result kinds

- `detail_requested`
- `summary_replied`
- `idle_complete`

### Terminal outcomes

- Success: `complete` with execution data.
- Failure: `fail` on unexpected execution shape or execution error.

## Flow table

| Current condition | Policy emits | Execution does | Transition outcome | Next turn consequence |
| --- | --- | --- | --- | --- |
| User text includes `input`, `ask`, `prompt`, or `detail`, and no detail was requested yet | `prompt_user` | Calls `ctx.requestInput` and records `askedForDetail` | `await_input` | Runtime pauses until input token is resumed |
| User text exists and detail was already requested or not needed | `internal: reply_with_summary` | Replies with a deterministic summary | `complete` | Task finishes |
| No user text is decision-visible | `complete` | Emits `idle_complete` | `complete` | Task finishes without await |
| Execution error | Any | Returns error result | `fail` | Task fails |

## Branches and failure paths

### B1: Await detail

- Trigger: Input text asks for input/detail behavior.
- Policy response: `prompt_user`.
- Outcome: `await_input`.

### B2: Resume after detail

- Trigger: Runtime delivers `input.provided` for the awaited token.
- Policy response: `internal: reply_with_summary`.
- Outcome: `complete`.

### B3: Direct completion

- Trigger: User text does not request extra detail.
- Policy response: `internal: reply_with_summary`.
- Outcome: `complete`.

### B4: Unexpected execution shape

- Trigger: Transition sees a non-error result with no supported action.
- Policy response: Not applicable.
- Outcome: `fail`.

## Turn semantics

The only durable boundary intentionally exercised here is `await_input`. The boundary token is produced by `ctx.requestInput`, stored in runtime snapshot metadata by the framework, and later used by the Hatchet durable parent to wait for `aplret.input.<token>`.

## Code map

- `src/agent.ts` — declarative manifest and module wiring.
- `src/types.ts` — closed domain vocabulary and execution payloads.
- `src/normalizers/user.ts` — runtime user observation normalization.
- `src/reducers.ts` — cognition writes.
- `src/selectors.ts` — Policy decision view.
- `src/attention.ts` / `src/perception.ts` / `src/learning.ts` / `src/policy.ts` / `src/shield.ts` / `src/execution.ts` / `src/transition.ts` — APLRET modules.
