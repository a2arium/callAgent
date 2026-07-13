# Feature Request: Optional Semantic-Memory Compare-and-Set

> **Status:** Requested by the SiteConfig activation work in `itupdated`. This is a CallAgent framework prerequisite; the requesting application must not emulate atomicity with read-then-write.
>
> **Compatibility:** Additive and opt-in. Existing semantic-memory APIs and custom backends must compile and behave unchanged.

## Problem Statement

CallAgent semantic memory exposes unconditional `get`, `set`, `add`, `delete`, `read`, and `remove` operations. A caller that reads a shared pointer and later writes a replacement cannot prove that another worker did not modify the pointer between those operations.

Working-memory sessions already use `writeSnapshotCAS`, but that contract is session-scoped. Durable site-level configuration, leader records, leases, and similar shared semantic facts need an atomic single-key conditional write without being modeled as agent sessions.

The concrete blocking case is SiteConfig activation:

```text
worker A reads active version 7       worker B reads active version 7
worker A activates bundle B           worker B activates bundle C
```

An unconditional `set` lets both workers report success. The required behavior is exactly one update and one conflict.

## Goals

1. Add versioned semantic reads and single-key compare-and-set (CAS).
2. Keep normal `get/set/add/delete` signatures and default behavior unchanged.
3. Keep existing custom semantic backends source-compatible.
4. Make support discoverable and explicit; never provide a non-atomic fallback.
5. Implement real atomicity in the PostgreSQL semantic-memory adapter.
6. Preserve tenant isolation, memory observability, and backend routing.

## Non-Goals

- Multi-key transactions.
- Distributed locks, leases, or leader election helpers.
- Automatic retry policy in the memory layer.
- Changes to working-memory snapshot CAS.
- Making CAS mandatory for every semantic backend.
- Entity-aligned CAS in the first release.
- Blob-backed CAS in the first release.

## Proposed Public Contract

Add optional types in `@a2arium/callagent-types`:

```ts
export type SemanticVersionedValue<T> = {
    value: T;
    version: string;
};

export type SemanticCompareAndSetInput<T> = {
    key: string;
    expectedVersion: string | null;
    value: T;
};

export type SemanticCompareAndSetResult =
    | { status: 'updated'; version: string }
    | { status: 'conflict'; currentVersion: string | null };

export type SemanticAtomicCapability = {
    getVersioned<T>(key: string): Promise<SemanticVersionedValue<T> | null>;

    compareAndSet<T>(
        input: SemanticCompareAndSetInput<T>,
        opts?: Pick<MemorySetOptions, 'tags'>
    ): Promise<SemanticCompareAndSetResult>;
};

export type SemanticMemoryBackend = ExistingSemanticMemoryBackend & {
    atomic?: SemanticAtomicCapability;
};

export type SemanticMemoryFacade = ExistingSemanticMemoryFacade & {
    getAtomic?(opts?: { backend?: string }): SemanticAtomicCapability | undefined;
};
```

`version` is an opaque, JSON-safe token. Callers may compare or return it but must not parse it. `expectedVersion: null` means “create only if the key is absent.”

Expose a capability bound to exactly one selected backend:

```ts
const atomic = ctx.memory.semantic.getAtomic?.({ backend: 'sql' });

if (!atomic) {
    // The selected backend does not provide atomic semantic writes.
}
```

When present, `getAtomic()` uses the explicit backend override or the registry default and returns that backend's capability. The method is optional on the broad `IMemory` facade so pre-CAS facades and test doubles remain source-compatible. It returns `undefined` when the selected backend does not support CAS. The returned capability is backend-bound, so its methods do not accept another backend override.

This shape is required because CallAgent can use an MLO default backend while also registering a CAS-capable SQL backend. A single optional `semantic.atomic` property cannot truthfully describe both the default backend and named backend overrides.

The registry must not synthesize atomicity from `get` plus `set`, and registry construction must not fail merely because a backend lacks the optional capability.

## Compatibility Contract

- Existing `SemanticMemoryBackend` implementations remain valid without adding methods.
- Existing `ctx.memory.semantic.get/set/add/delete/read/remove` call sites need no changes.
- Existing return values remain unchanged.
- Existing agents see no new consent, retry, conflict, or version behavior unless they obtain and call a capability through `getAtomic()`.
- The SQL schema migration is internal storage metadata; semantic values retain their existing JSON shape.
- An ordinary mutation remains unconditional, but every mutation of a stored row must assign a fresh internal version so previously issued CAS tokens become stale. This includes JSON, base64, blob, entity-aligned, and blob-metadata mutations.
- Version tokens are opaque generations, not per-key counters. They are not contiguous and callers must not order, increment, or parse them.

