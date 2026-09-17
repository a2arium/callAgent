-- Phase 2b: invite idempotency + correlation metadata (partial unique index for idempotency key)

ALTER TABLE "conversation_topic_invites" ADD COLUMN "idempotency_key" TEXT;
ALTER TABLE "conversation_topic_invites" ADD COLUMN "correlation_id" TEXT;

CREATE UNIQUE INDEX "conversation_topic_invites_idempotency_partial_uidx"
ON "conversation_topic_invites" ("tenant_id", "conversation_id", "idempotency_key")
WHERE "idempotency_key" IS NOT NULL;
