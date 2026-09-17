# ADR 0001: Canonical Runtime Stream

## Status

Proposed

## Context

Current streaming is split across task SSE events, `ctx.reply`, `ctx.progress`,
chat bridge forwarding, TurnTrace, event logs, and telemetry. This makes it hard
to provide consistent behavior across CLI, web, SSE, chat bridge, and tests.

## Decision

Adopt a canonical runtime stream event model. Runtime modules emit typed events.
Transport and client adapters project those events.

## Consequences

- SSE, chat bridge, CLI, and tests can share one source of truth.
- Existing events need compatibility projection during migration.
- Internal events require visibility/redaction controls.

