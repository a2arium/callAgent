# Indexed and Consistent Semantic-Memory Tag Queries

> **Status:** Accepted for staged implementation. Phase 0 migration compatibility is a blocking decision gate before schema or migration work begins.
>
> **Priority:** P1 correctness, safety, and production-performance work.
>
> **Downstream blocker:** `itupdated` must not implement a fetch-limited-rows-and-filter-in-memory workaround. It remains blocked until the framework contract, PostgreSQL implementation, migration, and required tests in this specification ship in released CallAgent packages.
>
> **Related work:** [Optional Semantic-Memory Compare-and-Set](./semantic-memory-optional-cas.md). Semantic CAS is already implemented and is the mutation primitive used by downstream claim protocols.
>
> **Originating request:** `itupdated` change request `3ebe8ad docs: request production semantic tag queries`.

## Executive Summary

CallAgent currently exposes `tag` and `tags` in different layers, but does not implement one consistent query contract:

- plural `tags` are filtered in the facade after the backend has already applied `limit`;
- `tag` plus `tags` silently ignores the plural requirement;
- SQL query paths select stored tags and then discard them from result objects;
- `agent_memory_store.tags` has no production GIN index in migration history;
- bulk removal reads candidate keys and later deletes by key without rechecking the predicate;
- several raw SQL paths interpolate `LIMIT` and perform one entity-alignment query per result;
- tests that appear to cover the agent facade copy its implementation instead of exercising `SemanticMemoryRegistry`.

This specification makes tags a backend-neutral, normalized, all-of query capability. The registry constructs one canonical required-tag set and protects it in an immutable query envelope. PostgreSQL evaluates array containment with `tags @> $n::text[]` before ordering and limit. SQL-backed collection results return stored tags. A new strict bulk-removal method rechecks its predicate in the deleting statement. A production GIN index is built concurrently with explicit invalid-index recovery. Custom backends remain source-compatible and receive deterministic capability/error behavior.

The user-visible outcome is simple:

```ts
const candidates = await ctx.memory.semantic.readItems({
    tags: ['source-control', 'state:queued'],
    limit: 100,
});
```

Every returned item belongs to the selected tenant, contains both normalized tags, is selected before the limit is applied, and includes its stored tag set. The same predicate can safely discover records whose authoritative value is then validated and CAS-claimed.

## Delivery Model and Release Gates

This is one product feature delivered through independently reviewable engineering tracks. It MUST NOT land as one cross-package mega-PR. Each track may use a short series of focused PRs, but every PR must preserve existing single-tag behavior and leave the repository releasable.

| Track | Scope | Depends on | Exit gate |
|---|---|---|---|
| A — Contract and registry | Shared types, normalization, immutable prepared query, exact backend wire shape, capabilities, typed errors, strict `removeItems`, real registry tests | None | Contract tests and source-compatibility tests pass |
| B — SQL query correctness | Containment, predicate ordering, result tags, parameterized limits, MLO envelope preservation, normative residual scan | A | Real PostgreSQL correctness and tenant-isolation suites pass |
| C — Production index | Phase 0 Prisma decision, null hardening, schema declaration, concurrent GIN migration, doctor and recovery | Phase 0 decision; may develop alongside B after that decision | Fresh, shadow, populated, interrupted-build, and definition-verification tests pass |
| D — Removal safety | Predicate-rechecked `removeItems`, canonical row-lock order, bounded contention retries, transactional alignment cleanup | A and the SQL compiler from B | Removal correctness and concurrency suites pass |
| E — Performance, observability, and cleanup | Alignment batching, query-plan fixture, telemetry, dashboards, docs, CI and rollout checks | B, C, and D as applicable | Performance and operational release gates pass |

The dependency gates are:

1. **Phase 0 gate:** record the exact Prisma CLI/client/adapter patch line and migration ownership model in a committed decision record. No Track C implementation may merge before this gate passes.
2. **Query-availability gate:** Tracks A, B, and C must be released together before native plural-tag queries are enabled in any production host.
3. **Framework-acceptance gate:** Tracks A through E, including strict removal, required telemetry, real PostgreSQL CI, and operator documentation, must be complete before this feature is marked done.
4. **Downstream gate:** `itupdated` remains blocked until the coordinated package release and production migration pass their checks. A partial package release or application-side residual tag filter does not unblock it.

The master issue owns end-to-end acceptance. Child tracks may close independently, but closing a child does not imply that the user-visible feature is safe to enable.

## Normative Language

The words **MUST**, **MUST NOT**, **SHOULD**, **SHOULD NOT**, and **MAY** are normative.

- **MUST / MUST NOT** define release-blocking behavior.
- **SHOULD / SHOULD NOT** define the default design; deviations require a documented reason and tests.
- **MAY** identifies optional behavior.

## Goals

1. Provide native all-of tag filtering in the backend-neutral semantic-memory query contract.
2. Give `tag` and `tags` one unsurprising normalization and combination rule.
3. Evaluate tenant, tags, JSON filters, and other authoritative predicates before ordering and limit.
4. Return stored tags from every SQL-backed collection-query path.
5. Preserve source compatibility for existing custom semantic backends.
6. Fail explicitly when a selected backend cannot honor a plural-tag query.
7. Make the PostgreSQL path indexable with an array GIN index.
8. Deploy the index without blocking production writes and recover safely from failed concurrent builds.
9. Make tag-based removal race-safe by rechecking the predicate in the deleting statement.
10. Bound tag and query inputs before allocating large arrays or sending expensive SQL.
11. Remove avoidable query-path overhead, especially per-result entity-alignment queries.
12. Prove correctness, tenant isolation, CAS tag transitions, migration safety, and representative query plans with real PostgreSQL.
13. Provide safe telemetry that lets operators see query shape and cost without logging tag values or semantic values.

## Non-Goals

- Any-of, boolean, prefix, wildcard, fuzzy, or hierarchical tag expressions.
- A general-purpose job queue built into semantic memory.
- Automatic time-driven tag transitions such as `ready-for-approval` to `expired`.
- Automatically trusting a tag as authoritative application state.
- Multi-record transactional claims or exactly-once external side effects.
- Replacing semantic CAS with tag mutation helpers.
- Adding a combined `tenant_id + tags` GIN index through `btree_gin`.
- Optimizing `ORDER BY RANDOM()` into a sampling system in this release.
- Changing tag normalization beyond the existing trim-and-lowercase contract.
- Requiring exact-key `get()` to become a metadata-returning API in this release.
- Adding cursor pagination to the public API in this release.

## Primary Use Cases

### Action candidate discovery

A worker discovers records tagged with a record kind and an actionable lifecycle state:

```ts
const items = await ctx.memory.semantic.readItems({
    tags: ['record:source-control', 'state:queued'],
    limit: 100,
});
```

The worker then parses and validates each value and uses semantic CAS to replace both its value and complete tag set while claiming the action.

### Lifecycle reconciliation

A reconciler finds proposal records that are still tagged as ready, compares their authoritative expiry timestamp with the current time, and CAS-transitions expired records:

```ts
const ready = await ctx.memory.semantic.readItems({
    tags: ['record:proposal', 'state:ready-for-approval'],
    limit: 500,
});
```

The query is candidate discovery. Time remains authoritative because the passage of time cannot mutate a stored tag by itself.

### Tenant-safe operational sweeps

Two tenants may use identical keys and tags. Every query and removal remains bound to the adapter's resolved tenant. System-tenant escape hatches must not be introduced or widened by this feature.

### Inspection and debugging

CallAgent users need to inspect why a record matched. Collection results therefore include the complete stored tag set rather than only the requested tags.

### Safe cleanup

An operator can remove records matching a tag predicate without deleting a row that stopped matching after candidate discovery.

## Current-State Findings

The implementation must be based on the real code paths below, not only the high-level facade.

| Surface | Current behavior | Required correction |
|---|---|---|
| `packages/types/src/IMemory.ts` | `SemanticReadFilter.tags` exists, but `GetManyQuery` has only `tag`; `MemoryQueryResult` has no tags | Add backend-neutral plural input and result metadata |
| `SemanticMemoryRegistry.readItems()` | Omits `tags` from the backend query and post-filters returned rows only when `tag` is absent | Canonicalize `tag + tags` and pass the full predicate to the backend |
| `SemanticMemoryRegistry.read()` | Missing optional backend method silently returns `[]` | Resolve and validate backend methods; do not turn configuration errors into empty data |
| `SemanticMemoryRegistry.removeItem()` | Swallows every error and conflates single-key, object, and predicate deletion | Keep single-key behavior, add strict counted `removeItems`, deprecate ambiguous overloads, and propagate typed errors on strict paths |
| `MemorySQLAdapter.querySimple()` | Uses `$tag = ANY(tags)` and interpolates `LIMIT`; drops selected tags | Use parameterized containment and shared result mapping |
| Prisma filter path | Uses `has` for one tag and drops tags | Implement all-of behavior and shared mapping |
| Raw-array filter path | Applies SQL limit and then re-evaluates filters in memory | Ensure every residual predicate is evaluated before the caller-visible limit |
| Entity-aware path | Applies regular filters after SQL limit and loads alignments one row at a time | Correct predicate/limit ordering and batch alignment reads |
| Pattern path | Selects tags, drops them, interpolates `LIMIT`, and performs alignment N+1 queries | Parameterize, map tags, and batch alignments |
| `deleteMany()` | Reads all matches with `Number.MAX_SAFE_INTEGER`, ignores the requested limit, then deletes only by key | Delete with the full predicate rechecked in SQL and honor limit |
| Prisma schema/migrations | Schema declares `tags String[]`; initial production migration created nullable `TEXT[]`; no tag GIN migration exists | Normalize legacy nulls, enforce the storage invariant, and add a concurrent GIN migration |
| Optimization script | Manually proposes `GIN (tenant_id, tags)` outside migration history | Replace with the canonical tags-only index and avoid `btree_gin` dependency |
| Core semantic tests | Reimplement the facade in the test file | Test the actual `SemanticMemoryRegistry` and real SQL adapter |

