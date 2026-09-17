# Semantic-memory tag-query operations

## Deployment

1. Keep downstream plural-tag consumers disabled.
2. Inventory `agent_memory_store`: row count, null tag rows, maximum tag count and byte length, table/index size, replication lag, and existing tag-index definitions.
3. If null tag rows exceed 10,000, run `yarn workspace @a2arium/callagent-memory-sql db:tags:backfill` before migration. It commits tenant/key-ordered batches, records its checkpoint and cumulative count in `callagent_migration_progress`, and is safe to rerun. Set `SEMANTIC_TAG_BACKFILL_BATCH_SIZE` only within the reviewed 1–10,000 range. Stop on lock timeout, statement timeout, replication-lag threshold, or unexpected row growth.
4. Run `yarn workspace @a2arium/callagent-memory-sql db:migrate`.
5. Run `yarn workspace @a2arium/callagent-memory-sql db:tags:doctor`. Continue only for `valid-canonical` with `valid: true`, `ready: true`, access method `gin`, column `tags`, and operator class `array_ops`.
6. Run `ANALYZE agent_memory_store` when statistics are stale, then smoke-test a tenant-scoped all-of query and confirm complete stored tags are returned.
7. Enable consumers gradually and watch deterministic/random query latency, error codes, pool wait, removal contention, replication lag, and GIN usage.

The null-hardening migration automatically backfills at most 10,000 null rows under a five-second lock timeout and five-minute statement timeout. Above that threshold it stops visibly before the update. The default becomes an empty text array and the final column invariant is `NOT NULL`.

## Index doctor outcomes

- `absent`: do not enable consumers; run or repair the migration.
- `valid-canonical`: safe to proceed after the semantic smoke test.
- `invalid-canonical`: investigate disk/activity failure, then use the recovery flow below.
- `name-collision-wrong-definition`: fail closed and escalate. Do not automatically drop an operator-created valid index.

The doctor also reports the legacy `idx_memory_tenant_tags` object when present. The canonical design is tags-only; it does not require `btree_gin`.

## Failed concurrent build recovery

1. Inspect PostgreSQL logs, free space, blocking activity, and the doctor output.
2. Confirm the invalid object has the canonical definition.
3. Run `DROP INDEX CONCURRENTLY IF EXISTS "agent_memory_store_tags_gin_idx"` outside a transaction.
4. If Prisma recorded the migration as failed, run `prisma migrate resolve --rolled-back 20260718120000_semantic_tags_gin_concurrent` against the same database.
5. Rerun migrate deploy and the doctor.
6. Verify a selective query using `EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON)`; planner choice is evidence, not query correctness.

## Application contract

`tag` plus `tags` is one normalized all-of requirement. Tags are candidates only: consumers must parse and validate the stored value, verify authoritative state, and CAS-claim before work. Never fetch a limited page and filter plural tags in memory. Use deterministic ordering or pagination for sweeps and quarantine malformed records so they cannot starve later candidates.

Use `removeItems` for tag and JSON-structured deletion. It selects by requested priority, locks in key order, rechecks the predicate while holding locks, removes alignments in the same transaction, and returns the number of memory rows removed. SQL entity-alignment predicates are discovery-only in this release; strict removal rejects them with `SEMANTIC_PREDICATE_REMOVE_UNSUPPORTED` during facade capability preflight. Deprecated object/predicate `removeItem` overloads do not provide the strict guarantee.
