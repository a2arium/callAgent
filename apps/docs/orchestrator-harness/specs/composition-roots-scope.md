# Composition Root Scope (Phase 0)

## Single bootstrap function

`bootstrapCompositionRoot` (`packages/core/src/runtime/bootstrapCompositionRoot.ts`)
is the **canonical** way to wire:

- `TaskEngine`
- default or injected `IEventBus`
- `EngineLocator` registration
- optional `registerAgents` hook (agent manifests before first segment)

Worker/driver packages should use `bootstrapCompositionRootInternal` from
`@a2arium/callagent-core/unstable` when they need `runtimeDriver` /
`turnExecutor` handles.

## Migrated (Phase 0.4)

| Entry point | Bootstrap |
|---|---|
| `apps/examples/runtime-host/src/server.ts` | `bootstrapCompositionRoot` |
| `packages/core/src/runner/runnerCli.ts` (`input` subcommand) | `bootstrapCompositionRoot` |

## Deferred (documented out-of-scope for Phase 0)

These still construct `TaskEngine` directly. They are CLI/test/integration
surfaces, not production worker paths. Migrate when touched or before worker POC:

| Entry point | Notes |
|---|---|
| `packages/core/src/runner/streamingRunner.ts` | Creates engine per streaming session |
| `apps/functions/rpc/index.ts` | Serverless RPC cold start |
| `packages/chat-bridge/.../programmaticInvoker.ts` | Lazy singleton engine |
| `packages/core/tests/**` | Test fixtures — direct `new TaskEngine` OK |

## Not in bootstrap (by design)

`bootstrapCompositionRoot` does **not** register LLM clients, memory backends,
or tool plugins. Those remain in app-specific `registerAgents` hooks until a
shared `registerPlatformAgents()` lands with the worker POC (`worker-runtime.md`).