## Design Principles

### One predicate, one place

The registry owns public-input normalization. A backend receives one canonical required-tag array. SQL applies that predicate. No facade may apply a second, semantically meaningful tag filter after the backend returns.

### Correctness before limit

`limit` bounds matching results, not rows inspected before all filters are evaluated. A query returning fewer than the requested limit is valid only when fewer matching records exist or when the caller requested zero.

### Capability truthfulness

A backend may either implement all-of semantics or report that it cannot. The registry must never emulate a multi-tag query by fetching a limited single-tag result and filtering it in memory.

### Compatibility through sugar

`tag` remains supported as compatibility sugar for a one-element required-tag set. It is not a separate query mode.

### Metadata fidelity

SQL collection queries return the complete stored tag set. Requested tags are predicates, not result metadata.

### Bounded work

Input sizes, result limits, residual scans, SQL round trips, and migration behavior all have explicit bounds or operator-visible failure modes.

### Tags discover; values decide

Tags are denormalized discovery metadata. Application code must validate the stored value and authoritative state before acting, then CAS-claim the record.

## Public API Contract

### Types package

Update `packages/types/src/IMemory.ts` with additive fields and generic result typing:

```ts
export type MemoryQueryResult<T> = {
    key: string;
    value: T;
    /** Complete normalized tag set stored on the row when supplied by the backend. */
    tags?: string[];
};

export type GetManyQuery = {
    /** Compatibility sugar for one required tag. */
    tag?: string;
    /** Every normalized tag must be present. */
    tags?: string[];
    filters?: MemoryFilter[];
    limit?: number;
    orderBy?: {
        path: string;
        direction: 'asc' | 'desc';
    };
    backend?: string;
    random?: boolean;
};

export type SemanticReadFilter = {
    id?: string | string[];
    tag?: string;
    tags?: string[];
    filters?: any[];
    backend?: string;
    limit?: number;
    orderBy?: { path: string; direction: 'asc' | 'desc' };
    random?: boolean;
};

export type SemanticItem<T = unknown> = {
    id: string;
    value: T;
    /** Complete normalized stored tag set for collection-query results. */
    tags?: string[];
    entities?: Record<string, unknown>;
};

export type SemanticRemoveFilter = {
    tag?: string;
    tags?: string[];
    filters?: any[];
    backend?: string;
    limit?: number;
    orderBy?: { path: string; direction: 'asc' | 'desc' };
};

export type SemanticRemoveResult = {
    removedCount: number;
};
```

The public array properties stay mutable in this release to preserve source compatibility with current callers and custom implementations. The registry copies them into an immutable prepared query before asynchronous work. Callers SHOULD treat returned tag arrays as result snapshots and must not expect mutations to persist.

Do not add `tags` only to `packages/memory-sql/src/types.ts`. That file currently duplicates shared types. The implementation SHOULD remove or alias duplicative query/result definitions so the public package remains the source of truth.

### Backend capability declaration

Add optional capability metadata to `SemanticMemoryBackend`:

```ts
export type SemanticTagQueryCapability = {
    /** Supports all-of matching for two or more normalized required tags. */
    allOf: true;
    /** Collection results contain the complete stored tag set. */
    returnsStoredTags: true;
};

export type SemanticPredicateRemovalCapability = {
    /** Supports all-of matching for normalized required tags. */
    allOfTags: true;
    /** The delete statement rechecks tags and every supported structured filter. */
    predicateRechecked: true;
    /** The backend returns an exact count of deleted memory rows. */
    returnsCount: true;
    /** Whether entity-alignment predicates can also be atomically rechecked. */
    entityFilters?: boolean;
};

export type SemanticMemoryCapabilities = {
    /** Bounded telemetry identity independent of the user-selected registration name. */
    backendKind?: 'sql' | 'mlo' | 'custom';
    tagQuery?: SemanticTagQueryCapability;
    predicateRemoval?: SemanticPredicateRemovalCapability;
};

export type SemanticMemoryBackend = {
    // Existing methods remain unchanged.
    capabilities?: SemanticMemoryCapabilities;
};
```

The SQL adapter MUST declare both capabilities. `MLOSemanticBackend` MUST expose only the capabilities that its actual underlying adapter preserves. It must not claim capabilities merely because its TypeScript input accepts a field.

Custom backends remain source-compatible because `capabilities` is optional and `GetManyQuery.tags` is additive.

### High-level method behavior

`readItems<T>(filter?: SemanticReadFilter): Promise<SemanticItem<T>[]>` MUST:

1. validate mutually exclusive query modes;
2. resolve the selected backend once;
3. normalize `tag` and `tags` into `requiredTags` once;
4. verify backend capability when more than one tag is required;
5. submit the canonical backend query;
6. map results without dropping tags;
7. emit query telemetry after success or failure.

The high-level facade MUST expose a strict bulk-removal method:

```ts
removeItem(id: string, options?: { backend?: string }): Promise<void>;
removeItems(filter: SemanticRemoveFilter): Promise<SemanticRemoveResult>;

/** @deprecated Use removeItems(filter). */
removeItem(filter: SemanticRemoveFilter): Promise<void>;
/** @deprecated Arbitrary JavaScript predicates cannot be rechecked atomically. */
removeItem(predicate: SemanticPredicateFilter): Promise<void>;
```

`removeItem(id)` remains the unambiguous single-key operation and MUST propagate backend and database errors. `removeItems(filter)` is the only high-level API that promises atomic, predicate-rechecked selection. It rejects an empty selector, honors the normalized limit, returns the number of memory rows deleted, and requires the declared predicate-removal capability for every invocation.

For source compatibility, the existing object and predicate-function `removeItem` overloads remain available for one compatibility cycle and are marked `@deprecated` in types and documentation. Their behavior is intentionally not relabeled as strict:

- the object overload delegates to `removeItems` when the backend supports the required atomic operation, discards the returned count, and propagates errors;
- a legacy backend without that capability keeps its current best-effort and error-swallowing behavior only through the deprecated overload, but MUST emit sanitized deprecation and failure telemetry; it MUST NOT be used by workflow, claim, lease, or lifecycle code;
- the predicate-function overload remains non-atomic and retains its compatibility behavior because arbitrary JavaScript cannot be re-evaluated in SQL;
- both deprecated overloads are scheduled for removal in the next major version.

This is additive source compatibility, not a claim that old bulk-removal semantics are safe. New code and all CallAgent documentation MUST use `removeItems`.

| Call | Compatibility policy in this release |
|---|---|
| `removeItem(id)` | Existing signature remains; errors now propagate as an intentional correctness fix called out in release notes |
| `removeItems(filter)` | New strict, counted, predicate-rechecked operation; errors propagate |
| Deprecated object overload on capable backend | Delegates to strict operation and propagates errors, but returns `void` |
| Deprecated object overload on incapable legacy backend | Retains best-effort/error-swallowing behavior for one cycle with sanitized telemetry |
| Deprecated predicate overload | Retains explicitly non-atomic compatibility behavior for one cycle |

The deprecation signal is a bounded counter/event on every use plus, at most, one warning per process and backend kind. It contains no predicate, backend name, key, tenant, or semantic value; this makes migration usage visible without creating log floods or leaking user data.

The low-level `read()` and `remove()` methods MUST throw when the selected backend or required backend method is missing. Returning `[]` or `0` for a configuration/capability error is forbidden.

### Exact-key reads

Exact-key mode is selected when `id` is present.

- `backend` and `limit` MAY accompany `id`.
- `tag`, `tags`, `filters`, `orderBy`, and `random` MUST NOT accompany `id` in v1.
- Invalid combinations throw `SEMANTIC_QUERY_INVALID_COMBINATION` rather than silently ignoring fields.
- Multiple IDs preserve caller input order, skip missing IDs, and apply `limit` after missing entries are removed.
- `get()` remains value-only.
- Exact-key `readItems({ id })` MAY return `tags: undefined` in v1 because the existing backend contract does not expose exact-key metadata.

The exact-key exception must be documented clearly. A later metadata-aware bulk-get capability can close it without blocking tag-query correctness.

## Canonical Tag Semantics

### Definition

For a stored row with normalized tag set `S` and canonical required tag set `R`, the row matches when:

```text
R is a subset of S
```

In PostgreSQL this is array containment:

```sql
tags @> required_tags
```

This release supports all-of semantics only.

### Normalization algorithm

Add one shared helper in `@a2arium/callagent-utils` and use it in the registry and SQL adapter:

```ts
type NormalizeRequiredTagsInput = {
    tag?: unknown;
    tags?: unknown;
};

type NormalizedRequiredTags = {
    requiredTags: string[];
    suppliedTagCount: number;
};

function normalizeRequiredTags(
    input: NormalizeRequiredTagsInput,
    limits?: SemanticTagLimits
): NormalizedRequiredTags;
```

The registry calls the helper at the public boundary. The SQL adapter calls it defensively for direct low-level consumers. Double normalization MUST be idempotent and preserve order.

The algorithm MUST:

1. distinguish an absent property from an explicitly supplied invalid value;
2. require `tag` to be a string when present;
3. require `tags` to be an array of strings when present;
4. bound the raw input count before mapping or copying the whole array;
5. trim each tag;
6. lowercase each tag using the existing JavaScript behavior;
7. reject a singular `tag` that becomes empty; remove empty entries from plural `tags`, but reject a non-empty plural input when every entry becomes empty;
8. measure normalized UTF-8 byte length;
9. remove duplicates while preserving first occurrence;
10. place normalized `tag` before entries from `tags`;
11. bound the final distinct required-tag count;
12. return an empty array only when no restriction was requested or `tags: []` was explicitly supplied.

Do not add Unicode decomposition, accent stripping, locale-sensitive case folding, namespace parsing, or punctuation rewriting. Those would change stored-key equivalence and require a separate migration.

