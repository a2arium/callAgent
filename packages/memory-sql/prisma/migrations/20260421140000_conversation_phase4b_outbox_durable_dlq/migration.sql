-- Phase 4b: outbox retries, durable subscription cursors, conversation dead-letter store

ALTER TABLE outbox ADD COLUMN IF NOT EXISTS retry_count INTEGER NOT NULL DEFAULT 0;

CREATE TABLE IF NOT EXISTS durable_subscription_cursors (
    tenant_id TEXT NOT NULL,
    stream_id TEXT NOT NULL,
    consumer_id TEXT NOT NULL,
    sequence_number INTEGER NOT NULL,
    updated_at TIMESTAMP NOT NULL,
    PRIMARY KEY (tenant_id, stream_id, consumer_id)
);

CREATE TABLE IF NOT EXISTS conversation_dead_letter (
    tenant_id TEXT NOT NULL,
    conversation_id TEXT NOT NULL,
    sequence_number INTEGER NOT NULL,
    consumer_id TEXT NOT NULL,
    record JSONB NOT NULL,
    last_error TEXT NOT NULL,
    attempts INTEGER NOT NULL,
    deadlettered_at TIMESTAMP NOT NULL,
    PRIMARY KEY (tenant_id, conversation_id, sequence_number, consumer_id)
);
