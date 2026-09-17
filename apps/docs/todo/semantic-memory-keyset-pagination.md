# Feature Request: Semantic-Memory Keyset Pagination

## Status

**Required by the itupdated lifecycle scheduler.**

The scheduler must enumerate tenant-scoped, indexed semantic-memory candidates
without loading an unbounded result set or repeatedly returning only the first
limited page. The existing `readItems()` contract has ordering and limits but no
continuation token.

This request is additive. Existing APIs and custom backends must remain unchanged.

## Required Contract

Expose an optional page capability on the semantic-memory facade:

```ts
type SemanticReadPageFilter =
    Omit<SemanticReadFilter, "id" | "random" | "limit" | "orderBy"> & {
        cursor?: string;
        limit: number;
        orderBy?: {
            path: "createdAt" | "updatedAt";
            direction: "asc" | "desc";
        };
    };

type SemanticReadPage<T> = {
    items: SemanticItem<T>[];
    nextCursor?: string;
};

type SemanticMemoryFacade = ExistingSemanticMemoryFacade & {
    readItemsPage?<T = unknown>(
        filter: SemanticReadPageFilter,
    ): Promise<SemanticReadPage<T>>;
};
```

- Backends that do not support pagination expose no capability.
- The registry must not emulate a page by fetching an unbounded result set.
- Existing `readItems()` signatures and behavior remain unchanged.
- `limit` uses the existing semantic query limits.
- Exact-ID and random selectors are not stable collection traversals. Supplying
  either at runtime fails with `SEMANTIC_QUERY_INVALID_COMBINATION` rather than
  silently broadening the query.

## SQL Semantics

The SQL implementation must use keyset pagination, not offset pagination.

- Supported ordering is the existing `createdAt` or `updatedAt`, followed by the
  semantic key as a deterministic tie breaker.
- Apply tenant, all-of tags, structured filters, and the cursor predicate
  before ordering and limiting.
- Fetch `limit + 1` rows to determine whether a continuation exists.
- Return complete normalized stored tags.
- The cursor is opaque, versioned, JSON-safe, and bound to:
  - tenant;
  - selected backend;
  - normalized query;
  - ordering field and direction.
- A malformed, empty, whitespace-only, or non-string cursor returns
  `SEMANTIC_CURSOR_INVALID`.
- Reusing a cursor with a different query returns
  `SEMANTIC_CURSOR_QUERY_MISMATCH`.
- Cursor contents must not expose tenant identifiers, tag values, or arbitrary
  filter values in plaintext.
- Each concurrent index operation is a separate Prisma migration. Interrupted
  creates fail closed; recovery drops the exact invalid index, marks only the
  failed create migration rolled back, and redeploys it.

For ascending `createdAt`, the logical continuation is:

```sql
created_at > cursor.created_at
OR (created_at = cursor.created_at AND key > cursor.key)
```

Descending and `updatedAt` forms follow the equivalent comparison.

The cycle fence and every framework write path use UTC consistently even though
Prisma maps these columns to PostgreSQL `timestamp without time zone`. This
keeps normal and atomic writes comparable on non-UTC database sessions.

Updates that change membership may cause a record to be absent from the current
cycle or appear in a later cycle. Consumers still exact-read and CAS-claim every
candidate. The contract must guarantee deterministic forward progress and no
permanent starvation of unchanged matching rows.

## Tests

- Type compatibility for existing facades and custom backends.
- More than 1,000 matching rows paginate without duplicates or omissions.
- Equal ordering timestamps are ordered by key.
- All-of tags are applied before cursor and limit.
- Complete tags are returned on every page.
- Cursor/query, cursor/tenant, cursor/backend, and cursor/order mismatches fail.
- Malformed and tampered cursors fail closed.
- Concurrent insert, update, deletion, and tag replacement preserve forward
  progress across repeated cycles.
- A real PostgreSQL plan/correctness test uses the canonical tags GIN index.
- Tenant A can never continue or observe tenant B's page.

## Acceptance Criteria

1. Existing memory consumers compile and behave unchanged.
2. SQL provides bounded, deterministic keyset pages for indexed tag queries.
3. A 1,000-row PostgreSQL test completes through multiple pages.
4. Cursors are opaque, query-bound, and tenant-safe.
5. The capability is absent rather than emulated for unsupported backends.
