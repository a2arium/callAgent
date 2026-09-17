# Migration Checklist

Use this checklist when moving from the disposable harness to production code.

## Contract

- [x] Move accepted Zod schemas into `packages/core/src/streaming/`.
- [x] Export inferred public types.
- [x] Add type tests for illegal event states.
- [x] Keep harness schema and production schema in sync only during migration.

## Current Event Compatibility

- [x] Map existing A2A artifact events to canonical `artifact.delta`.
- [x] Map legacy `lastChunk` to canonical `artifact.done`, not task final.
- [x] Map `ctx.progress` to canonical `task.status`.
- [x] Map A2A input-required status with token/parts to canonical `input.required` plus status.
- [x] Preserve existing A2A/SSE output shape while canonical projection rolls out.

## Transport Projection

- [x] Add canonical -> SSE projection.
- [x] Close SSE only on terminal `task.status`.
- [x] Document and test legacy SSE replay by numeric sequence `Last-Event-ID`.
- [ ] Define versioned canonical replay semantics for opaque event ids.
- [x] Add public/debug/private visibility filtering in projection helpers.

## Chat Bridge

- [x] Add public streaming invoker contract types.
- [x] Implement `StreamingInvoker` methods on production invokers.
- [x] Implement programmatic streaming from event bus.
- [x] Implement JSON-RPC streaming via `tasks/sendSubscribe`.
- [x] Implement JSON-RPC resume streaming via `tasks/resubscribe` plus `tasks/input`.
- [x] Verify programmatic and JSON-RPC projections match.
- [x] Keep existing `start/resume -> ResultPayload` compatibility path.
- [x] Wire optional `RuntimeStreamSink` through compatibility `start/resume`.

## Rich Debug Events

- [x] Define schema events for `tool.started` / `tool.completed`.
- [x] Define schema events for `child.started` / `child.message` / `child.completed`.
- [x] Define schema events for conversation message events.
- [x] Define schema events for goal/thought/decision debug or private events.
- [x] Wire tool debug event producers into runtime paths.
- [x] Wire child lifecycle debug event producers into runtime paths.
- [x] Wire child input-required debug event producers into runtime paths.
- [x] Wire child output message debug event producers into runtime paths.
- [x] Wire conversation message sent/received debug event producers into runtime paths.
- [x] Wire goal/thought/decision debug/private event producers into runtime paths.
- [x] Add leak tests before enabling public/debug delivery.

## Tests

- [x] Promote positive fixture behavior to permanent schema/projection tests.
- [x] Promote invalid fixture behavior to negative tests.
- [x] Add closure regression tests for artifact completion.
- [x] Add chat bridge projection parity tests.
- [x] Add server-side `tasks/sendSubscribe` / `tasks/resubscribe` SSE integration tests.
- [x] Run targeted `yarn test` suites.
- [x] Run `yarn build`.
- [x] Run core type tests when public signatures change.

## Docs Promotion

- [x] Promote core accepted streaming contract into permanent root docs.
- [x] Update chat live-updates docs to reference canonical runtime streaming.
- [x] Add runtime host example for canonical local `/rpc` review.
- [x] Add disposable live viewer for manual JSON-RPC SSE review.
- [ ] Manually review public/debug live streams with the disposable viewer.
- [ ] Decide whether detailed ADRs need permanent copies or can remain as discarded harness history.
- [ ] Delete disposable harness after final promotion decision.
