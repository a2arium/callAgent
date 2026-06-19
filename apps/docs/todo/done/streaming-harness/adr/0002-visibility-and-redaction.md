# ADR 0002: Visibility And Redaction

## Status

Proposed

## Context

Tool args, thoughts, goals, child-agent identities, conversation messages, and
trace fields can expose sensitive internals.

## Decision

Every runtime stream event carries visibility:

- `public` - safe for normal clients.
- `debug` - safe for developer/debug clients.
- `private` - internal only; not delivered to clients by default.

Projection layers must filter by visibility before serialization.

## Consequences

- Public clients can receive rich progress without accidental leaks.
- Debug tools can opt into a fuller timeline.
- Tests must include explicit negative leak assertions.

