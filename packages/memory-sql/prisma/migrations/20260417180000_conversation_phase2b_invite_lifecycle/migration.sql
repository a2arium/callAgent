ALTER TABLE "conversation_topic_invites"
ADD COLUMN "expires_at" TIMESTAMP(3),
ADD COLUMN "inviter_agent_id" TEXT,
ADD COLUMN "inviter_member_id" TEXT,
ADD COLUMN "inviter_session_id" TEXT,
ADD COLUMN "declined_at" TIMESTAMP(3),
ADD COLUMN "decline_reason" TEXT,
ADD COLUMN "delivery_attempted_at" TIMESTAMP(3),
ADD COLUMN "delivered_at" TIMESTAMP(3),
ADD COLUMN "delivery_attempts" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN "delivery_failure_reason" TEXT;

UPDATE "conversation_topic_invites"
SET
  "expires_at" = "issued_at" + INTERVAL '1 day',
  "inviter_agent_id" = COALESCE("inviter_agent_id", "invitee_agent_id"),
  "inviter_member_id" = COALESCE("inviter_member_id", COALESCE("invitee_member_id", "invitee_agent_id")),
  "inviter_session_id" = COALESCE("inviter_session_id", "session_id_override", CONCAT('topic-', "conversation_id", ':', COALESCE("invitee_member_id", "invitee_agent_id")))
WHERE "expires_at" IS NULL
   OR "inviter_agent_id" IS NULL
   OR "inviter_member_id" IS NULL
   OR "inviter_session_id" IS NULL;

ALTER TABLE "conversation_topic_invites"
ALTER COLUMN "expires_at" SET NOT NULL,
ALTER COLUMN "inviter_agent_id" SET NOT NULL,
ALTER COLUMN "inviter_member_id" SET NOT NULL,
ALTER COLUMN "inviter_session_id" SET NOT NULL;

CREATE INDEX "conversation_topic_invites_tenant_id_expires_at_idx"
ON "conversation_topic_invites" ("tenant_id", "expires_at");
