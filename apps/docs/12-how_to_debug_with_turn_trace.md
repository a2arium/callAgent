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

## First rule

Do not debug from chat output alone.

Chat output is usually:

- late (after multiple turns)
- compressed (missing context)
- nondeterministic (LLM variation)

Debug from TurnTrace and the turn pipeline.

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

- `stageBefore`, `stageAfter`
- `execAction`
- `transition`
- `pendingAfter`
- `stageTransition` / `stageAutoMarksApplied` / `stageInvariantChecks` / `stageInvariantError` (if using StageFacade)

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
- invariant errors (if present)

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

Look at `trace.inboxCurrent`.

Ask:

- Did the expected observation arrive?
- Is `source` correct?
- Is `kind` correct?
- Does it have the expected token?
- Is payload shape compatible?

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
- Did a StageFacade invariant error block the transition?

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

