# Change request: deadline and cancellation support for `callllm`

## Status

**Implemented upstream in `a2arium/callLLM` commit `8c0fb18` and published as `callllm@0.3.2`; CallAgent integration implemented.**

The upstream implementation adds `signal`, `timeoutMs`, typed abort/timeout errors,
one terminal boundary across call and stream processing, transactional controlled-call
history, cancellation-aware providers/retries/tools/chunks/callbacks, and safe late-result
quarantine. The remainder of this document records the accepted request and its
original rationale.

## Target

- Package: `callllm`
- Observed version: `0.3.1`
- Repository: `a2arium/callLLM`
- Affected APIs: `LLMCaller.call()` and, in a follow-up-compatible form,
  `LLMCaller.stream()`

## Summary

`callllm` does not currently provide a supported way to cancel or bound a chat call.
`LLMCallOptions` has no `AbortSignal` or total-operation timeout, the provider
interface does not carry cancellation control, and retry delays, structured-output
validation, chunk processing, usage callbacks, history updates, and telemetry can
continue after a caller has stopped awaiting the returned promise.

CallAgent needs one total deadline for an LLM operation. A caller-side
`Promise.race()` is insufficient because it abandons the await without revoking the
underlying operation's right to mutate `callllm` state or emit callbacks.

This request asks `callllm` to add cooperative cancellation with an exactly-once
terminal boundary. CallAgent will remain responsible for agent policy, durable task
state, and mapping upstream cancellation into CallAgent-specific errors.

## Current behavior

The public call options contain prompt, data, output, model settings, tools, history,
and chunking controls, but no cancellation control:

```ts
type LLMCallOptions = {
  text?: string;
  data?: string | object;
  settings?: UniversalChatSettings;
  jsonSchema?: { name?: string; schema: JSONSchemaDefinition };
  maxChunkIterations?: number;
  maxParallelRequests?: number;
  // no signal or total-operation timeout
};
```

Provider execution is also unbounded by the caller:

```ts
interface LLMProvider {
  chatCall(model: string, params: UniversalChatParams): Promise<UniversalChatResponse>;
  streamCall(model: string, params: UniversalChatParams): Promise<AsyncIterable<UniversalStreamResponse>>;
}
```

Consequences:

- a provider request that never settles keeps `LLMCaller.call()` pending;
- retry backoff cannot be interrupted;
- structured-output retries can outlive the caller's deadline;
- sequential or parallel chunks have no shared cancellation boundary;
- a late response can update history, usage, callbacks, and telemetry;
- provider SDK cancellation errors may be wrapped and lose their abort identity.

## Requested API

Add cancellation to the existing options without changing default behavior:

```ts
type LLMCallOptions = ExistingLLMCallOptions & {
  /** Cancels this complete logical call, including retries and chunks. */
  signal?: AbortSignal;

  /**
   * Optional convenience deadline measured once from LLMCaller.call() entry.
   * It must not reset for retries, validation attempts, tool resubmission, or chunks.
   */
  timeoutMs?: number;
};
```

`signal` is the required interoperability primitive. `timeoutMs` is recommended for
direct `callllm` consumers; it may be implemented by composing a single internal
abort signal at call entry. If both are present, the first abort source wins.

The same fields should be accepted by `stream()`. Full streaming behavior may ship
separately, but the API should not require a later breaking change.

### Provider control

Carry the composed signal through provider execution without placing it in the
serializable provider request payload. One compatible shape is:

```ts
type LLMExecutionControl = {
  signal?: AbortSignal;
};

interface LLMProvider {
  chatCall(
    model: string,
    params: UniversalChatParams,
    control?: LLMExecutionControl,
  ): Promise<UniversalChatResponse>;

  streamCall(
    model: string,
    params: UniversalChatParams,
    control?: LLMExecutionControl,
  ): Promise<AsyncIterable<UniversalStreamResponse>>;
}
```

Existing custom providers with two-argument methods must continue to compile and run.
Providers that support physical cancellation should pass the signal to their SDK or
HTTP client. Providers that cannot cancel may ignore it physically, but the shared
`callllm` terminal guard must still quarantine their late result.

## Required semantics

### One logical deadline

The timeout begins once, at public `call()` entry. The same deadline governs:

- provider selection and dispatch;
- provider retries and retry backoff;
- structured-output parsing and validation retries;
- tool-call resubmission performed inside the logical call;
- data splitting and all sequential or parallel chunks;
- response aggregation and final bookkeeping.

No nested step may create a fresh timeout window.

### Exactly-once terminal result

Completion, provider failure, timeout, and external abort compete for one call-local
terminal state. Exactly one outcome is returned or thrown to the caller.

- Abort before dispatch performs no provider call.
- Abort during execution rejects promptly.
- Abort is never classified as retryable.
- Repeated abort is harmless.
- Provider success or failure after abort is diagnostic only.
- A late rejection must be observed internally and must not become an unhandled
  rejection.

The upstream error should preserve machine-readable cancellation identity. Suggested
shape:

```ts
class LLMAbortError extends Error {
  readonly code = 'LLM_ABORTED';
  readonly cause?: unknown;
}
```

If `callllm` implements `timeoutMs` directly, it may expose a distinct
`LLMTimeoutError` with `code = 'LLM_TIMEOUT'` and `timeoutMs`. Alternatively, it may
surface a typed abort reason that downstream frameworks can map reliably. Do not
require consumers to parse error messages.