### Combination table

| Input | Canonical required tags | Outcome |
|---|---|---|
| `{}` | `[]` | No tag restriction |
| `{ tags: [] }` | `[]` | No tag restriction |
| `{ tag: ' Ready ' }` | `['ready']` | Valid |
| `{ tags: ['Ready', 'site:42'] }` | `['ready', 'site:42']` | Valid all-of query |
| `{ tag: 'Ready', tags: ['site:42'] }` | `['ready', 'site:42']` | Both requirements apply |
| `{ tag: 'READY', tags: ['ready', 'site:42'] }` | `['ready', 'site:42']` | Duplicate removed |
| `{ tag: '' }` | none | `SEMANTIC_TAG_EMPTY` |
| `{ tags: [' ', '\t'] }` | none | `SEMANTIC_TAG_EMPTY` |
| `{ tags: ['valid', ' '] }` | `['valid']` | Valid; plural blank entries follow existing normalization behavior |
| `{ tags: [42] }` at runtime | none | `SEMANTIC_TAG_INVALID_TYPE` |
| `{ tag: 'a', tags: [] }` | `['a']` | Valid single-tag query |

### Bounds

Use named exported constants so adapters and documentation cannot drift:

```ts
export const SEMANTIC_TAG_LIMITS = {
    maxStoredTagsPerItem: 64,
    maxRawQueryTagInputs: 64,
    maxRequiredQueryTags: 32,
    maxNormalizedTagBytes: 256,
    defaultQueryLimit: 1_000,
    maxQueryLimit: 10_000,
} as const;
```

Before freezing these values, run an inventory query against representative production data. If existing stored values exceed the proposed write limits, document and implement a migration/compatibility policy rather than making old records unwritable without warning.

Write and CAS paths MUST use the same tag length/count validation and replacement semantics. Query limits MUST be finite integers from `0` through `maxQueryLimit`. `limit: 0` short-circuits to an empty result or zero removals without querying the database. An absent limit uses the configured default, which must not exceed the maximum.

## Query Combination Semantics

| Fields | Meaning |
|---|---|
| `tag` | All rows containing the one normalized tag |
| `tags` | All rows containing every normalized tag |
| `tag + tags` | Union the requirements, then apply all-of semantics |
| `tags + filters` | Both tag containment and every filter expression apply |
| `tag/tags + orderBy` | Filter first, then order, then limit |
| `tag/tags + random` | Filter first, then randomize, then limit |
| `orderBy + random` | Invalid combination |
| `id + limit` | Exact-key mode, preserving requested ID order |
| `id + any query predicate` | Invalid combination in v1 |

Default deterministic collection ordering is:

```sql
ORDER BY updated_at DESC, key ASC
```

The `key` tie-breaker is mandatory. It makes limited sweeps repeatable when several records have the same update timestamp. Supported order fields must be selected from a fixed allowlist; direction must be mapped from the enum. Neither path nor direction may be interpolated from unchecked text.

`random: true` remains supported, but documentation and telemetry must identify it as expensive on large candidate sets. It must never be used for deterministic worker sweeps.

## Backend Compatibility and Errors

### Legacy single-tag compatibility

After normalization:

- zero tags: send neither `tag` nor `tags`;
- one tag to a backend without `capabilities.tagQuery`: send `tag: requiredTags[0]` and omit `tags`;
- one or more tags to a capable backend: send `tags: [...requiredTags]` and omit `tag`;
- two or more tags to a backend without `capabilities.tagQuery.allOf === true`: throw before I/O.

These are the canonical backend wire shapes. After registry preparation, a backend MUST NOT receive both `tag` and `tags`, and an empty tag array MUST NOT be sent as a predicate. A direct low-level adapter caller may still supply either or both public fields; the adapter normalizes them immediately into its own immutable `requiredTags` and applies the same rules.

This narrow down-conversion preserves existing single-tag custom backends without pretending that they support all-of matching.

For SQL-backed CallAgent results, stored tags are required. A legacy custom backend may omit them from single-tag or untagged results because `MemoryQueryResult.tags` remains optional.

### Removal capability

Strict `removeItems` MUST require `capabilities.predicateRemoval.predicateRechecked === true` and `returnsCount === true`. Tag-bearing filters additionally require `allOfTags === true`; entity-alignment predicates require `entityFilters === true`. SQL v1 intentionally advertises `entityFilters: false`, so the registry rejects strict entity removal during capability preflight while retaining entity queries for discovery. The registry must not emulate this operation with read-then-delete. Direct low-level calls and deprecated compatibility overloads remain subject to their explicitly documented legacy behavior, but the high-level CallAgent facade must not advertise them as safe.

### Typed errors

Introduce `SemanticQueryError` with stable `code` values:

| Code | Condition |
|---|---|
| `SEMANTIC_BACKEND_NOT_FOUND` | Selected backend name is not registered |
| `SEMANTIC_BACKEND_METHOD_UNAVAILABLE` | Registered backend lacks the invoked required method |
| `SEMANTIC_TAG_QUERY_UNSUPPORTED` | Two or more required tags, but backend lacks all-of query capability |
| `SEMANTIC_PREDICATE_REMOVE_UNSUPPORTED` | Strict structured removal lacks the required predicate-rechecked/count capability |
| `SEMANTIC_TAG_INVALID_TYPE` | Runtime tag input is not a string/string array |
| `SEMANTIC_TAG_EMPTY` | A supplied tag normalizes to an empty string |
| `SEMANTIC_TAG_TOO_LONG` | Normalized tag exceeds the byte bound |
| `SEMANTIC_TAG_COUNT_EXCEEDED` | Raw or normalized tag-count bound is exceeded |
| `SEMANTIC_QUERY_LIMIT_INVALID` | Limit is non-integer, negative, non-finite, or above maximum |
| `SEMANTIC_QUERY_INVALID_COMBINATION` | Mutually exclusive fields are combined |
| `SEMANTIC_QUERY_SCAN_BUDGET_EXCEEDED` | A residual-filter fallback cannot complete within its explicit scan budget |
| `SEMANTIC_QUERY_ENVELOPE_MUTATED` | An MLO or middleware stage attempted to change a protected structural query field |
| `SEMANTIC_QUERY_COMBINATION_UNSUPPORTED` | A valid feature combination, such as random ordering with a residual predicate, cannot be executed exactly |
| `SEMANTIC_REMOVE_CONTENTION` | Bounded deadlock/serialization retries were exhausted during predicate removal |

Error metadata MAY include bounded backend kind, a stable keyed backend hash when needed, operation, required-tag count, supplied-tag count, configured limits, and query-shape flags. It MUST NOT contain raw backend names, raw tags, semantic values, filter values, tenant IDs, or complete keys.

`SemanticQueryError` MUST expose `code`, `retryable`, safe structured `details`, and an optional `cause`. Validation, combination, capability, envelope-mutation, and scan-budget errors set `retryable: false`. `SEMANTIC_REMOVE_CONTENTION` sets `retryable: true` only to indicate that a later independently scheduled operation may succeed; the framework has already exhausted its internal retries, so callers MUST apply their own bounded backoff rather than loop immediately. Unknown database failures preserve their original cause and are not mislabeled as validation errors.

Unknown-backend errors should preserve the existing human-readable phrase `No such backend: <name>` during the compatibility window while adding the typed code.

The runtime `SemanticQueryError` class is owned by `@a2arium/callagent-utils`. Its stable code union and serializable metadata types are owned by `@a2arium/callagent-types`. Core and aggregate packages MUST re-export the supported public surface so users do not need to import memory-engine internals. This ownership avoids a dependency cycle while keeping `instanceof SemanticQueryError` reliable when the workspace resolves one aligned utils version.

## Registry Architecture

### Canonical data flow

```text
agent call
   |
   v
SemanticMemoryRegistry
   |-- validate query mode and limit
   |-- normalize tag + tags -> requiredTags
   |-- resolve backend once
   |-- verify capabilities
   |-- build immutable structural query envelope
   v
selected backend
   |-- MLO may observe, but cannot replace protected fields
   |-- revalidate defensively at the adapter boundary
   |-- bind tenant internally
   |-- compile every predicate
   |-- filter -> order -> limit
   |-- batch-load alignments
   |-- map key + value + stored tags
   v
SemanticItem<T>[] + safe telemetry
```

### Backend resolution

Add a private resolver and use it from `get`, `set`, `read`, `remove`, `delete`, `readItems`, `removeItem`, `removeItems`, and capability access:

```ts
private resolveBackend(
    requestedName?: string
): { backendName: string; backend: SemanticMemoryBackend };
```

Every method must verify the backend exists before property access. Optional methods must be checked explicitly. This removes current accidental `TypeError` behavior and silent empty fallbacks.

### Prepared query

The registry MUST construct and recursively freeze, or defensively copy at every boundary, an internal immutable object:

```ts
type PreparedSemanticQuery = {
    tenantScope: Readonly<{ tenantId: string }>;
    backendName: string;
    requiredTags: readonly string[];
    filters: readonly MemoryFilter[];
    limit: number;
    orderBy: { path: 'createdAt' | 'updatedAt'; direction: 'asc' | 'desc' };
    random: boolean;
    authorizationFilters: readonly MemoryFilter[];
};
```

The low-level public query can retain `tag` and `tags` for compatibility. Internal query code operates on `requiredTags` so branches cannot accidentally prefer one property over the other. Tenant scope, backend selection, required tags, filters, authorization filters, limit, ordering, and random mode are protected structural fields.

### MLO trust boundary

MLO processing may observe the immutable envelope for tracing, routing that was already authorized by the registry, or query-language assistance that does not alter structural semantics. It MUST NOT replace, remove, broaden, or mutate a protected field. In particular, MLO output cannot select a different backend, weaken tenant or authorization filters, drop a required tag, raise a limit, change ordering/random mode, or substitute a less restrictive filter.

The implementation MUST choose one of these safe mechanics per path:

