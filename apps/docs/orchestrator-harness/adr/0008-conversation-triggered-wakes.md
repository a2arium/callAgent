# ADR 0008: Conversation-Triggered Wakes

## Status

Proposed

## Context

ADR 0003 (Section 12 research) put conversation/message-log delivery **out of
scope** for the orchestrator substrate: the substrate owns task scheduling, not
the conversation bus, NATS/`IEventBus` replacement, SSE/chat ownership, or
`TurnTrace` storage.

But there is a real seam between the two: a conversation message can *cause a
task to wake* (a topic fan-out delivering a message that resumes a waiting task).
The `TurnTrigger`/`TurnWake` contract in `specs/turn-executor-kernel.md` already
includes a `conversation` trigger, so the boundary must be stated explicitly to
avoid the substrate quietly absorbing conversation transport.

## Decision

Split the concern at the wake boundary:

- **Conversation transport stays out of scope.** Message delivery, topic
  fan-out, membership, and the conversation/thread bus remain owned by the
  conversation layer (the Kafka/conversation phases), not the orchestrator.
- **The resulting task wake is in scope.** When a delivered conversation message
  must resume a waiting task, the conversation layer translates it into a normal
  runtime wake and hands it to the `RuntimeDriver`:

```text
conversation layer:
  deliver message to members (its own transport)
  for each member task that must wake:
    -> RuntimeDriver.enqueueResume({ taskId, wake: { trigger: 'conversation', ... } })

orchestrator:
  treats it as any other wake -> aplret.conversation.<token> -> aplret.segment
```

The conversation layer is a **producer of wakes**, the same way a webhook or a
tool callback is. The substrate never reads conversation state, topic
membership, or message logs.

## Consequences

- `trigger: 'conversation'` in the kernel contract is legitimate and bounded: it
  is just a labeled wake, carrying an opaque payload the segment interprets.
- No conversation concepts leak into `RuntimeDriver` / Hatchet task definitions.
- The conversation phases and the orchestrator phases can proceed independently;
  the only shared surface is `enqueueResume` + the `conversation` wake.
- Idempotency for conversation wakes uses the same durable dedupe (ADR 0005),
  keyed by the conversation message id / token.

## Open Validation

- Confirm a conversation-delivered message resumes exactly one segment, with
  duplicate delivery a durable no-op.
- Confirm no `packages/driver-hatchet` code imports conversation/topic types.
