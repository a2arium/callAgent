# callAgent Release Strategy

This document defines the first production-oriented npm release target for callAgent. It is the package and compatibility source of truth for the readiness work.

## Package Model

callAgent will publish scoped packages as the primary public surface:

| Package | Status | Purpose |
| --- | --- | --- |
| `@a2arium/callagent-core` | Public stable core | APLRET runtime contracts, `createAgent`, orchestration APIs, tracing types, scaffold API, and test harness exports. |
| `@a2arium/callagent-types` | Public stable support | Shared types and error classes used by framework packages and downstream agents. |
| `@a2arium/callagent-utils` | Public support | Shared logging and utility helpers needed by public packages. |
| `@a2arium/callagent-memory-engine` | Public integration | Memory registry and working-memory facade used by core and persistent stores. |
| `@a2arium/callagent-memory-sql` | Public integration | PostgreSQL/Prisma-backed memory and session persistence. |
| `@a2arium/callagent-chat-bridge` | Public integration | Chat-network routing, session mapping, reply forwarding, and realtime bridge helpers. |
| `@a2arium/callagent-eventbus-nats` | Public integration | NATS JetStream adapters for event bus, message log, and transport integration. |

The workspace root `callagent` package is not a publish target for this release. It remains the private monorepo root until a real meta-package is designed.

## Runtime Support

- Node.js: `>=20`
- TypeScript: generated declarations are part of the package contract
- Module format: ESM is required; CommonJS is supported only when a package has a real CJS build and a valid `require` export

Until dual output is implemented, packages must not advertise fake CommonJS support.

## Public API Rules

- Root package imports must be safe and cheap: no CLI startup, no database clients, no eager telemetry providers, and no process-level side effects beyond unavoidable polyfills/guards.
- Stable APIs live at the package root.
- Runner-specific APIs live under `@a2arium/callagent-core/runner`.
- Testing helpers live under explicit testing exports.
- Experimental APIs live under `./unstable`.
- Internal implementation paths are not a compatibility promise unless they are explicitly exported.

## Release Gates

Every public package must pass these gates before publish:

1. Clean build from a fresh install.
2. Published manifest contains no `workspace:`, `portal:`, `link:`, or local `file:` dependency protocols.
3. `npm pack --dry-run --json` contains only intentional files.
4. Packed artifact installs in a temporary consumer project.
5. ESM import smoke test passes from the packed artifact.
6. CJS require smoke test passes if and only if the package advertises `require`.
7. Type declarations resolve from the packed artifact.
8. README examples match the actual public API.
9. License, repository, bugs, homepage, author, engines, and publish access metadata are present.

## Documentation Promise

The root README should explain:

1. What callAgent is.
2. Why a developer should care.
3. When to use it and when not to.
4. How to install it.
5. How to create and run the first agent.
6. Where to go next by developer task.

Migration notes and drafts are maintainer material. They should not be the primary path for new third-party users.

