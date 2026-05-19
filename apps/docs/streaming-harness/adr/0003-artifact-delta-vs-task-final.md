# ADR 0003: Artifact Delta Vs Task Final

## Status

Proposed

## Context

Current artifact `lastChunk` can become top-level `final`, causing SSE to close
when an artifact is complete rather than when the task is complete.

## Decision

Separate artifact lifecycle from task lifecycle:

- `artifact.delta` appends or replaces artifact content.
- `artifact.done` marks one artifact complete.
- terminal `task.status` marks task completion and closes the task stream.

## Consequences

- Incremental LLM/artifact streaming can complete artifacts without closing SSE.
- Stream closure logic becomes simpler and safer.

