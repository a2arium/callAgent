-- Phase 2a: topic member multiplicity (memberId), idempotency on sender_member_id, rotation cursor as member_id text

-- 1) conversation_topic_members: member_id PK + session uniqueness + agent index
ALTER TABLE "conversation_topic_members" ADD COLUMN IF NOT EXISTS "member_id" TEXT;
UPDATE "conversation_topic_members" SET "member_id" = "agent_id" WHERE "member_id" IS NULL;
ALTER TABLE "conversation_topic_members" ALTER COLUMN "member_id" SET NOT NULL;

ALTER TABLE "conversation_topic_members" DROP CONSTRAINT "conversation_topic_members_pkey";

ALTER TABLE "conversation_topic_members"
    ADD CONSTRAINT "conversation_topic_members_pkey" PRIMARY KEY ("tenant_id", "conversation_id", "member_id");

CREATE UNIQUE INDEX IF NOT EXISTS "conversation_topic_members_tenant_conv_session_key"
    ON "conversation_topic_members" ("tenant_id", "conversation_id", "session_id");

CREATE INDEX IF NOT EXISTS "conversation_topic_members_tenant_conv_agent_idx"
    ON "conversation_topic_members" ("tenant_id", "conversation_id", "agent_id");

-- 2) conversation_topic_invites: invitee_member_id
ALTER TABLE "conversation_topic_invites" ADD COLUMN IF NOT EXISTS "invitee_member_id" TEXT;
UPDATE "conversation_topic_invites" SET "invitee_member_id" = "invitee_agent_id" WHERE "invitee_member_id" IS NULL;

-- 3) conversation_message_deliveries: member_id uniqueness
ALTER TABLE "conversation_message_deliveries" ADD COLUMN IF NOT EXISTS "member_id" TEXT;
UPDATE "conversation_message_deliveries" SET "member_id" = "recipient_agent_id" WHERE "member_id" IS NULL;
ALTER TABLE "conversation_message_deliveries" ALTER COLUMN "member_id" SET NOT NULL;

DROP INDEX IF EXISTS "conversation_message_deliveries_tenant_conv_seq_recipient_key";

CREATE UNIQUE INDEX IF NOT EXISTS "conversation_message_deliveries_tenant_conv_seq_member_key"
    ON "conversation_message_deliveries" ("tenant_id", "conversation_id", "sequence_number", "member_id");

-- 4) conversation_messages: sender_member_id + idempotency on member
ALTER TABLE "conversation_messages" ADD COLUMN IF NOT EXISTS "sender_member_id" TEXT;
UPDATE "conversation_messages" SET "sender_member_id" = "sender_agent_id" WHERE "sender_member_id" IS NULL;
ALTER TABLE "conversation_messages" ALTER COLUMN "sender_member_id" SET NOT NULL;

DROP INDEX IF EXISTS "conversation_messages_tenant_id_conversation_id_sender_agent_id_idempotency_key_key";

CREATE UNIQUE INDEX IF NOT EXISTS "conversation_messages_tenant_conv_sender_member_idem_key"
    ON "conversation_messages" ("tenant_id", "conversation_id", "sender_member_id", "idempotency_key");

-- 5) conversation_topics: rotation_cursor int -> text (nullable; advisory last member_id)
ALTER TABLE "conversation_topics" DROP COLUMN IF EXISTS "rotation_cursor";
ALTER TABLE "conversation_topics" ADD COLUMN "rotation_cursor" TEXT;