### Late-result quarantine

After timeout or abort wins, a provider's late completion must not:

- append assistant or tool messages to history;
- trigger usage or cost callbacks;
- emit a successful telemetry end event;
- start another tool or model iteration;
- contribute a response to chunk aggregation;
- resolve or reject the public operation a second time.

Physical provider cancellation is best-effort. Quarantining late state mutation is
the correctness requirement.

### Usage and telemetry

Start and terminal telemetry must finalize once per logical call. Cancellation should
produce an explicit terminal reason rather than leaving an active span indefinitely.

Recommended safe fields:

```ts
type LLMCallTerminalMetadata = {
  callId: string;
  startedAt: number;
  terminalAt: number;
  terminalReason: 'completed' | 'provider_error' | 'timeout' | 'cancelled';
  provider?: string;
  model?: string;
  lateCompletion?: boolean;
};
```

Do not log prompts, response content, API keys, arbitrary abort reasons, or provider
request payloads as part of cancellation diagnostics.

## Internal areas expected to change

The exact design remains with the `callllm` maintainers, but cancellation must reach
all of these boundaries:

1. `LLMCaller.call()` / `stream()` compose one signal and create the terminal guard.
2. `ChatController.execute()` checks the signal before dispatch and before every
   stateful post-response action.
3. `RetryManager.executeWithRetry()` accepts a signal, uses abortable backoff, and
   never retries cancellation.
4. Provider interfaces receive optional execution control and preserve abort errors.
5. Chunk controllers share the same signal; abort stops scheduling new chunks and
   quarantines already-running chunk results.
6. Structured-output and content retries reuse the original signal and deadline.
7. History, tool orchestration, usage callbacks, and telemetry are gated by the
   call-local terminal state.

## Compatibility requirements

- Calls without `signal` or `timeoutMs` behave exactly as they do today.
- Existing custom providers and callers remain source-compatible.
- Unknown provider-specific options continue to pass through as before.
- Cancellation does not alter response shapes for successful calls.
- Concurrent calls have independent signals, terminal state, history decisions, and
  accounting.
- One cancelled call must not cancel sibling calls unless they intentionally share an
  external signal.

## Minimal reproduction

```ts
const provider = createProviderWhoseChatCallNeverSettles();
const caller = createCallerWithProvider(provider);

await expect(
  caller.call('test', { timeoutMs: 50 }),
).rejects.toMatchObject({ code: 'LLM_TIMEOUT', timeoutMs: 50 });
```

The rejection must occur without resolving the fake provider promise. Resolving or
rejecting that promise afterward must not update history, usage, telemetry, tools, or
the already-terminal public call.

## Required tests

### API and compatibility

- no-control calls preserve current behavior;
- `timeoutMs` rejects zero, negative, infinite, and `NaN` values;
- a pre-aborted signal prevents provider dispatch;
- existing two-argument custom providers remain compatible.

### Terminal races

- completion immediately before timeout wins;
- timeout immediately before completion wins;
- external abort during provider execution wins once;
- provider failure racing timeout produces one terminal result;
- repeated abort is idempotent;
- late provider success is quarantined;
- late provider failure is handled without an unhandled rejection.

### Retries, structured output, and chunks

- abort interrupts retry backoff;
- abort is never retried;
- structured-output validation cannot reset the deadline;
- sequential chunks use one total deadline;
- parallel chunks stop scheduling and ignore late sibling results after abort;
- tool resubmission uses the original deadline.

### Accounting and concurrency

- usage callback fires at most once and never after cancellation terminalizes;
- telemetry ends once with the correct terminal reason;
- history is unchanged by late completion;
- three concurrent calls settle independently: one completes, one times out, and one
  is externally aborted.

### Streaming follow-up

- abort before first token rejects/terminates the stream once;
- abort during iteration stops provider consumption and cleanup completes;
- breaking out of iteration can optionally cancel through iterator `return()`;
- late stream chunks do not update usage, history, or telemetry.

## Acceptance criteria

1. A never-settling fake provider is bounded by `timeoutMs` and cancellable by
   `AbortSignal`.
2. Provider SDK cancellation is wired for every bundled chat provider that supports
   it.
3. Retry, validation, tool resubmission, and chunking share one logical deadline.
4. Late completion cannot mutate history, usage, telemetry, tools, or the public
   result.
5. Existing uncontrolled calls and custom providers remain compatible.
6. ESM and CJS builds export the new public types and typed errors.
7. The complete `callllm` build, type verification, and test suite pass.

## Ownership boundary

### `callllm` owns

- call-local signal composition and terminal arbitration;
- cancellation-aware retries, validation, tools, and chunks;
- signal propagation to provider SDKs;
- late-result quarantine for `callllm` history, usage, and telemetry;
- typed upstream cancellation identity.

### CallAgent owns

- the public `ctx.llm.call()` policy and timeout defaults;
- mapping upstream cancellation to stable CallAgent errors such as `LLM_TIMEOUT` and
  `LLM_CANCELLED`;
- task/turn lifecycle and durable state;
- runner-level operation ownership and diagnostics;
- host scenario behavior and fallback decisions.

CallAgent can implement caller-visible timeout detachment without this upstream
change, but it cannot guarantee physical cancellation or prevent mutations performed
inside `callllm`. Those guarantees require this change request.
