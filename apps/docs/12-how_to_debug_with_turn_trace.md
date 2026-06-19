# How-to: Debug an APLRET agent with TurnTrace

Use this guide when an agent behaves unexpectedly and you need to find the fault quickly.

## Goal

Use **TurnTrace** as the primary debugging artifact so you can answer:

- what the agent observed
- what Learning changed
- why Policy chose its intent
- whether Shield allowed or blocked the action
- what Execution actually did
- why Transition continued, awaited, completed, or failed

## Inputs

You should have:

- TurnTrace records for the failing session (one per turn)
- access to the normalized observation taxonomy (source/kind)
- access to the agent’s intent and stage unions

## Collecting traces in tests or in-process runs

Use **`TurnTraceCollector`** when you run the loop in-process and need to assert on traces:

- Pass **`collectTraces: true`** (and optionally **`manifestProvenance`**) to **`runLoop(ctx, M, env, modules, opts)`**.
- **`runLoop`** returns **`result.traces`** (array of **TurnTrace**) when **`collectTraces`** is true; each element is the trace for one turn.
- Alternatively, attach a **`TurnTraceCollector`** to **`ctx.__turnTraceCollector`** before running; the loop will push each turn’s trace there and you can call **`collector.getByTurn(n)`**, **`collector.getLast()`**, or **`collector.getAll()`**.
- Note on API boundaries: collector/indexed access (`result.traces[n]`, `collector.getByTurn(n)`) is separate from harness assertion helpers. In harness tests, use `expectTurn(index, fn)` for indexed assertions or `expectTurn(fn)` for latest-trace assertions.

See **How-to: Test APLRET agents** for harness examples using **`collectTraces: true`** and **`result.traces`**.

## Reading LLM, tool, and child sub-call summaries

Each **TurnTrace** can include compact summaries of sub-calls made during that turn:

- **`trace.llmCalls`** — array of **LLMCallTrace** (model, provider, durationMs, input/output tokens, cost, optional module, plus optional output-contract metadata: `hasOutputContract`, `outputContractName`, `outputContractStatus`).
- **`trace.toolCalls`** — array of **ToolCallTrace** (tool name, durationMs, status, optional module).
- **`trace.childCalls`** — array of **ChildCallTrace** (token, agentId, childTaskId, awaitCompletion, durationMs, status, parentTurnId, **`childAgentNodeId`**, **`childTraceId`**, resultSummary, error). Phase 3 onward, **`childTraceId`** / **`childAgentNodeId`** are **reliably present on successful dispatch** when telemetry is available; on failure they are **absent** (not `null`) — test with `typeof x === 'string'`. **Walking parent → child:** use **`trace.childCalls[n].childTraceId`** to correlate with the child agent’s **`TurnTrace`** / telemetry (**`collectTraces`** on the child run or your trace backend).

Console output (when using the built-in ConsoleProvider) prints a compact summary per turn; for full field-level inspection use **`result.traces`** in tests or export traces to your observability backend.

For cross-agent topology, start from the operator run graph (`GET /tasks/:taskId/run-graph`; see [Operator Run Graph](./operator-run-graph.md)). It shows root/child `AgentRun` nodes and `AgentRunEdge` links first, then points each turn back to TurnTrace via `traceId` / `spanId` / `turnTraceRef`. TurnTrace remains the turn-level source of truth; the run graph is the higher-level navigation surface.

### Opik export and payload size

When **`CALLAGENT_OPIK_ENABLED=true`** (or **`OPIK_API_KEY`** is set), spans sent to Opik are **sanitized** so a single trace does not exceed typical HTTP/API limits: long strings are truncated (default **8192** characters per string), arrays are capped, depth is limited, and objects with **`kind: "artifact"`** are reduced to metadata (**`id`**, **`mimeType`**, **`estimatedSize`**, **`name`**, **`uri`**) so HTML and other large bodies are not inlined. Override the string cap with **`CALLAGENT_OPIK_MAX_STRING_CHARS`** (positive integer). Full payloads remain in your local **`TurnTrace`** when you use **`collectTraces: true`**; Opik is a trimmed view.

