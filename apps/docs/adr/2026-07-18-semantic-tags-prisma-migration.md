# ADR: Prisma owns the semantic-tags GIN migration

- **Date:** 2026-07-18
- **Status:** Accepted
- **Decision:** Keep Prisma migration history authoritative and align Prisma CLI, client, and PostgreSQL adapter at exactly 7.4.0.

## Context

Semantic tag queries need a PostgreSQL GIN `array_ops` index built with `CREATE INDEX CONCURRENTLY`. Prisma can declare the GIN index, but its schema cannot express `CONCURRENTLY`; therefore generated SQL must be reviewed and customized. Mixing operator-managed DDL with unrecorded Prisma state would make drift and recovery harder to reason about.

## Compatibility spike

The repository and lockfile resolve `prisma`, `@prisma/client`, and `@prisma/adapter-pg` to 7.4.0. In an isolated PostgreSQL 16 + pgvector database, the complete 34-migration history replayed successfully, the dedicated concurrent index migration applied outside an explicit transaction, generated-client build succeeded, and the shadow/`migrate dev` workflow did not propose an additional tag index. The migration SQL checksum is `58dce339ff07ccfe5a645ce29ae683ed99df0244d461c8527d962c40261fadc0`. The post-deploy doctor classified the fresh index as valid and ready with GIN `array_ops`.

The schema declaration is:

```prisma
@@index([tags(ops: ArrayOps)], type: Gin, map: "agent_memory_store_tags_gin_idx")
```

The authoritative migration contains only:

```sql
CREATE INDEX CONCURRENTLY "agent_memory_store_tags_gin_idx"
    ON "agent_memory_store"
    USING GIN ("tags" array_ops);
```

## Recovery model

The read-only doctor classifies the canonical name as absent, valid-canonical, invalid-canonical, or a wrong-definition collision. An invalid canonical build is recovered by inspecting the failure, running `DROP INDEX CONCURRENTLY IF EXISTS "agent_memory_store_tags_gin_idx"`, marking only the failed migration rolled back with `prisma migrate resolve --rolled-back 20260718120000_semantic_tags_gin_concurrent`, rerunning deploy, and verifying with the doctor. A valid wrong-definition collision fails closed and is never dropped automatically.

## Rejected alternative

An operator-owned index outside Prisma migration history was rejected. It avoids customizing generated SQL but creates two schema authorities, makes fresh replay incomplete, and increases the chance that later Prisma development reports or removes the index as drift.

## Consequences

- Linked Prisma packages are exact-pinned at 7.4.0.
- The null/default invariant is hardened in a preceding migration.
- Concurrent index DDL stays isolated in its own migration without `BEGIN`, `COMMIT`, or `IF NOT EXISTS`.
- Deployment must run the tag index doctor before enabling plural-tag consumers.
