-- Prisma 7 executes a multi-statement migration transactionally. Keep every
-- concurrent index operation in its own migration because PostgreSQL forbids
-- DROP/CREATE INDEX CONCURRENTLY inside a transaction block.
DROP INDEX CONCURRENTLY IF EXISTS "agent_memory_store_tenant_created_key_idx";
