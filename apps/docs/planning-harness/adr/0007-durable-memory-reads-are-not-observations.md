# ADR 0007: Durable Memory Reads Are Not Observations

## Status

Accepted

Implementation contract: `specs/memory-read-vs-observation.md`.

## Context

The originating request (§§11–12) asked for memory-read telemetry and a
normative rule: retrieving durable history must not create a new
`env.inbox.current` observation. Re-reading a stored failure five times
must not look like six independent environment events.

APLRET already splits:

- `env.inbox.current` — new runtime observations this turn;
- `MemoryReader` — durable / historical access in Learning (and
  Execution for action loads);
- Policy — sync `M` only.

Operator `memory.read` / `memory.write` / `memory.delete` events already
exist (`loopRunner` `appendOperatorMemoryEvent`). TurnTrace has no
`memoryReads` field (ADR 0006: no first-class add).

## Decision

- The rule is **normative framework text**, not a new schema field.
- Default Learning/Perception/loop MUST NOT append an inbox observation
  because `mem.semantic.read` (or episodic/procedural) returned rows.
- Hydration stays in `M` (Learning writes compact facts). That is
  cognition, not a new observation.
- Do **not** add `TurnTrace.memoryReads`. Point docs at operator
  `memory.read` (ids, counts, query summary — **not** payloads).
- Agents MAY record a compact TurnTrace extension (Phase 5a) with ids /
  counts / latency. Core default does **not** auto-attach it.
- Policy still must not read the durable store as if it were `M`.

## Consequences

- Contracts + memory how-to become the source of truth for the rule.
- Tests assert inbox identity / no payload in traces, not a new core type.
- Privacy: retrieved content stays in durable memory; traces keep ids.

## Non-Goals

- Do not build a second cognitive store.
- Do not log retrieved document text by default.
- Do not let Policy call `mem.semantic.read` for decision inputs (existing
  purity). `contextKey` on `answer_with_llm` remains an Execution load.
