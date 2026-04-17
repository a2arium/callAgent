-- Phase 3: thread lifecycle columns (idle TTL, close metadata, archive metadata).

ALTER TABLE "conversation_threads" ADD COLUMN IF NOT EXISTS "closed_at" TIMESTAMP(3);
ALTER TABLE "conversation_threads" ADD COLUMN IF NOT EXISTS "close_reason" TEXT;
ALTER TABLE "conversation_threads" ADD COLUMN IF NOT EXISTS "close_reason_text" VARCHAR(500);
ALTER TABLE "conversation_threads" ADD COLUMN IF NOT EXISTS "closed_by_agent_id" TEXT;
ALTER TABLE "conversation_threads" ADD COLUMN IF NOT EXISTS "archived_at" TIMESTAMP(3);
ALTER TABLE "conversation_threads" ADD COLUMN IF NOT EXISTS "archived_by_agent_id" TEXT;
ALTER TABLE "conversation_threads" ADD COLUMN IF NOT EXISTS "archived_reason_text" VARCHAR(500);
ALTER TABLE "conversation_threads" ADD COLUMN IF NOT EXISTS "expires_at" TIMESTAMP(3);

CREATE INDEX IF NOT EXISTS "conversation_threads_tenant_id_status_expires_at_idx"
    ON "conversation_threads" ("tenant_id", "status", "expires_at");

CREATE INDEX IF NOT EXISTS "conversation_threads_tenant_id_status_closed_at_idx"
    ON "conversation_threads" ("tenant_id", "status", "closed_at");
