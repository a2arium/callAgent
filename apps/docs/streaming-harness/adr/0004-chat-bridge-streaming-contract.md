# ADR 0004: Chat Bridge Streaming Contract

## Status

Proposed

## Context

The chat bridge `Invoker` currently returns only `completed`, `failed`, or
`input_required`. Programmatic streaming works through internal side effects,
while JSON-RPC invocation is non-streaming.

## Decision

Introduce a streaming invoker contract, either as an event sink or
`AsyncIterable<RuntimeStreamEvent>`. Programmatic and remote invokers must expose
equivalent event streams.

## Consequences

- Chat bridge can support live replies, progress, input prompts, and debug status
  consistently.
- JSON-RPC invoker needs an SSE/`tasks/sendSubscribe` implementation.
- Existing result-returning invoker can remain as compatibility sugar.

