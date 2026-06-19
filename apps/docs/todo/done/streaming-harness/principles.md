# Streaming Design Principles

## Core Model

Runtime streaming should be a public event contract, not an incidental side
effect of `ctx.reply`, SSE formatting, or chat bridge forwarding.

The runtime emits facts. Adapters project those facts into UX.

## Principles

1. One canonical runtime stream.
2. Transport adapters are projection layers, not sources of semantics.
3. Public, debug, and private visibility are explicit on every event.
4. Event ordering is stable, replayable, and idempotent.
5. Artifact completion is separate from task completion.
6. Terminal task status is the only event that closes a task stream.
7. Tool, child, conversation, goal, thought, and trace events are opt-in for public clients.
8. Existing `ctx.reply`, `ctx.progress`, and current SSE behavior remain compatible during migration.
9. Chat bridge must support the same stream contract in programmatic and remote JSON-RPC modes.
10. Tests define the contract before implementation is considered complete.
11. Zod schemas are the single source of truth for runtime validation and TypeScript inference.
12. Runtime stream events use closed discriminated unions; open `type: string` payloads are not acceptable public API.
13. Stream events must not bypass APLRET cognition rules: if a fact should affect Policy, it still enters through observation -> Perception -> Learning -> MentalState.

## Non-Negotiables

- `artifact.done` must never imply task final.
- `lastChunk` must not close the task stream.
- Public clients must not receive private thoughts, full tool args, raw memory, or internal traces by default.
- TurnTrace remains observability, not the primary live client protocol.
- Event schemas must be versioned.
- Public types must not export `any`; use Zod inference, discriminated unions, `unknown`, or typed payloads.