1. bypass MLO transformation for prepared structural fields and pass the original envelope to the backend; or
2. compare any processed result with the original envelope using canonical structural equality, discard no differences silently, and throw `SEMANTIC_QUERY_ENVELOPE_MUTATED` before backend I/O when a protected field changed.

Any MLO-derived advisory data must live in a separate namespaced field that the SQL compiler cannot interpret as authorization or predicate input. A wrapper advertises tag-query or predicate-removal capability only when this protection holds end to end for the wrapped adapter.

### Result mapping

Create one SQL-adapter result mapper used by pattern, simple, Prisma, raw-array, entity-aware, and residual-scan paths:

```ts
type StoredMemoryRow = {
    key: string;
    value: unknown;
    tags: string[] | null;
};

function toMemoryQueryResult<T>(
    row: StoredMemoryRow,
    alignments?: Record<string, EntityAlignment>
): MemoryQueryResult<T> {
    return {
        key: row.key,
        value: applyAlignments(row.value, alignments) as T,
        tags: row.tags ?? [],
    };
}
```

All SQL collection paths MUST select `tags`. No path may destructure only `{ key, value }` after selecting them.

### Entity alignment batching

The current per-result `getAlignmentsForMemory()` loop is an N+1 query pattern: one main query plus one query for each returned record. Replace it with one batch method:

```ts
getAlignmentsForMemories(
    memoryKeys: readonly string[],
    tenantId: string
): Promise<Map<string, Record<string, EntityAlignment>>>;
```

For any result count greater than zero, a normal collection query MUST perform:

- one primary memory query; and
- at most one entity-alignment query when entity alignment is enabled.

The number of SQL round trips must not grow with `limit`.

## PostgreSQL Query Design

### Canonical containment predicate

Use PostgreSQL array containment:

```sql
AND tags @> $2::text[]
```

The query parameter is the complete canonical required-tag array. Do not expand it into repeated `ANY(tags)` clauses. Do not use overlap `&&`, which means any-of.

The simple deterministic query shape is:

```sql
SELECT key, value, COALESCE(tags, ARRAY[]::text[]) AS tags
FROM agent_memory_store
WHERE tenant_id = $1
  AND tags @> $2::text[]
ORDER BY updated_at DESC, key ASC
LIMIT $3;
```

When `requiredTags` is empty, omit the containment predicate rather than sending an empty array solely to rely on `@> '{}'`.

### Parameterization

All data values and `LIMIT` MUST be bound parameters. Raw SQL may interpolate only fragments selected from closed internal allowlists, such as:

- `updated_at` or `created_at`;
- `ASC` or `DESC`;
- `RANDOM()` versus deterministic ordering.

Current `LIMIT ${limit}` usage must be removed from pattern, simple, raw-array, and entity-aware paths.

### Predicate ordering contract

SQL text order is not a promise about planner execution order, but semantic query construction MUST place all authoritative predicates in the candidate relation before `ORDER BY` and `LIMIT`:

1. tenant predicate;
2. tag containment;
3. key pattern or entity candidate relation;
4. JSON/filter predicates;
5. ordering;
6. limit.

No caller-visible result may be filtered by tags after step 6.

### Prisma path

Prisma's scalar-list `hasEvery` MAY be used only if integration tests against the repository's exact generated Prisma version prove that it emits correct all-of semantics and uses the expected PostgreSQL containment operator. Otherwise, use the canonical raw SQL compiler for tag-bearing queries.

The implementation must not maintain two subtly different definitions of all-of semantics merely to preserve an ORM branch. Correctness and one query compiler are preferred over branch count.

### Residual filters

Every supported filter SHOULD be compiled to SQL. For an existing entity/hybrid expression that cannot be fully compiled in this release, keyset residual scanning is the one permitted compatibility path; adapters MUST NOT invent fixed-multiplier overfetch or offset-based alternatives.

The algorithm is normative:

1. `limit: 0` short-circuits without database I/O.
2. Set `pageSize = min(1_000, max(100, requestedLimit * 4))`.
3. Use an adapter configuration `maxResidualScanRows`, defaulting to `50_000`. It is not a public query field. It MUST be a positive bounded integer and SHOULD be lower for latency-sensitive deployments.
4. Every candidate-page query includes tenant scope, the complete required-tag containment predicate, authorization filters, and every other SQL-compilable predicate.
5. Pages use the exact deterministic requested order plus `key` as a unique tie-breaker. The cursor is the last row's ordered tuple—`(updated_at, key)` or `(created_at, key)`—and the next-page comparison mirrors both the selected direction and tie-breaker. `OFFSET` is forbidden.
6. Apply the residual predicate to each page in order and collect only matches. Stop when `requestedLimit` matches have been collected or the candidate relation is exhausted.
7. Before requesting a page that could exceed the remaining scan budget, reduce that page's limit to the remaining budget. Count every candidate row inspected, whether it matches or not.
8. If the candidate relation is not exhausted when `maxResidualScanRows` is reached, discard the collected matches and throw `SEMANTIC_QUERY_SCAN_BUDGET_EXCEEDED`. Never return a partial result.
9. The budget error is non-transient: retrying the unchanged query is not expected to succeed. Its safe metadata may report configured budget, scanned-row count, and page count, but no values. Users must narrow the predicate or an operator must deliberately raise the configured bound.
10. Emit `residualFilter: true`, scanned rows, page count, page size, and outcome on success and failure.

`random: true` with a residual predicate throws `SEMANTIC_QUERY_COMBINATION_UNSUPPORTED` unless the complete predicate can execute in SQL. Public cursor pagination and broader SQL compilation remain separate follow-ups; this internal cursor exists solely to make current filter semantics exact and bounded.

### System-tenant behavior

The existing pattern-query syntax that allows a system tenant to prefix a target tenant must remain isolated to the existing authorized system-tenant path. Object tag queries must not infer tenant IDs from tags, keys, filter values, or public query objects.

## Index and Schema Design

### Canonical index

Create a tags-only GIN index:

```sql
CREATE INDEX CONCURRENTLY "agent_memory_store_tags_gin_idx"
    ON "agent_memory_store"
    USING GIN ("tags" array_ops);
```

PostgreSQL GIN supports the array `@>` operator. The existing B-tree tenant index and tags GIN index can be combined by the planner with bitmap index scans. A combined `GIN (tenant_id, tags)` index would require non-default operator support such as `btree_gin`, adds an extension dependency, and is not the default design.

High-selectivity queries may legitimately choose a sequential scan. The acceptance criterion is that selective representative tag queries can use the GIN index and that the index definition supports `@>`.

### Prisma schema declaration

After verifying syntax against the exact Prisma version used for generation, represent the index in `packages/memory-sql/prisma/schema.prisma`:

```prisma
model AgentMemoryStore {
    // existing fields
    tags String[]

    @@index(
        [tags(ops: ArrayOps)],
        type: Gin,
        map: "agent_memory_store_tags_gin_idx"
    )
}
```

The schema declaration prevents future `migrate dev` output from treating the production index as drift. The generated SQL must still be customized to use `CONCURRENTLY`.

### Legacy null tags

Production history initially created `tags TEXT[]` without `NOT NULL` or a default, while the current Prisma schema declares `String[]`. Before relying on the invariant, add a data-hardening migration. The following update is illustrative and may run as one statement only when the Phase 0 inventory proves the null population is at or below the reviewed small-table threshold:

```sql
UPDATE "agent_memory_store"
SET "tags" = ARRAY[]::text[]
WHERE "tags" IS NULL;

ALTER TABLE "agent_memory_store"
    ALTER COLUMN "tags" SET DEFAULT ARRAY[]::text[];
```

Enforce non-null with a production-safe sequence appropriate to the supported PostgreSQL versions:

1. add a temporary `CHECK (tags IS NOT NULL) NOT VALID` constraint;
2. backfill null rows in resumable primary-key batches, committing each batch; record the last processed key and cumulative count so interruption is visible and restartable;
3. validate the constraint;
4. set `NOT NULL` during a reviewed low-risk lock window, using the validated constraint to avoid an unnecessary full validation scan where PostgreSQL supports that optimization;
5. drop the temporary check constraint.

Every hardening statement MUST use a reviewed `lock_timeout` and `statement_timeout`. Phase 0 records the batch size, small-table threshold, expected row count, estimated WAL volume, and abort conditions from representative inventory. If a batch times out, replication lag crosses the deployment threshold, or the observed row count materially exceeds inventory, the migration stops without hiding partial progress; the operator corrects the condition and resumes from the checkpoint. An unbounded production `UPDATE ... WHERE tags IS NULL` is forbidden above the recorded threshold.

Until all supported databases are hardened, collection queries and result mapping use `COALESCE(tags, ARRAY[]::text[])`. A null tag array never matches a non-empty required set.

### Existing manual index

`packages/memory-sql/scripts/optimize-tenant-queries.sql` currently proposes:

```sql
USING GIN (tenant_id, tags)
```

Update that script and the multi-tenant draft documentation to reference the canonical tags-only index name and definition. The migration is authoritative; the script becomes an idempotent verification/repair aid, not a separate schema design.

## Concurrent Migration and Recovery

### Phase 0 Prisma compatibility decision

Before Track C schema work, run a blocking spike against the exact candidate versions of `prisma`, `@prisma/client`, and `@prisma/adapter-pg`. Commit a short decision record containing:

- the chosen aligned patch line and lockfile evidence;
- whether Prisma owns the concurrent index migration or an operator-managed step owns it;
- successful `migrate deploy` on a fresh database and a populated database;
- successful complete-history replay and the repository's shadow/`migrate dev` workflow;
- the exact behavior after an intentionally failed concurrent build and the tested `migrate resolve` recovery;
- generated-client compatibility and package build/test results;
- the rejected alternative and why it failed or created more operational risk.

