-- Phase 4a: topic stop policies (non-empty JSON array per topic).
ALTER TABLE "conversation_topics"
ADD COLUMN IF NOT EXISTS "stop_policies" JSONB NOT NULL DEFAULT '[{"kind":"timeout","afterMs":86400000}]'::jsonb;

ALTER TABLE "conversation_topics"
ADD CONSTRAINT "conversation_topics_stop_policies_len" CHECK (jsonb_array_length("stop_policies") >= 1);