## SQL Adapter Design

Add a non-null `version` column to `agent_memory_store`, backed by a PostgreSQL sequence:

```prisma
version BigInt @default(autoincrement())
```

The migration may use an explicitly named PostgreSQL sequence and raw default if that represents the generated SQL more reliably than Prisma's schema notation.

Requirements:

1. Existing rows receive distinct valid versions during migration.
2. Every successful insert or mutation assigns `nextval(...)` in the same database statement that changes the stored row.
   The SQL adapter enforces update invalidation with a `BEFORE UPDATE` trigger so every current and future row mutation shares one rule.
3. Sequence gaps are expected. A rolled-back statement may consume a sequence value, but it must not change the stored value or stored version.
4. Delete-and-recreate must never reuse a previously issued token. A per-row `default(1)` plus `version + 1` is explicitly forbidden because it permits the ABA stale-token bug.
5. Ordinary JSON, base64, blob, entity-aligned, and blob-metadata mutations must all invalidate previously issued tokens.
6. CAS v1 accepts exact JSON-domain semantic values and tags. Values must contain only plain objects, dense arrays, finite numbers, strings, booleans, and `null`; lossy JavaScript values and blobs fail with typed `SEMANTIC_ATOMIC_VALUE_UNSUPPORTED` errors.
7. CAS v1 must reject entity-alignment options with a typed `SEMANTIC_ATOMIC_OPTION_UNSUPPORTED` error before producing alignment side effects.
8. `getVersioned` selects `value` and `version` in one tenant-scoped read.
9. Create-if-absent uses one atomic insert scoped by the `(tenant_id, key)` primary key with `ON CONFLICT DO NOTHING` and `RETURNING version`, or an equivalent single-statement operation.
10. Existing-key CAS uses one conditional update scoped by `(tenant_id, key, version)`, assigns a fresh sequence value, and returns it from that statement.
11. Zero affected rows returns `conflict`; normal contention does not throw. A following tenant-scoped, version-only read may populate `currentVersion`, but it must not influence mutation success.
12. Versions are returned as canonical positive decimal strings and are never exposed as JavaScript numbers.
13. CAS tags use the same normalization and replacement semantics as ordinary `set`.

## Memory Registry and Observability

- Implement backend-bound capability selection in `SemanticMemoryRegistry`.
- Replace the manually assembled semantic facade in `createMemoryRegistry` with `SemanticMemoryRegistry` so routing, feature detection, and observability have one implementation.
- Extend semantic-memory observer vocabulary only if necessary. Existing event consumers must continue accepting old event shapes.
- A versioned read is a read event.
- A successful CAS is a write event.
- A CAS conflict may emit diagnostic metadata but must not be represented as a successful write.
- Do not include semantic values in new traces or logs.

## Error and Result Semantics

| Condition | Result |
|---|---|
| Missing key, `expectedVersion: null` | Create and return `updated` |
| Existing key, `expectedVersion: null` | Return `conflict` with current version |
| Existing key, matching version | Update and return a new version |
| Existing key, stale version | Return `conflict` without mutation |
| Missing key, non-null version | Return `conflict` with `currentVersion: null` |
| Selected backend has no capability | `getAtomic(...)` returns `undefined` |
| Unknown backend name | Follow the registry's existing unknown-backend error policy |
| Malformed, non-canonical, non-positive, or out-of-range token | Return a typed validation error; never coerce |
| Well-formed token issued for another key or tenant | Return `conflict`; do not reveal another tenant's version |
| Blob value or entity-alignment option in CAS v1 | Return the corresponding typed unsupported error before mutation or side effects |

A decimal token contains no key or tenant identity, so a well-formed token from another key cannot be distinguished from any other stale token. “Foreign token” is therefore a conflict, not a validation error.

## Implementation Touchpoints