The preferred outcome is one aligned, verified Prisma version across the workspace with Prisma migration history remaining authoritative. If that cannot execute concurrent builds safely, the decision record MUST select and test an operator-managed index step plus explicit migration resolution; this specification must then be updated with its exact commands before Track C merges. Do not partially upgrade linked Prisma packages and do not assume the currently locked 7.4.0 line is suitable without the spike.

The Phase 0 result is a release artifact and a hard gate, not an implementation note. Contract-only Track A work may proceed while the spike runs; no schema declaration, generated migration, or production deployment procedure may merge ahead of the recorded decision.

### Migration packaging after Phase 0

Use a dedicated migration directory or operator step, according to the committed decision, whose SQL contains the concurrent index build and no explicit transaction block. Do not combine table rewrites, constraint validation, or unrelated indexes in the same operation.

Do not use `IF NOT EXISTS` for the authoritative index build. PostgreSQL only checks the name; it does not prove that an existing index has the right columns, operator class, access method, predicate, or validity.

### Preflight inspection

Provide a read-only doctor/preflight command that queries `pg_class`, `pg_namespace`, `pg_index`, `pg_am`, `pg_attribute`, and `pg_opclass`. It must classify the canonical index as:

- `absent`;
- `valid-canonical`;
- `invalid-canonical`;
- `name-collision-wrong-definition`.

It should also report the legacy `idx_memory_tenant_tags` index when present. Output must include schema, index name, validity, readiness, access method, indexed expression/columns, operator class, and size. It must not print database credentials.

### Failed-build recovery

`CREATE INDEX CONCURRENTLY` can leave an invalid index after failure. Recovery is:

1. stop and inspect why the build failed, including disk space and conflicting activity;
2. confirm the invalid object is the intended canonical index;
3. run:

   ```sql
   DROP INDEX CONCURRENTLY IF EXISTS "agent_memory_store_tags_gin_idx";
   ```

4. if Prisma marked the migration failed, mark that exact migration rolled back through the supported `prisma migrate resolve` flow;
5. rerun the deployment migration;
6. rerun the doctor and an `EXPLAIN (ANALYZE, BUFFERS)` verification query.

`REINDEX INDEX CONCURRENTLY` MAY be offered as an operator path for a valid-definition invalid index, but drop-and-retry is the documented default because it makes migration state easier to reason about.

A wrong-definition name collision must fail closed. The tool must not drop a valid operator-created index automatically.

### Deployment order

1. Release compatible types and adapter code that can run before the index exists, while keeping downstream use disabled.
2. Run the tag inventory and index doctor.
3. Apply tag-null hardening.
4. build the GIN index concurrently;
5. verify index validity and definition;
6. analyze the table if statistics are stale;
7. deploy/enable native plural-tag query consumers;
8. observe query latency, scan counts, errors, and index usage;
9. only after verification, consider dropping a redundant legacy tag index concurrently.

Correct query semantics must not depend on the index being present. The index controls performance and rollout readiness, not logical results.

## Atomic Predicate-Rechecked Removal

### Required behavior

For `removeItems(filter)`, the row deleted must still satisfy tenant, tags, supported JSON filters, and any other supported selector in the deleting SQL statement. Reading keys and later deleting only by key is forbidden. Entity-alignment predicates remain discovery-only in SQL v1 and fail capability preflight rather than being approximated.

The adapter MUST honor `limit`. When a limit is present, candidate selection uses the same deterministic default ordering as reads unless the caller supplies a supported `orderBy`.

An empty selector MUST throw instead of deleting everything. At least one normalized required tag or one supported structured filter must remain after validation; `backend`, `limit`, and `orderBy` do not count as selectors, and `tags: []` alone is empty. The pattern string `'*'` remains the explicit low-level remove-all request and is not accepted by `removeItems`.

### SQL shape

Use one tenant-scoped transaction. Candidate priority follows the caller's requested order, but locks are always acquired by key ascending so two removers cannot reverse the row-lock order:

```sql
WITH selected AS MATERIALIZED (
    SELECT key
    FROM agent_memory_store
    WHERE tenant_id = $1
      AND tags @> $2::text[]
      /* compiled supported JSON predicates */
    ORDER BY updated_at DESC, key ASC
    LIMIT $3
),
locked AS MATERIALIZED (
    SELECT memory.key
    FROM agent_memory_store AS memory
    JOIN selected ON selected.key = memory.key
    WHERE memory.tenant_id = $1
    ORDER BY memory.key ASC
    FOR UPDATE OF memory
)
DELETE FROM agent_memory_store AS memory
USING locked
WHERE memory.tenant_id = $1
  AND memory.key = locked.key
  AND memory.tags @> $2::text[]
  /* predicate recheck */
RETURNING memory.key;
```

Then delete `entity_alignment` rows for the returned keys in the same transaction. If alignment cleanup fails, the transaction rolls back the memory deletion. The result count is the number of memory rows returned, not the number of alignment rows.

When no tag requirement exists, omit containment in both places. When `limit: 0`, return zero without opening a transaction.

The requested order fragment in `selected` comes from the same closed allowlist used by reads. The `locked` order is never caller-controlled. The implementation may use an equivalent single-statement design, but tests must prove priority selection, canonical lock order, and the same predicate race behavior.

### Concurrency contract

If another transaction removes a required tag before this remover obtains the row lock, the remover must not delete that row. If the remover locks and deletes first, a competing CAS/update observes the missing row or conflict according to its own contract. The framework does not promise that all rows in a multi-row removal are one application-level snapshot; it promises tenant isolation and per-row predicate integrity.

The adapter MUST retry the complete transaction after PostgreSQL `40P01` (deadlock detected) or `40001` (serialization failure) at most two times, using bounded randomized backoff between 10 and 50 milliseconds. Every retry reselects candidates and rechecks predicates; therefore a retry may remove a different still-matching row at the requested position, which is consistent with the documented non-snapshot multi-row contract. Validation, capability, timeout, connection, and arbitrary SQL errors are not retried by this policy. Exhaustion throws `SEMANTIC_REMOVE_CONTENTION` with attempt count and SQLSTATE category, but no keys, tags, tenant, or values.

### Predicate-function overload

`removeItem((item) => boolean)` cannot be made predicate-rechecked because arbitrary JavaScript is not executable in PostgreSQL. Keep it only for the compatibility cycle described in the public contract, mark it non-atomic and deprecated, and do not use it for claim, lease, state-machine, or lifecycle transitions. `removeItems(filter)` is the strict replacement in this release.

## CAS and Tag Transition Semantics

Semantic CAS already updates the value and replacement tag set atomically. This feature MUST preserve and test that property.

Given stored record:

```text
value = { state: "queued", ... }
tags  = ["record:source-control", "state:queued", "site:42"]
```

A successful CAS claim writes both:

```text
value = { state: "claimed", claimId: "...", ... }
tags  = ["record:source-control", "state:claimed", "site:42"]
```

Immediately after commit:

- the old `state:queued` query must not return the row;
- the new `state:claimed` query must return it;
- the new query result must contain the complete replacement tag set;
- a competing CAS using the old version must conflict;
- at most one claimant may perform the external action.

CAS options replace the complete derived tag set. They do not merge tags. Ordinary writes must use the same normalization, bounds, and replacement semantics.

## Query-Path Implementation Matrix

Every row in this matrix is P1 unless explicitly deferred:

| Adapter path | Required tag handling | Stored tags | Filters before limit | Alignment load | Limit binding |
|---|---|---|---|---|---|
| Exact pattern string | No new tag input | Required | Pattern before limit | Batched | Parameterized |
| Simple object query | `@> requiredTags` | Required | Yes | Batched | Parameterized |
| Prisma regular-filter query | `hasEvery` only if verified, otherwise canonical SQL | Required | Yes | Batched | Bound through Prisma or SQL |
| Raw array/logical filters | `@> requiredTags` | Required | Yes | Batched | Parameterized |
| Entity-only filters | `@> requiredTags` in final candidate relation | Required | Yes | Batched | Parameterized |
| Mixed entity/regular filters | SQL compilation or bounded keyset residual scan | Required | Yes | Batched | Applied after full match |
| Random query | `@> requiredTags` before `RANDOM()` | Required | Yes | Batched | Parameterized |
| Strict `removeItems` | `@> requiredTags` in candidate and delete recheck | Exact `removedCount` | Yes | Alignment delete batched | Honored and parameterized |

## Performance Requirements

### Query complexity

- Tag matching must occur in PostgreSQL.
- Collection result memory use is proportional to the bounded result limit plus any explicitly bounded residual page, not the tenant's total matching set.
- Normal collection reads use O(1) SQL round trips with respect to result count.
- Tag removal must not materialize all matching semantic values in Node.js.
- No path may use `Number.MAX_SAFE_INTEGER` as an operational limit.
- Duplicate required tags must be removed before SQL execution.

### Representative benchmark dataset

Create a deterministic PostgreSQL fixture with at least 100,000 semantic rows across at least 100 tenants. Include:

- one rare tag around 0.1% selectivity;
- one medium tag around 1% selectivity;
- one common tag above 25% selectivity;
- overlapping pairs and triples;
- rows with empty tag arrays;
- legacy-null rows only in migration fixtures;
- equal `updated_at` values to test key tie-breaking;
- JSON and entity-aligned rows.

Run `ANALYZE` before plan assertions.

### Performance gates

1. A deterministic structural test proves that the canonical index is valid, uses GIN `array_ops`, and supports the `@>` operator. A separate controlled representative benchmark demonstrates planner selection for a rare-tag query; planner selection is performance evidence, not the sole correctness gate.
2. Query plans show the containment predicate below `Limit` semantically, with no application-side tag filtering.
3. A 100-result query with entity alignment uses no more than two SQL query round trips after capability/preflight work.
4. All-of latency must be reported against the existing single-tag baseline at rare, medium, and common selectivity. Any p95 regression above 25% for equivalent single-tag semantics requires explanation or optimization before release.
5. Plan tests must not assert one exact full plan string. Assert index identity/scan nodes and semantic placement robustly enough to tolerate planner cost changes. A diagnostic with `enable_seqscan = off` may prove operator/index compatibility but cannot satisfy the primary benchmark gate.
6. Production rollout dashboards must separate deterministic queries, random queries, and residual-filter queries.