Opik may advertise a large maximum object size (e.g. tens of MB) for a project or upload, but **missing spans are often not a size issue**: the JS client loads asynchronously, SDK batching and ordering still apply, and the UI may group or collapse rows. The framework **buffers turn spans** until the Opik client has finished initializing so early loop turns are not dropped. Use **`CALLAGENT_DEBUG_TURN_OPIK=1`** to log emit vs buffer vs defer paths when diagnosing gaps.

## First rule

Do not debug from chat output alone.

Chat output is usually:

- late (after multiple turns)
- compressed (missing context)
- nondeterministic (LLM variation)

Debug from TurnTrace and the turn pipeline.

## Fault localization by repository layout

TurnTrace shows *what happened*; your **folder layout** shows *where to fix it*. Standard mapping:

| Symptom class | Start here |
|---------------|------------|
| Raw payload / schema / wrapper mismatch | `normalizers/` |
| Wrong remembered fact or summary | `reducers.ts`, Learning |
| Wrong next intent | `selectors.ts`, `policy.ts` |
| Tool/LLM/child misbehavior | `effects/` |
| Wrong await, resume, or terminal outcome | `transition.ts`, and **`flow.md`** for intended procedure |

Then use **`types.ts`** for vocabulary truth and [How-to: Agent repository layout](./14-agent_repository_layout_for_aplret.md) for the full map.

## Fast triage

Classify the failure first. Then drill down.

### A) Wrong decision

Symptoms:

- Policy chose the wrong intent
- Policy repeated a step
- Policy ignored a tool/child result

Primary fields:

- `inboxCurrent`
- `perception`
- `mentalStateBeforeHash`, `mentalStateAfterHash`
- `intent`

### B) Wrong control flow

Symptoms:

- agent is stuck awaiting
- resume token mismatch
- agent completed too early

Primary fields:

- **`stageBefore`**, **`stageAfter`** — stage at turn start and after the turn (when **StageFacade** is used, **`Stage.set(ctx, stage)`** writes transition data to **`ctx.__stageTrace`**; oneTurn/loopRunner include it in the trace as **`stageTrace`** or as separate fields **`stageTransition`**, **`stageAutoMarksApplied`**, **`stageInvariantChecks`**)
- `execAction`
- `transition`
- `pendingAfter`
- **`stageTransition`** / **`stageAutoMarksApplied`** / **`stageInvariantChecks`** / **`stageInvariantError`** (if using StageFacade — typed as `InvariantErrorPayload`, inspect via `e.detail.type` discriminant)

### C) Wrong effect behavior

Symptoms:

- tool/LLM/child called twice
- timeout/retry behavior wrong
- wrong tool/child invoked

Primary fields:

- `shield`
- `execAction`, `execResult`
- `usage`
- `correlationId` (+ `traceId`/`spanId` if available)

### D) Missing or malformed data

Symptoms:

- expected result never influenced memory
- observation silently dropped
- source/kind mismatch

Primary fields:

- `inboxCurrent`
- `perception`
- invariant errors (if present — inspect via `instanceof InvariantError` and `e.invariant.detail.type` narrowing, or `instanceof ModuleExecutionError` for module failures). Invalid observation envelopes are injected as `source: 'internal', kind: 'validation.failed'` into the inbox rather than thrown.
- canonical envelope and validation reference: `./16-observation_envelope_and_validation.md`

### E) Configuration drift

Symptoms:

- code matches expected behavior but agent acts differently
- "it passed locally but failed in CI"
- agent uses wrong base URL, tool set, or configuration schema

Primary fields:

- `agentCardSource`, `runtimeManifestSource`
- `agentCardHash`, `runtimeManifestHash`

