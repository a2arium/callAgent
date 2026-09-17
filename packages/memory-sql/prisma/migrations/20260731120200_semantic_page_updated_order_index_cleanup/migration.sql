-- See the paired create migration for the interrupted-build recovery path.
DROP INDEX CONCURRENTLY IF EXISTS "agent_memory_store_tenant_updated_key_idx";
