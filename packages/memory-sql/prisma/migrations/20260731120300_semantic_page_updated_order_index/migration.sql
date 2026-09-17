-- If this concurrent build is interrupted, PostgreSQL can leave an INVALID
-- index. Drop that exact index, mark only this migration rolled back, and
-- redeploy. Do not add IF NOT EXISTS: retry must fail closed on invalid state.
CREATE INDEX CONCURRENTLY "agent_memory_store_tenant_updated_key_idx"
    ON "agent_memory_store" ("tenant_id", "updated_at", "key");
