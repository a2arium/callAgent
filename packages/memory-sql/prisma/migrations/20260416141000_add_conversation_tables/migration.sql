CREATE TABLE IF NOT EXISTS "conversation_threads" (
  "tenant_id" TEXT NOT NULL,
  "conversation_id" TEXT NOT NULL,
  "owner_agent_id" TEXT NOT NULL,
  "participant_agent_id" TEXT NOT NULL,
  "status" TEXT NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "conversation_threads_pkey" PRIMARY KEY ("tenant_id", "conversation_id")
);

CREATE INDEX IF NOT EXISTS "conversation_threads_tenant_id_owner_agent_id_idx"
  ON "conversation_threads"("tenant_id", "owner_agent_id");
CREATE INDEX IF NOT EXISTS "conversation_threads_tenant_id_participant_agent_id_idx"
  ON "conversation_threads"("tenant_id", "participant_agent_id");

CREATE TABLE IF NOT EXISTS "conversation_messages" (
  "id" TEXT NOT NULL,
  "tenant_id" TEXT NOT NULL,
  "conversation_id" TEXT NOT NULL,
  "sequence_number" INTEGER NOT NULL,
  "message_id" TEXT NOT NULL,
  "sender_agent_id" TEXT NOT NULL,
  "recipient_agent_id" TEXT NOT NULL,
  "speech_act" TEXT NOT NULL,
  "payload" JSONB NOT NULL,
  "correlation_id" TEXT,
  "idempotency_key" TEXT,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "conversation_messages_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "conversation_messages_tenant_id_conversation_id_sequence_number_key"
  ON "conversation_messages"("tenant_id", "conversation_id", "sequence_number");
CREATE UNIQUE INDEX IF NOT EXISTS "conversation_messages_tenant_id_conversation_id_sender_agent_id_idempotency_key_key"
  ON "conversation_messages"("tenant_id", "conversation_id", "sender_agent_id", "idempotency_key");
CREATE INDEX IF NOT EXISTS "conversation_messages_tenant_id_conversation_id_idx"
  ON "conversation_messages"("tenant_id", "conversation_id");
CREATE INDEX IF NOT EXISTS "conversation_messages_tenant_id_conversation_id_created_at_idx"
  ON "conversation_messages"("tenant_id", "conversation_id", "created_at");
