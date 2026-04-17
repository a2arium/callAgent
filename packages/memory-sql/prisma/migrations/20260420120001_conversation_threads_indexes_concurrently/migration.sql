-- Phase 3: replace lifecycle indexes (same definitions as 20260418120000).
--
-- Note: `CREATE/DROP INDEX CONCURRENTLY` cannot run inside Prisma Migrate's transaction,
-- so this migration uses plain DDL. For very large `conversation_threads` tables in
-- production, operators may rebuild these indexes with CONCURRENTLY out-of-band if needed.

DROP INDEX IF EXISTS "conversation_threads_tenant_id_status_expires_at_idx";
CREATE INDEX "conversation_threads_tenant_id_status_expires_at_idx"
    ON "conversation_threads" ("tenant_id", "status", "expires_at");

DROP INDEX IF EXISTS "conversation_threads_tenant_id_status_closed_at_idx";
CREATE INDEX "conversation_threads_tenant_id_status_closed_at_idx"
    ON "conversation_threads" ("tenant_id", "status", "closed_at");