Absolute millisecond gates should be set from the CI PostgreSQL baseline rather than invented in the contract. Store benchmark environment details with results.

## Telemetry and Observability

Emit one completion metric/event per semantic collection query and predicate removal. Suggested fields:

```ts
type SemanticQueryTelemetry = {
    operation: 'read' | 'remove';
    backendKind: 'sql' | 'mlo' | 'custom';
    /** Optional stable keyed hash; never a raw custom backend name or metric label. */
    backendIdHash?: string;
    queryMode: 'id' | 'pattern' | 'structured';
    requiredTagCount: number;
    hasFilters: boolean;
    hasEntityFilters: boolean;
    random: boolean;
    requestedLimit: number;
    resultCount: number;
    durationMs: number;
    databaseDurationMs?: number;
    alignmentBatchQueries?: number;
    residualFilter: boolean;
    residualPages?: number;
    residualPageSize?: number;
    scannedRows?: number;
    compatibilityPath?: 'legacy-object-remove' | 'predicate-remove';
    outcome: 'ok' | 'error';
    errorCode?: string;
};
```

Telemetry MUST NOT include:

- raw or normalized tag values;
- semantic values;
- filter values;
- database URLs;
- tenant IDs;
- unbounded key lists.

`backendKind` and framework-owned error codes are bounded identifiers. Custom backend names are user-controlled and MUST NOT become metric labels. When instance-level correlation is necessary, emit a stable keyed hash as event metadata with bounded length and rotation documented by the telemetry implementation; do not emit the raw name. If key-level operator events remain necessary, keep them in the existing observer path and do not expand new query telemetry with keys.

### Deployment checks and alert thresholds

Within the first five minutes after migration and application rollout, operators MUST verify:

- the migration is recorded as applied and the canonical index is `indisvalid = true` and `indisready = true`;
- a tenant-scoped plural-tag smoke query returns only matching rows with stored tags;
- the unsupported-capability and envelope-mutation error rates are zero for framework-owned SQL/MLO backends;
- downstream host flags remain disabled until these checks pass.

During the first hour, compare against the captured pre-release baseline and alert when any of the following holds for two consecutive five-minute windows with at least 100 relevant operations:

- deterministic tag-query p95 exceeds the equivalent single-tag baseline by more than 25%;
- semantic query error rate exceeds 1%, excluding deliberate unsupported custom-backend calls;
- `SEMANTIC_QUERY_SCAN_BUDGET_EXCEEDED` exceeds 0.1% of structured reads;
- database pool wait p95 exceeds 100 ms or pool saturation exceeds 90%;
- removal contention exhaustion occurs more than once;
- database write latency or replication lag exceeds the deployment's existing rollback threshold after index creation.

The operator also reviews scanned-row distributions, residual page counts, GIN index size/usage, index-write overhead, and tenant-isolation smoke results. Thresholds inherited from platform SLOs must be linked in the release runbook; the concrete defaults above apply when no stricter platform threshold exists.

## Testing Strategy

### Type and source-compatibility tests

- A pre-feature custom backend without `capabilities` still type-checks.
- Existing mutable tag-array inputs and result handling still type-check.
- Existing single-tag custom backends continue receiving `tag` after normalization.
- A backend capability declaration cannot claim false/partial shapes.
- `SemanticItem<MyType>` preserves the value generic.
- Duplicative memory-sql types cannot drift from shared package types.

### Tag normalizer unit tests

- lowercase and trim behavior remains unchanged;
- `tag` and `tags` combine in first-occurrence order;
- duplicates across both fields collapse;
- `tags: []` means no restriction;
- a blank singular tag and an all-blank non-empty plural array fail;
- blank entries mixed with valid plural tags are removed compatibly;
- non-string runtime entries fail;
- raw count is bounded before full allocation/copy;
- distinct normalized count is bounded;
- UTF-8 byte count, not JavaScript code-unit count, enforces length;
- multi-byte tags test the boundary exactly;
- normalization is idempotent;
- errors contain counts/limits but not tag text.

### Real registry tests

Replace the copied facade in `packages/core/tests/semanticMemory.test.ts` with tests that instantiate the real `SemanticMemoryRegistry` or the canonical `createMemoryRegistry` using a controlled backend.

Required cases:

- no-filter read;
- no-filter capable and legacy calls send neither `tag` nor `tags`;
- single `tag` down-conversion sends only `tag` to a legacy backend;
- a capable backend receives only canonical `tags`, including for one normalized requirement;
- no prepared backend call contains both `tag` and `tags`;
- mixed `tag + tags` union;
- duplicate normalization;
- tag/filter/limit forwarding;
- tag predicate is never reapplied after backend limit;
- unsupported multi-tag backend throws before calling `read`;
- unknown backend throws a typed error;
- missing backend `read`/`remove` throws rather than returning empty success;
- SQL-capable backend returns stored tags unchanged;
- legacy backend may omit stored tags for compatible single-tag reads;
- exact-ID invalid combinations fail;
- exact-ID input order and limit remain stable;
- `orderBy + random` fails;
- `limit: 0` short-circuits;
- strict `removeItems` rejects an empty selector, returns `removedCount`, propagates failures, and requires predicate-removal capability for every structured filter;
- deprecated object `removeItem` delegates to strict removal when capable and discards only the count;
- deprecated legacy best-effort and predicate-function paths emit the documented compatibility/deprecation signal;
- operator events remain compatible.

MLO wrapper tests MUST prove that:

- the exact immutable tenant, backend, required tags, authorization filters, ordinary filters, limit, ordering, and random mode reach the wrapped adapter unchanged;
- an observation-only processor can add advisory metadata without changing structural input;
- attempted removal, replacement, broadening, or mutation of each protected field throws `SEMANTIC_QUERY_ENVELOPE_MUTATED` before adapter I/O;
- a wrapper does not advertise query or removal capability when it cannot preserve that contract.

### SQL adapter unit tests

Where query construction is unit-tested, assert parameter arrays and closed SQL fragments rather than broad snapshots. Required coverage:

- containment uses one `text[]` parameter;
- tenant is always bound independently;
- limit is a parameter;
- default order has the key tie-breaker;
- result mapper returns stored tags for every branch;
- null tags map to an empty array during compatibility;
- alignment batching uses one query for multiple keys;
- residual page size follows `min(1_000, max(100, requestedLimit * 4))`;
- residual cursors match both ordering directions and timestamp/key tie-breakers without offset;
- residual scan applies caller limit after matching, trims the last page to the remaining budget, and never returns partial results on budget exhaustion;
- residual budget exhaustion is classified non-transient and telemetry contains no predicate values;
- random plus a non-SQL residual predicate throws the typed combination error;
- deletion SQL selects by requested priority, locks by key ascending, rechecks the predicate, and honors limit.

### PostgreSQL correctness integration tests

Use `MEMORY_DATABASE_URL` and independent `MemorySQLAdapter` instances where concurrency matters.

Seed records whose newest limited rows do not contain all requested tags, while older rows do. Prove:

- `tags: ['a', 'b']` returns the older true matches instead of filtering a limited `a` page to empty;
- mixed `tag: 'a', tags: ['b']` requires both;
- mixed tags and JSON filters all apply before limit;
- stored tags are returned by simple, Prisma/raw filter, pattern, random, and entity-aware paths;
- normalized case and whitespace match stored normalized tags;
- duplicate requested tags do not change results;
- empty tag array does not filter;
- tenant A never sees tenant B rows with identical key/value/tags;
- deterministic ordering resolves timestamp ties by key;
- random results still satisfy every predicate;
- query limit maximum is enforced;
- entity/hybrid residual paths do not silently under-return.

### PostgreSQL removal concurrency tests

- Requested removal limit is honored exactly.
- A row that loses a required tag before the remover locks it survives.
- A row that gains the required tags after a candidate snapshot is not deleted unless it satisfies the authoritative deleting predicate.
- Tenant A removal cannot affect tenant B.
- Alignment rows for deleted memories are removed in the same transaction.
- An injected alignment-cleanup failure rolls back memory deletion.
- Two concurrent removers never report more deleted rows than exist.
- Concurrent removers using opposite requested order still acquire overlapping locks by key ascending.
- Injected `40P01` and `40001` failures retry the whole transaction at most twice and re-evaluate selection.
- Retry exhaustion throws `SEMANTIC_REMOVE_CONTENTION`; unrelated SQL and connection errors are not retried by the contention policy.
- Empty removal, `tags: []` alone, and objects containing only backend/limit/order fields are rejected.
- Strict `removeItems` returns the exact number of memory rows, independent of alignment-row count.
- Predicate-function removal remains explicitly tested as non-atomic compatibility behavior.

### CAS-pair integration tests

The host acceptance sequence must also exist at framework level:

1. write a record with `['record:test', 'state:queued']`;
2. query both tags and read the complete tag set;
3. read its CAS version;
4. run two concurrent CAS claims with replacement tags `['record:test', 'state:claimed']`;
5. assert one `updated` and one `conflict`;
6. assert the row disappears immediately from the old tag query;
7. assert it appears immediately in the new tag query;
8. assert value and tags correspond to the same winner;
9. assert another tenant cannot query or claim it.

### Migration tests