- `packages/types/src/IMemory.ts`: optional capability and result types.
- `packages/memory-engine/src/types/semantic/SemanticMemoryRegistry.ts`: backend-bound capability routing without a fallback.
- `packages/memory-engine/src/createMemoryRegistry.ts`: use the canonical registry rather than a parallel hand-built facade.
- `packages/memory-sql/prisma/schema.prisma` plus migration: version column.
- `packages/memory-sql/src/MemorySQLAdapter.ts`: atomic SQL behavior and ordinary-write version increments.
- Memory-engine and memory-sql contract tests; update generated Prisma artifacts through the repository's normal generation command.
- `.github/workflows/ci.yml`: required Node 22 PostgreSQL/pgvector integration job.

## Required Tests

### Type and compatibility tests

- A custom backend implementing only the pre-existing required methods still type-checks.
- A manually constructed pre-CAS `IMemory` facade without `getAtomic` still type-checks.
- Existing registry construction works when `atomic` is absent.
- `getAtomic()` returns `undefined` for an unsupported selected/default backend.
- `getAtomic({ backend: 'sql' })` returns a SQL-bound capability even when the default backend is unsupported MLO.
- Existing memory API signatures and behavior are unchanged.

### Backend-neutral capability tests

- Missing key plus expected `null` creates exactly once.
- Existing key plus expected `null` conflicts.
- Matching version updates and returns a different version.
- Stale version conflicts and leaves the value unchanged.
- Missing key plus non-null version conflicts.
- Ordinary `set` invalidates a previously read version.
- Blob and blob-metadata mutations invalidate a previously read version even though blob CAS is unsupported in v1.
- Versioned reads emit read events.
- Successful CAS operations emit write events.
- Conflicts do not emit successful write events.
- Backend selection and tenant isolation are preserved without exposing another tenant's current version.
- Malformed and out-of-range tokens return typed validation errors.
- Well-formed tokens from another key or tenant return conflicts.
- Blob values and entity-alignment options are rejected before mutation or alignment side effects.

### PostgreSQL integration tests

- Migration works for a database containing pre-version rows.
- Two independent adapter instances concurrently CAS the same key/version: exactly one returns `updated`, one returns `conflict`, and the stored value equals the winner.
- Concurrent create-if-absent calls produce exactly one creator.
- Delete and recreate a key, then prove that a token issued before deletion cannot update the recreated row.
- An ordinary write racing a CAS invalidates the CAS token and cannot allow both conditional writers to succeed.
- Tenant A's token cannot mutate tenant B's row or reveal tenant B's current version.
- Rollback/error paths leave the stored value and stored version unchanged. Consuming an unused sequence number is allowed.

### Migration tests

- A database containing pre-version rows migrates successfully.
- Every migrated row has a non-null, valid, distinct version.
- New and recreated rows receive versions that do not collide with migrated or previously deleted rows.
- Application value shapes and existing ordinary reads remain unchanged.

Use the real PostgreSQL integration harness. An in-memory fake alone cannot prove atomicity.

## Documentation and Migration

- Add the capability to the semantic-memory API reference as optional.
- Document feature detection through `getAtomic({ backend })` and the absence of a read-then-write fallback.
- Document that tokens are opaque, non-contiguous generations and that retry policy belongs to the caller.
- Document the JSON-and-tags-only v1 boundary and typed errors for blobs and entity alignment.
- Add a migration note explaining the sequence-backed SQL version column and confirming that application value shapes and ordinary memory calls are unchanged.

## Acceptance Criteria

1. Existing CallAgent agents and custom semantic backends compile without modification.
2. Existing semantic-memory behavior remains unchanged unless `atomic` is explicitly used.
3. SQL version tokens are opaque strings; every stored-row mutation assigns a fresh generation, including delete-and-recreate and blob-related mutations.
4. CAS is tenant-scoped and atomic under real concurrent PostgreSQL writers.
5. Unsupported selected backends return no atomic capability and never emulate it.
6. Exact JSON-domain values and tags support CAS; lossy JavaScript values, blobs, and entity alignment fail with typed unsupported errors before side effects.
7. Type, unit, integration, migration, and full CallAgent suites pass, with the PostgreSQL concurrency suite required in CI.

## Downstream Handoff

Publish and communicate the linked package versions in dependency order: `@a2arium/callagent-types`, memory-sql and memory-engine, then core. Include the exact `getAtomic({ backend: 'sql' })` feature-detection surface and typed unsupported errors in the handoff. The dependent SiteConfig work remains blocked until all linked packages expose the released contract.
