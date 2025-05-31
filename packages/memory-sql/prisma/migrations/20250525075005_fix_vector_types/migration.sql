-- Enable pgvector extension if not already enabled
CREATE EXTENSION IF NOT EXISTS vector;

-- Convert embedding columns from REAL[] to vector type
ALTER TABLE "agent_memory_store" 
ALTER COLUMN "embedding" TYPE vector(1536) USING embedding::vector;

ALTER TABLE "entity_store" 
ALTER COLUMN "embedding" TYPE vector(1536) USING embedding::vector;

-- Create vector indexes for performance
CREATE INDEX IF NOT EXISTS idx_entity_store_embedding 
ON entity_store USING ivfflat (embedding vector_cosine_ops) 
WITH (lists = 100);

CREATE INDEX IF NOT EXISTS idx_memory_store_embedding 
ON agent_memory_store USING ivfflat (embedding vector_cosine_ops) 
WITH (lists = 100);

-- Create additional indexes for query performance
CREATE INDEX IF NOT EXISTS idx_entity_store_type 
ON entity_store(entity_type);

CREATE INDEX IF NOT EXISTS idx_entity_alignment_memory_key 
ON entity_alignment(memory_key); 