## The 7-step debugging routine

### Step 1: Find the first wrong turn

Start at the beginning of the session and find the first turn where the trace deviates from expectation.

Check per turn:

- inbox contents
- perception output
- memory hash change
- intent
- shield action
- exec action/result
- transition outcome
- stage/pending snapshot

The first wrong turn is usually the real bug.

### Step 2: Verify the inbox actually contained the expected event

Start with `trace.inboxCurrent` for a fast check.

Ask:

- Did the expected observation arrive?
- Is `source` correct?
- Is `kind` correct?
- Does it have the expected token?

Then verify payload shape on the raw observation envelope (`env.inbox.current` in your harness run or session snapshot). `trace.inboxCurrent` is a compact summary view (source/kind/token), not the full payload object.

If the event is missing: the bug is upstream of Perception (Transition/runtime injection/tool/child delivery).

### Step 3: Verify Perception normalized the event (and was loud on failures)

Look at `trace.perception`.

Ask:

- Did Perception select the right observation from the inbox batch?
- Did it validate required fields?
- Did it normalize into the expected shape?
- If invalid, did it produce a structured validation failure instead of silently returning idle?

If inbox is correct but Perception is wrong: fix Perception.

### Step 4: Verify Learning wrote the durable fact Policy needs

Compare `mentalStateBeforeHash` / `mentalStateAfterHash` (or inspect the specific memory fields if your harness exposes them).

Ask:

- Was a new `MentalState` returned?
- Was the fact written to the correct place?
- Is the fact compact and reason-ready (not a raw transport wrapper)?
- Was it overwritten later in the same object merge?

If Perception is correct but the fact never appears in memory: fix Learning.

### Step 5: Verify Policy branches on the durable fact (and only on M)

Look at `trace.intent` and the memory snapshot (or inferred hash change).

Ask:

- Which exact fact should have driven the decision?
- Was that fact present when Policy ran?
- Is Policy branching on the compact fact, or on something fragile/stale?

If the fact is present but intent is wrong: fix Policy.

### Step 6: Verify Shield outcome and Execution behavior

Look at `trace.shield`, `trace.execAction`, `trace.execResult`.

Ask:

- Did Shield pass/transform/defer/veto as expected?
- Did Execution run only when Shield allowed it?
- Did Execution produce the expected token (for await cases)?
- Did retries/timeouts behave as expected?

If intent is correct but the action is wrong: fix Shield/Execution.

### Step 7: Verify Transition and pending control state

Look at `trace.transition`, `trace.stageAfter`, `trace.pendingAfter`.

Ask:

- Did Transition choose the correct control outcome?
- If `await_*`, does the awaited token match `execAction` token?
- Is pending state consistent with the stage?
- Did Transition emit observations when it should have (for continue flows)?
- Do `stageTransition` and `stageInvariantChecks` confirm the intended state change?
- Did a StageFacade invariant error block the transition? (check `stageInvariantError` — if present, inspect `e.detail.type === 'stage_invariant'` and `e.detail.required` / `e.detail.forbidden` for specific violations)

If the effect happened but control flow is wrong: fix Transition/control plumbing.

## Playbooks for common questions

### “Why did we await?”

Look for the first turn where `transition.kind` is `await_input`, `await_tool`, or `await_child`.

Checklist:

- What intent caused the await?
- Does `execAction` include a token?
- Does `transition.token` match that token?
- Does `pendingAfter` record the token under the expected category?

If the token is missing or mismatched, you have a contract violation between Execution and Transition.

### “Why did Policy choose X?”

Policy reads only `MentalState`.

Checklist:

- Identify the specific memory fact that should explain the intent.
- Find the last turn where that fact was written (Learning step).
- Confirm the write happened *before* the policy turn.
- If the fact isn’t present, go back to Perception/Learning.
- If it is present, check the policy branch logic.

### “Why is memory not updated?”

Checklist:

