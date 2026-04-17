-- Phase 2: topics, members, invites, deliveries; widen conversation_messages.

CREATE TABLE IF NOT EXISTS "conversation_topics" (
  "tenant_id" TEXT NOT NULL,
  "conversation_id" TEXT NOT NULL,
  "owner_agent_id" TEXT NOT NULL,
  "status" TEXT NOT NULL,
  "default_selector_kind" TEXT NOT NULL,
  "default_selector_data" JSONB NOT NULL DEFAULT '{}',
  "rotation_cursor" INTEGER NOT NULL DEFAULT 0,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "conversation_topics_pkey" PRIMARY KEY ("tenant_id", "conversation_id")
);

CREATE INDEX IF NOT EXISTS "conversation_topics_tenant_id_owner_agent_id_idx"
  ON "conversation_topics"("tenant_id", "owner_agent_id");

CREATE TABLE IF NOT EXISTS "conversation_topic_members" (
  "tenant_id" TEXT NOT NULL,
  "conversation_id" TEXT NOT NULL,
  "agent_id" TEXT NOT NULL,
  "role" TEXT NOT NULL,
  "session_id" TEXT NOT NULL,
  "registered_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "left_at" TIMESTAMP(3),
  CONSTRAINT "conversation_topic_members_pkey" PRIMARY KEY ("tenant_id", "conversation_id", "agent_id")
);

CREATE INDEX IF NOT EXISTS "conversation_topic_members_tenant_id_conversation_id_idx"
  ON "conversation_topic_members"("tenant_id", "conversation_id");

CREATE TABLE IF NOT EXISTS "conversation_topic_invites" (
  "tenant_id" TEXT NOT NULL,
  "conversation_id" TEXT NOT NULL,
  "token" TEXT NOT NULL,
  "invitee_agent_id" TEXT NOT NULL,
  "role" TEXT NOT NULL,
  "session_id_override" TEXT,
  "issued_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "consumed_at" TIMESTAMP(3),
  CONSTRAINT "conversation_topic_invites_pkey" PRIMARY KEY ("token")
);

CREATE INDEX IF NOT EXISTS "conversation_topic_invites_tenant_id_conversation_id_idx"
  ON "conversation_topic_invites"("tenant_id", "conversation_id");

CREATE TABLE IF NOT EXISTS "conversation_message_deliveries" (
  "id" TEXT NOT NULL,
  "tenant_id" TEXT NOT NULL,
  "conversation_id" TEXT NOT NULL,
  "sequence_number" INTEGER NOT NULL,
  "recipient_agent_id" TEXT NOT NULL,
  "session_id" TEXT NOT NULL,
  "dedupe_hit" BOOLEAN NOT NULL DEFAULT FALSE,
  "status" TEXT NOT NULL,
  "error" JSONB,
  "queue_position" INTEGER,
  CONSTRAINT "conversation_message_deliveries_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "conversation_message_deliveries_tenant_conv_seq_recipient_key"
  ON "conversation_message_deliveries"("tenant_id", "conversation_id", "sequence_number", "recipient_agent_id");

CREATE INDEX IF NOT EXISTS "conversation_message_deliveries_tenant_id_conversation_id_seq_idx"
  ON "conversation_message_deliveries"("tenant_id", "conversation_id", "sequence_number");

ALTER TABLE "conversation_messages" ADD COLUMN IF NOT EXISTS "conversation_kind" TEXT NOT NULL DEFAULT 'thread';
ALTER TABLE "conversation_messages" ADD COLUMN IF NOT EXISTS "selector_kind" TEXT;

UPDATE "conversation_messages" SET "conversation_kind" = 'thread' WHERE "conversation_kind" IS NULL;

ALTER TABLE "conversation_messages" ALTER COLUMN "recipient_agent_id" DROP NOT NULL;
