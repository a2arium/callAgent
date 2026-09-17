# Implementation Plan

This plan is intentionally staged. Production runtime code should not change
until the principles, ADRs, and specs in this workspace are reviewed.

## Phase 0: Design Harness

- [x] Create temporary workspace.
- [x] Draft principles, ADRs, specs, and scenarios.
- [x] Agree on event envelope and event type catalog.
- [x] Agree on visibility and redaction rules.
- [x] Agree on manual review workflow.

## Phase 1: Contract-Only Tests

- [x] Add schema tests for the canonical event envelope.
- [x] Add golden trace expectations as fixtures.
- [x] Add projection tests using pure mapping functions.
- [x] Add leak tests for public visibility.
- [x] Use `production-start-plan.md` to scope the first production runtime change.
- [x] Use `permanent-schema-home.md` for the target schema location.
- [x] Use `migration-checklist.md` when moving out of the disposable harness.

## Phase 2: Runtime Projection Prototype

- [x] Project existing A2A artifact, status, and input-required events into canonical events.
- [x] Preserve existing A2A/SSE behavior.
- [x] Fix artifact completion vs task final semantics.
- [ ] Emit NDJSON traces in harness mode.

## Phase 3: Rich Runtime Events

- [x] Add schema support for tools, children, conversations, goals, thoughts, and decisions.
- [x] Add visibility filtering in projections.
- [x] Wire rich debug event producers into runtime paths.
- [ ] Add replay sequencing.

## Phase 4: Chat Bridge Streaming

- [x] Add public streaming invoker contract types.
- [x] Implement `StreamingInvoker` methods on production invokers.
- [x] Implement programmatic streaming via event bus.
- [x] Implement remote JSON-RPC streaming via SSE/`tasks/sendSubscribe`.
- [x] Implement remote resume streaming via SSE/`tasks/resubscribe` plus `tasks/input`.
- [x] Verify parity between programmatic and remote modes.
- [x] Pass canonical runtime sinks through `Bridge` for live chat and realtime projection.

## Phase 5: Promotion

- [x] Move accepted core streaming specs to permanent docs.
- [ ] Decide whether detailed ADRs need permanent copies.
- [x] Move harness behavior into permanent test suites.
- [ ] Remove or promote disposable viewer/scripts.
- [ ] Delete this workspace.
