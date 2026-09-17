-- Phase 4a: topic lifecycle columns (parity with thread archive / close metadata).

ALTER TABLE "conversation_topics" ADD COLUMN IF NOT EXISTS "closed_at" TIMESTAMP(3);
ALTER TABLE "conversation_topics" ADD COLUMN IF NOT EXISTS "close_reason" TEXT;
ALTER TABLE "conversation_topics" ADD COLUMN IF NOT EXISTS "close_reason_text" VARCHAR(500);
ALTER TABLE "conversation_topics" ADD COLUMN IF NOT EXISTS "closed_by_agent_id" TEXT;
ALTER TABLE "conversation_topics" ADD COLUMN IF NOT EXISTS "closed_by_member_id" TEXT;
ALTER TABLE "conversation_topics" ADD COLUMN IF NOT EXISTS "archived_at" TIMESTAMP(3);
ALTER TABLE "conversation_topics" ADD COLUMN IF NOT EXISTS "archived_by_agent_id" TEXT;
ALTER TABLE "conversation_topics" ADD COLUMN IF NOT EXISTS "archived_by_member_id" TEXT;
ALTER TABLE "conversation_topics" ADD COLUMN IF NOT EXISTS "archived_reason_text" VARCHAR(500);

-- Backfill metadata for rows created before lifecycle columns existed (app previously stored status only).
UPDATE "conversation_topics"
SET "closed_at" = "updated_at"
WHERE "status" IN ('closed', 'archived') AND "closed_at" IS NULL;

UPDATE "conversation_topics"
SET "archived_at" = "updated_at"
WHERE "status" = 'archived' AND "archived_at" IS NULL;

CREATE INDEX IF NOT EXISTS "conversation_topics_tenant_id_status_closed_at_idx"
    ON "conversation_topics" ("tenant_id", "status", "closed_at");

ALTER TABLE "conversation_topics" DROP CONSTRAINT IF EXISTS "conversation_topics_status_check";
ALTER TABLE "conversation_topics" ADD CONSTRAINT "conversation_topics_status_check"
    CHECK ("status" IN ('open', 'closed', 'archived'));

ALTER TABLE "conversation_topics" DROP CONSTRAINT IF EXISTS "conversation_topics_close_reason_check";
ALTER TABLE "conversation_topics" ADD CONSTRAINT "conversation_topics_close_reason_check"
    CHECK ("close_reason" IS NULL OR "close_reason" IN ('explicit', 'ttl', 'archived'));

ALTER TABLE "conversation_topics" DROP CONSTRAINT IF EXISTS "conversation_topics_open_closed_at_pairing";
ALTER TABLE "conversation_topics" ADD CONSTRAINT "conversation_topics_open_closed_at_pairing"
    CHECK (
        ("status" = 'open' AND "closed_at" IS NULL)
        OR ("status" <> 'open' AND "closed_at" IS NOT NULL)
    );