- The committed Phase 0 decision record names one aligned Prisma patch line and the tested migration owner.
- Fresh database replays the full migration history.
- A database with existing populated semantic rows builds the index without data changes.
- Legacy null tags become empty arrays.
- The default and non-null invariant apply to new rows.
- The canonical index is GIN, valid, ready, non-partial, and uses the array operator class.
- The migration does not run `CREATE INDEX CONCURRENTLY` inside a transaction.
- An intentionally interrupted/failed build is detected as invalid.
- Recovery drops the invalid canonical object, resolves migration state, and succeeds on retry.
- A valid wrong-definition index with the canonical name fails closed.
- A legacy `idx_memory_tenant_tags` index is detected without blocking canonical creation.
- Prisma fresh/shadow replay succeeds on the exact locked version.
- A large-null fixture exercises resumable bounded backfill, checkpoint restart, timeouts, and abort visibility rather than an unbounded update.

### Query-plan tests

- Load the representative dataset and run `ANALYZE`.
- Structurally verify the canonical GIN `array_ops` definition and `@>` compatibility independently of planner choice.
- In a controlled analyzed benchmark, assert a rare all-of query chooses `agent_memory_store_tags_gin_idx` under normal planner settings.
- Assert tenant scoping is present in the plan and result verification.
- Capture `EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON)` for rare, medium, and common distributions.
- Do not force `enable_seqscan = off` in the primary acceptance test. A secondary diagnostic test may use it only to prove operator/index compatibility.
- Record planning time, execution time, actual rows, rows removed by filter, shared buffer hits/reads, and chosen indexes.

### CI requirements

The real PostgreSQL suite must be a required CI job on the supported Node version. A fake-only job cannot prove SQL containment, query plans, tenant isolation, concurrent migration behavior, or CAS races.

The job must run at least:

```bash
yarn workspace @a2arium/callagent-utils test
yarn workspace @a2arium/callagent-types build
yarn workspace @a2arium/callagent-memory-sql build
yarn workspace @a2arium/callagent-memory-engine test
MEMORY_DATABASE_URL="$CI_MEMORY_DATABASE_URL" yarn workspace @a2arium/callagent-memory-sql test
yarn workspace @a2arium/callagent-core test
```

Exact scripts may be adjusted to the package's real commands. Do not document a command as verified until it is run successfully in the implementation PR.

## Documentation Requirements

Update the semantic-memory API reference with:

- all-of semantics;
- `tag` compatibility sugar;
- mixed `tag + tags` behavior;
- normalization and bounds;
- complete stored tags in SQL collection results;
- capability detection and typed errors for custom backends;
- exact capable/legacy backend wire shapes and the MLO protected-envelope boundary;
- exact-ID metadata exception;
- deterministic ordering and `random` cost;
- strict `removeItems`, exact result counts, atomic predicate-removal guarantees, and deprecated overload limitations;
- residual-scan bounds, non-transient budget errors, and unsupported combinations;
- tags-as-candidates guidance;
- CAS replacement-tag semantics.

Update PostgreSQL/operator documentation with:

- canonical index name and definition;
- doctor/preflight usage;
- concurrent deployment ordering;
- invalid-index recovery;
- legacy index handling;
- query-plan verification examples;
- safe rollback steps.

The operator runbook MUST include the five-minute and first-hour verification checklist, default alert thresholds, null-backfill pause/resume procedure, and links to platform-specific database/replication rollback thresholds.

Add a concise migration note to the package changelog. Link this specification and the CAS specification from the implementation PR.

## Alternatives Considered

### Fetch one tag, then filter plural tags in memory

Rejected. A backend limit can discard true matches before the facade sees them. Overfetching by a fixed multiplier only changes which datasets fail and creates unbounded tuning pressure.

### Send repeated single-tag predicates to every legacy backend

Rejected. A backend-neutral contract cannot assume that a custom backend can combine repeated predicates atomically or before its own limit. Capability detection makes the semantic boundary explicit.

### Use repeated `$tag = ANY(tags)` clauses in PostgreSQL

Rejected as the canonical shape. Repeated clauses can express all-of behavior, but `tags @> requiredTags` maps directly to the public contract, takes one bounded array parameter, and is supported by the intended GIN operator class.

### Use one composite GIN index for tenant and tags

Rejected as the default. `tenant_id` has a normal B-tree index, PostgreSQL can combine indexes, and a scalar tenant column in GIN adds operator-class/extension complexity. A future benchmark may justify a different physical design without changing API semantics.

### Use `CREATE INDEX IF NOT EXISTS`

Rejected for the authoritative migration. A matching name does not establish matching definition or validity, and a failed concurrent build may leave an invalid object that `IF NOT EXISTS` skips.

### Make plural tags mandatory for every backend immediately

Rejected for compatibility. Existing single-tag backends remain useful. One normalized requirement can down-convert to `tag`; two or more require a truthful capability.

### Return only the requested tags

Rejected. Users need the complete stored set for diagnostics, validation, lifecycle transitions, and replacement-tag derivation. Requested tags are a predicate, not a projection.

### Add metadata to exact-key `get()` now

Deferred. Changing `get()` from value-only to an envelope would be broadly breaking. A future metadata-aware bulk-get capability is cleaner and does not block correct collection queries.

### Treat tags as authoritative workflow state

Rejected. Tags can be stale, malformed, or derived incorrectly. The reliable workflow is candidate discovery, value validation, authoritative-state verification, and CAS claim.

### Change the existing overloaded `removeItem` in place

Rejected. Silently turning a historically best-effort/void overload into a counted strict operation would create confusing compatibility claims and ambiguous call sites. The additive `removeItems(filter)` API makes safety and cardinality visible, while deprecated overloads provide a time-bounded migration path.

## Rollout Plan

### Phase 0: blocking inventory and migration decision

- Inventory stored tag counts, byte lengths, nulls, table/index sizes, replication constraints, and existing index definitions.
- Run and commit the Prisma compatibility decision described above, including exact versions and migration ownership.
- Record null-backfill batch size, timeouts, checkpointing, small-table threshold, and abort conditions.
- Capture single-tag latency, query-count, pool-wait, write-latency, and replication-lag baselines.
- Confirm the real PostgreSQL CI job is required, not optional.

### Track A rollout: contract and registry

- Add shared types, constants, normalizer, capability metadata, error types/class ownership, and `removeItems`.
- Implement immutable query preparation, exact backend wire shapes, and backend resolution.
- Remove post-limit facade tag filtering and silent `[]`, `0`, or swallowed-error behavior.
- Preserve the deprecated compatibility overloads without representing them as strict.
- Replace mirrored facade tests with real registry and source-compatibility tests.

### Track B rollout: SQL and MLO correctness

- Unify SQL query preparation and add containment to every structured path.
- Enforce the MLO protected-envelope boundary.
- Parameterize limits and allowlisted ordering.
- Add shared result mapping with stored tags.
- Implement the exact keyset residual algorithm and typed failure behavior.
- Pass real correctness, MLO-mutation, residual, and tenant-isolation tests.

### Track C rollout: production index

- Follow the committed Phase 0 ownership decision.
- Harden legacy null tags with bounded resumable work.
- Add the verified Prisma GIN schema declaration and customized concurrent migration/operator step.
- Add doctor/preflight and recovery documentation; update the legacy optimization script.
- Pass fresh, shadow, populated, failed-build, collision, and structural index tests.

### Track D rollout: removal safety

- Implement strict predicate-rechecked `removeItems`.
- Select candidates by requested priority and acquire locks by canonical key order.
- Add bounded contention retries and transactional alignment cleanup.
- Pass capability, result-count, race, rollback, deadlock-order, and retry-exhaustion tests.

### Track E rollout: performance, release, and observation

- Batch entity alignments and remove remaining interpolated limits/N+1 behavior in touched query paths.
- Land the representative benchmark, required PostgreSQL CI, telemetry, dashboards, docs, and runbook.
- Publish packages in dependency order, apply the migration, and run the five-minute and first-hour checks before enabling downstream sweeps.
- Compare p95 latency, scan distributions, index size, write overhead, pool wait, and replication lag with baseline.

### Downstream enablement

- Upgrade `itupdated` to the coordinated released package set and apply the migration in each environment.
- Backfill derived lifecycle tags.
- Enable candidate discovery and CAS claims behind a host rollout flag only after framework and migration checks pass.
- Run the full host acceptance and existing SiteConfig PostgreSQL concurrency suite.

## Rollback Plan

Application rollback is safe because the new schema fields and index are additive and old single-tag code can continue reading the table.

1. Disable downstream plural-tag sweeps.
2. Roll back application packages to the prior release.
3. Keep the valid GIN index during incident diagnosis; it does not change query results.
4. If index write/storage overhead is the confirmed cause, drop only the verified canonical index with `DROP INDEX CONCURRENTLY` in a separate operator action.
5. Do not revert normalized stored tags or reintroduce nulls.
6. Do not remove the CAS version schema while downstream data may contain CAS-issued generations.

Rollback documentation must identify exact migration names and package versions after implementation.

## Security and Reliability Review

- Tenant identity comes from trusted adapter context, never tags.
- All values, tags, tenant IDs, keys, limits, and filter values are parameters.
- Dynamic SQL fragments come only from closed allowlists.
- Tag/error telemetry excludes user-controlled text.
- Query and tag bounds reduce accidental or hostile resource amplification.
- Unsupported capability paths fail before database I/O.
- MLO and middleware cannot weaken tenant, authorization, tag, filter, limit, backend, or ordering fields after registry validation.
- Random ordering is visible in telemetry because it can create expensive sorts.
- Strict removal rechecks predicates, locks rows in canonical order, bounds contention retries, and runs alignment cleanup transactionally.
- Tags never authorize an external action without value validation and CAS claim.
- A malformed candidate must not block later candidates in downstream sweeps.

## Downstream `itupdated` Requirements After Framework Release

The framework implementation does not complete host behavior. `itupdated` must:

1. upgrade to the released CallAgent package set and apply the tag-index migration;
2. centralize pure `deriveSourceControlTags(record)` and `deriveProposalTags(record)` functions;
3. replace the complete derived tag set on every ordinary write and successful CAS transition;
4. namespace identifiers such as `site:<siteId>` instead of using raw IDs as generic tags;
5. backfill legacy SiteConfig proposal records with lifecycle tags;
6. reconcile time-based expiry from authoritative timestamps;
7. implement the source-control state machine and CAS claim protocol;
8. recover stale claims and prevent duplicate external actions;
9. treat tag results as candidates, parse and validate values, verify authoritative state, then CAS-claim;
10. use deterministic sweep ordering or pagination;
11. quarantine malformed candidates so one bad record cannot starve later work;
12. prove tenant isolation and preserve the existing SiteConfig activation concurrency suite.

Suggested host tag vocabulary:

```text
record:source-control
record:proposal
state:queued
state:claimed
state:ready-for-approval
state:expired
site:<siteId>
```

The framework does not reserve these values. The host owns its vocabulary and lifecycle invariants.

## End-to-End Host Acceptance

The release is not accepted by the requesting host until this sequence passes against real PostgreSQL:

```text
write record
  -> query action tags
  -> validate stored value
  -> read CAS generation
  -> race two CAS claims
  -> observe exactly one winner
  -> verify old tag query no longer finds the record
  -> verify new tag query finds the winner's value and tags
  -> perform the external action only from the winning claim
```

Required host verification:

- action-tag discovery;
- immediate old/new tag visibility after CAS;
- two competing claimers with exactly one winner;
- SiteConfig lifecycle discovery;
- expired proposal reconciliation;
- backfilled legacy records;
- malformed-candidate quarantine;
- stale-claim recovery;
- duplicate-action protection;
- tenant isolation;
- existing SiteConfig activation PostgreSQL concurrency tests.

## File-by-File Implementation Plan

| Track | File or area | Change |
|---|---|---|
| A | `packages/types/src/IMemory.ts` and error types | Add plural backend query input, result tags, generic semantic item, `SemanticRemoveResult`, strict method contract, capabilities, and stable error-code/metadata types |
| A | `packages/utils/src/tagNormalization.ts` and `SemanticQueryError` module | Add canonical normalizer, shared bounds, byte/count validation, and the runtime error class without unsafe metadata |
| A | Utils/type tests | Add combination, invalid-input, UTF-8, bounds, idempotence, source-compatibility, and public re-export tests |
| A | `packages/memory-engine/src/types/semantic/SemanticMemoryRegistry.ts` | Immutable preparation, exact capable/legacy wire shape, capability checks, backend resolver, `removeItems`, deprecated overload routing, no post-limit filtering, and result preservation |
| A | Registry/core semantic tests | Delete the copied facade and exercise the canonical registry/factory, strict removal contract, errors, and compatibility overloads |
| B | `packages/memory-engine/src/MLOBackends.ts` | Advertise only end-to-end capabilities and preserve the protected structural envelope |
| B | `packages/memory-engine/src/UnifiedMemoryService.ts` | Prevent retrieval/removal processing from weakening or replacing tenant, backend, predicates, limits, or ordering; reject protected mutation |
| B | MLO/UnifiedMemoryService tests | Prove observation-only processing and reject mutation of every protected field before adapter I/O |
| B | `packages/memory-sql/src/types.ts` | Remove or alias duplicate shared query/result contracts |
| B/E | SQL query compiler, mapper, and `MemorySQLAdapter.ts` | Canonical containment, predicate ordering, parameterized limits, stored-tag mapping, exact residual keyset scan, capabilities, and alignment batching |
| C | `apps/docs/todo/<semantic-tag-query-prisma-decision>.md` | Record exact aligned versions, ownership, replay results, failure recovery, and the blocking Phase 0 decision |
| C | `packages/memory-sql/prisma/schema.prisma` | Declare the verified canonical GIN index and final tags invariant |
| C | `<tag-null-hardening>/migration.sql` plus operator backfill | Normalize null tags with timeouts, bounded resumable batches, validation, and safe invariant enforcement |
| C | `<tag-index-concurrently>/migration.sql` or decided operator step | Build the canonical tags GIN index concurrently under the Phase 0 ownership model |
| C | SQL optimization script and index doctor | Replace the noncanonical composite index, classify real definitions, and support documented inspection/recovery |
| C/E | Migration and query-plan integration tests | Test fresh/shadow/populated replay, resumable backfill, invalid recovery, collisions, index structure, and controlled plan behavior |
| D | SQL removal module/adapter path | Implement selected-priority/canonical-lock-order deletion, full predicate recheck, alignment transaction, exact result count, and bounded contention retry |
| D | Removal integration/concurrency tests | Prove limits, races, tenant isolation, rollback, lock order, retry policy, and contention exhaustion |
| B/D | `packages/memory-sql/tests/MemorySQLAdapter.integration.test.ts` | Add query correctness, result tags, tenant, residual, strict removal, and CAS-pair cases |
| E | `.github/workflows/ci.yml` | Make real PostgreSQL correctness, concurrency, migration, and plan suites required |
| E | Semantic-memory docs, runbook, telemetry, dashboards, and changelog | Document API behavior, MLO trust boundary, migration/recovery, alerts, operational checks, and downstream handoff |

Implementation may split `MemorySQLAdapter.ts` into query compiler, row mapper, and removal modules if that lowers risk. A split must preserve the package's public entry points and should be mechanical before semantic changes, or performed in small reviewable commits.

## Release and Package Order

Publish linked workspace packages in dependency order:

1. `@a2arium/callagent-types`;
2. `@a2arium/callagent-utils` if the normalizer is exported there;
3. `@a2arium/callagent-memory-sql`;
4. `@a2arium/callagent-memory-engine`;
5. `@a2arium/callagent-core` and aggregate CallAgent packages.

The release note must list:

- exact package versions;
- migration directory names;
- minimum verified PostgreSQL and Prisma versions;
- capability metadata shape;
- typed error codes;
- operator preflight and recovery commands;
- downstream enablement order.

## Acceptance Criteria

1. Existing custom semantic backends compile without adding capability fields.
2. Existing single-tag queries retain their behavior after normalization.
3. `tag` plus `tags` always means the normalized all-of union.
4. Capable backend calls contain only canonical `tags`; legacy single-tag calls contain only `tag`; prepared calls never contain both.
5. A backend that cannot honor two or more required tags throws a typed error before I/O.
6. MLO and middleware cannot mutate tenant scope, backend, tags, filters, authorization filters, limit, order, or random mode; attempts fail before backend I/O.
7. PostgreSQL evaluates `tags @> requiredTags` before ordering and limit in every structured query path.
8. SQL collection results contain the complete stored tag set.
9. No facade filters tags after backend limit.
10. Residual queries use the specified keyset algorithm and return a complete limited result or a non-transient typed budget error, never a silent partial result.
11. Default limited ordering is deterministic with a key tie-breaker.
12. Limits and data values are parameterized and bounded.
13. Entity alignment adds at most one batch query per collection result set.
14. Strict `removeItems` rejects empty selectors, returns an exact count, honors limit, locks rows canonically, and rechecks its predicate in the deleting statement.
15. Strict and single-key removal errors are observable and not swallowed; contention retries are bounded and typed.
16. Deprecated removal overloads remain source-compatible for the stated cycle, are explicitly non-strict, and expose sanitized usage/failure telemetry where compatibility still swallows errors.
17. Semantic CAS atomically replaces value and tags, with immediate old/new query visibility.
18. The committed Phase 0 record proves one aligned Prisma version and migration ownership model before schema work.
19. The canonical tags-only GIN index exists, is structurally valid, supports `@>`, and is demonstrated in a controlled selective plan.
20. The concurrent migration has tested invalid-index recovery and wrong-definition collision behavior.
21. Legacy null tag arrays are migrated with bounded resumable work and map consistently during rollout.
22. Real PostgreSQL tests prove correctness, tenant isolation, removal races, CAS races, migrations, and query plans.
23. Query telemetry uses bounded backend dimensions and contains no backend names, tag values, semantic values, filters, or tenant IDs.
24. The five-minute and first-hour operational checks meet their release thresholds.
25. Public and operator documentation describe semantics, bounds, errors, migration, recovery, and tags-as-candidates guidance.
26. The downstream host acceptance sequence proves one concurrent claimer performs the action.

## Definition of Done

This request is done only when all of the following are true:

- public contracts and capabilities are released;
- all required delivery tracks and their explicit release gates are complete;
- all SQL paths use canonical semantics;
- MLO paths preserve the protected query envelope;
- result metadata is preserved;
- strict tag-based removal is predicate-rechecked and concurrency-tested;
- the Phase 0 migration decision is committed and satisfied;
- the concurrent index migration is applied and verified in a production-like database;
- required real PostgreSQL CI is green;
- performance baselines and plan artifacts are attached to the implementation PR;
- documentation and changelog are published;
- released package versions and migration steps are handed to `itupdated`;
- the host acceptance test passes without an in-memory post-limit workaround.

## Deferred Follow-Ups

These are useful but not blockers for this release:

- metadata-aware exact-key bulk reads that always return stored tags;
- cursor/keyset pagination in the public semantic query API;
- any-of and boolean tag expressions;
- tag vocabulary/schema registration;
- optimized random sampling;
- deeper SQL-native compilation for every entity expression if the bounded residual path remains necessary;
- background index-health monitoring beyond deployment doctor checks.

## References

- [PostgreSQL index types: GIN array operators](https://www.postgresql.org/docs/current/indexes-types.html)
- [PostgreSQL bitmap combination of multiple indexes](https://www.postgresql.org/docs/current/indexes-bitmap-scans.html)
- [PostgreSQL `CREATE INDEX` and concurrent-build caveats](https://www.postgresql.org/docs/current/sql-createindex.html)
- [Prisma index access methods and `ArrayOps`](https://docs.prisma.io/docs/orm/prisma-schema/data-model/indexes)
- [Prisma custom migration workflow](https://docs.prisma.io/docs/orm/prisma-migrate/workflows/unsupported-database-features)
- [Prisma production migration guidance](https://www.prisma.io/docs/orm/prisma-client/deployment/deploy-database-changes-with-prisma-migrate)
