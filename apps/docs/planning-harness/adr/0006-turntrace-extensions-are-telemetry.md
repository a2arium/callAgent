# ADR 0006: TurnTrace Extensions Are Telemetry, Not Cognition

## Status

Accepted

Implementation contract: `specs/turn-trace-extensions.md`.

## Context

The originating request wanted namespaced, versioned TurnTrace extensions
and a first-class `related?: TraceRef[]` for sidecar artifacts. It also
suggested `TurnTrace.memoryReads` and a generic `DecisionTrace`.

TurnTrace is already the compact per-turn truth (`TurnTraceSchema`).
Adding ATG / planner / RAG fields as first-class keys would freeze research
types into core. Putting large payloads in the trace would break the
artifact rule.

Extensions must not become a second `MentalState`. Policy reads `M`, not
the trace.

## Decision

- Add optional `extensions?: TurnTraceExtension[]` to `TurnTraceSchema`.
- Each item: `namespace` (non-empty string), `version` (non-empty string),
  `data` (JSON value, no `undefined`).
- Do **not** add first-class `related`, `memoryReads`, `decision`, or ATG
  fields. Sidecar correlation lives **inside** `data` (artifact id / ref).
- `DecisionTrace` is an example payload under an agent namespace, not a
  core type.
- Core loop does not require any extension. Agents/tests opt in via a
  recorder copied onto the trace at end of turn.
- Invalid extension objects fail `TurnTraceSchema` parse in tests; the
  loop MUST drop illegal extensions rather than fail the turn (telemetry
  must not crash cognition). Record a debug log; do not throw.

## Consequences

- Contracts document “trace is not `M`.”
- Operator UI may render unknown namespaces as JSON.
- Memory-read telemetry stays on existing operator `memory.read` events
  unless an agent adds a compact extension (sibling spec).

## Non-Goals

- Do not make extensions durable cognition.
- Do not add `MentalState.extensions`.
- Do not embed retrieved memory payloads in `data`.