- Did the expected observation appear in `inboxCurrent`?
- Did Perception normalize it into a non-idle signal?
- Did Learning return a new state object?
- Did Learning write to the same path Policy reads?
- Was a later merge/spread overwriting the write?

Typical root causes:

- Perception silently returned idle
- Learning returned `prev`
- duplicate object keys or overwriting spreads
- wrote to `memory.window` but policy reads `worldModel` (or vice versa)

### “Why did we double-call?”

Checklist:

- Compare `correlationId` across the two calls.
- Check `execResult` retry count and timeout fields.
- Check whether the same resume token was processed twice.
- Confirm idempotency keys exist for the effect.
- Confirm the resume event becomes a durable fact so Policy doesn’t re-issue the request.

Typical root causes:

- duplicate resume observation delivered
- missing idempotency guard
- missing Learning write, so Policy keeps requesting
- transition loops back into an await state without consuming completion

### “Why did the agent run with the wrong config?”

Look at the manifest provenance fields at the root of the TurnTrace.

Checklist:

- Does `agentCardSource` or `runtimeManifestSource` say `defaultPath` when you expected `inline` or `pathOverride`?
- Do the hashes match between a passing local run and a failing remote run?
- If the source is `pathOverride`, did the path resolution point to an outdated file?

If the sources or hashes do not match your expectation, the runtime configuration injection is faulty, not the agent logic.

## High-signal questions for PR review

- What is the first wrong turn?
- Which observation should have entered inbox but did not?
- Which fact should have been written into memory but was not?
- Which fact did Policy actually branch on?
- Did Shield change the intent?
- Do awaited tokens match the tokens produced by Execution?
- Are the TurnTrace manifest sources and hashes identical across environments?
- Do we have a test that asserts the TurnTrace around the new behavior?

## Minimal debugging checklist for AI coders

When an AI proposes a fix, require it to answer:

- Which TurnTrace fields prove the bug?
- Did you verify `agentCardSource` and `runtimeManifestSource` to rule out config drift?
- Which module is the root cause (Perception/Learning/Policy/Shield/Execution/Transition)?
- What changed in the turn story after the fix?
- Which tests were added or updated (and what TurnTrace assertions do they make)?

## Conversation trace fields 

When diagnosing thread-native conversation behavior, inspect:

- `trace.conversation`
- `trace.incomingMessages`
- `trace.outgoingMessages`
- `trace.messageSequenceNumber`
- `trace.dedupeHit`
- `trace.deliveryLagMs` (if populated)

Interpretation:

- missing `conversation` on an expected turn usually means no conversation observation was consumed/emitted that turn
- `dedupeHit: true` indicates idempotent replay path
- `messageSequenceNumber` should advance only for durably accepted messages

When diagnosing topic behavior, inspect:

- `trace.conversation` (`kind: 'topic'`)
- `trace.incomingMessages` / `trace.outgoingMessages`
- `trace.topicSelectorDecision.kind`
- `trace.topicSelectorDecision.resolvedMembers` (`{ memberId, agentId }[]`)
- `trace.fanoutSummary` (`accepted/rejected/queued/dedupeHits`)
- `trace.inviteDelivery` (`issued/received/accepted/declined/expired`)
- `trace.inviteDelivery.received[].autoJoinAttempted`
- `trace.inviteDelivery.received[].autoJoinError` (typed conversation error when auto-join fails)

Interpretation:

- `resolvedMembers` shows exactly which seats were targeted by selector resolution
- if `resolvedMembers` is empty on an expected post turn, inspect selector input vs active membership
- `fanoutSummary.rejected > 0` with non-empty `resolvedMembers` usually indicates queue/busy failures after selection
- for multi-seat agents, two rows may share `agentId` but differ by `memberId` (this is expected under Phase 2a)
- `inviteDelivery.received` without matching `accepted|declined|expired` indicates an invite is still pending in lifecycle state

