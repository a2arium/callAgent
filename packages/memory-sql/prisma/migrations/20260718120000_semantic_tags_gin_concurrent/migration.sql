CREATE INDEX CONCURRENTLY "agent_memory_store_tags_gin_idx"
    ON "agent_memory_store"
    USING GIN ("tags" array_ops);
