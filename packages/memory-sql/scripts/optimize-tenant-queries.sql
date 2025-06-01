-- Performance optimization script for multi-tenant memory system
-- Run this script to add additional indexes for improved tenant-scoped query performance

-- Create additional composite indexes for common query patterns
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_memory_tenant_updated_at 
    ON agent_memory_store (tenant_id, updated_at DESC);

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_memory_tenant_created_at 
    ON agent_memory_store (tenant_id, created_at DESC);

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_memory_tenant_tags 
    ON agent_memory_store USING GIN (tenant_id, tags);

-- Partial index for system tenant operations (if used frequently)
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_memory_system_tenant 
    ON agent_memory_store (key, updated_at DESC) 
    WHERE tenant_id = '__system__';

-- Index for pattern matching queries within tenant scope
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_memory_tenant_key_pattern 
    ON agent_memory_store (tenant_id, key text_pattern_ops);

-- Entity store optimizations
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_entity_tenant_type_name 
    ON entity_store (tenant_id, entity_type, canonical_name);

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_entity_tenant_updated 
    ON entity_store (tenant_id, updated_at DESC);

-- Entity alignment optimizations
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_alignment_tenant_entity 
    ON entity_alignment (tenant_id, entity_id);

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_alignment_tenant_confidence 
    ON entity_alignment (tenant_id, confidence);

-- Vector similarity search optimization (if using pgvector)
-- These require the pgvector extension to be installed
-- CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_memory_tenant_embedding_cosine 
--     ON agent_memory_store USING ivfflat (embedding vector_cosine_ops) 
--     WITH (lists = 100)
--     WHERE tenant_id IS NOT NULL AND embedding IS NOT NULL;

-- CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_entity_tenant_embedding_cosine 
--     ON entity_store USING ivfflat (embedding vector_cosine_ops) 
--     WITH (lists = 100)
--     WHERE tenant_id IS NOT NULL;

-- Analyze tables to update statistics for query planner
ANALYZE agent_memory_store;
ANALYZE entity_store;
ANALYZE entity_alignment;

-- Create a function to get tenant memory statistics
CREATE OR REPLACE FUNCTION get_tenant_memory_stats(tenant_id_param TEXT)
RETURNS TABLE(
    tenant_id TEXT,
    total_entries BIGINT,
    total_size_bytes BIGINT,
    avg_entry_size NUMERIC,
    oldest_entry TIMESTAMP,
    newest_entry TIMESTAMP,
    total_tags BIGINT,
    unique_tags BIGINT
) AS $$
BEGIN
    RETURN QUERY
    SELECT 
        tenant_id_param,
        COUNT(*) as total_entries,
        COALESCE(SUM(pg_column_size(value)), 0) as total_size_bytes,
        CASE 
            WHEN COUNT(*) > 0 THEN ROUND(SUM(pg_column_size(value))::NUMERIC / COUNT(*), 2)
            ELSE 0
        END as avg_entry_size,
        MIN(created_at) as oldest_entry,
        MAX(updated_at) as newest_entry,
        COALESCE(SUM(array_length(tags, 1)), 0) as total_tags,
        (SELECT COUNT(DISTINCT tag) 
         FROM agent_memory_store, unnest(tags) as tag 
         WHERE tenant_id = tenant_id_param) as unique_tags
    FROM agent_memory_store 
    WHERE tenant_id = tenant_id_param;
END;
$$ LANGUAGE plpgsql;

-- Create a function to get cross-tenant statistics (for system tenant)
CREATE OR REPLACE FUNCTION get_all_tenants_stats()
RETURNS TABLE(
    tenant_id TEXT,
    entry_count BIGINT,
    size_bytes BIGINT,
    last_activity TIMESTAMP
) AS $$
BEGIN
    RETURN QUERY
    SELECT 
        ams.tenant_id,
        COUNT(*) as entry_count,
        COALESCE(SUM(pg_column_size(ams.value)), 0) as size_bytes,
        MAX(ams.updated_at) as last_activity
    FROM agent_memory_store ams
    GROUP BY ams.tenant_id
    ORDER BY entry_count DESC;
END;
$$ LANGUAGE plpgsql;

-- Create a function to clean up orphaned entity alignments
CREATE OR REPLACE FUNCTION cleanup_orphaned_alignments(tenant_id_param TEXT DEFAULT NULL)
RETURNS INTEGER AS $$
DECLARE
    deleted_count INTEGER;
BEGIN
    IF tenant_id_param IS NULL THEN
        -- Clean up across all tenants
        DELETE FROM entity_alignment ea
        WHERE NOT EXISTS (
            SELECT 1 FROM agent_memory_store ams 
            WHERE ams.tenant_id = ea.tenant_id 
            AND ams.key = ea.memory_key
        );
    ELSE
        -- Clean up for specific tenant
        DELETE FROM entity_alignment ea
        WHERE ea.tenant_id = tenant_id_param
        AND NOT EXISTS (
            SELECT 1 FROM agent_memory_store ams 
            WHERE ams.tenant_id = ea.tenant_id 
            AND ams.key = ea.memory_key
        );
    END IF;
    
    GET DIAGNOSTICS deleted_count = ROW_COUNT;
    RETURN deleted_count;
END;
$$ LANGUAGE plpgsql;

-- Create a view for tenant health monitoring
CREATE OR REPLACE VIEW tenant_health_view AS
SELECT 
    t.tenant_id,
    t.entry_count,
    t.size_bytes,
    t.last_activity,
    CASE 
        WHEN t.last_activity < NOW() - INTERVAL '7 days' THEN 'inactive'
        WHEN t.entry_count = 0 THEN 'empty'
        WHEN t.size_bytes > 100 * 1024 * 1024 THEN 'large' -- > 100MB
        ELSE 'healthy'
    END as health_status,
    CASE 
        WHEN t.entry_count > 0 THEN t.size_bytes / t.entry_count
        ELSE 0
    END as avg_entry_size
FROM get_all_tenants_stats() t;

-- Grant permissions for the new functions and view
-- GRANT EXECUTE ON FUNCTION get_tenant_memory_stats(TEXT) TO your_app_user;
-- GRANT EXECUTE ON FUNCTION get_all_tenants_stats() TO your_app_user;
-- GRANT EXECUTE ON FUNCTION cleanup_orphaned_alignments(TEXT) TO your_app_user;
-- GRANT SELECT ON tenant_health_view TO your_app_user; 