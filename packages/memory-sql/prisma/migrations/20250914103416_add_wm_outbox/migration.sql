-- CreateTable
CREATE TABLE "wm_sessions" (
    "tenant_id" TEXT NOT NULL,
    "session_id" TEXT NOT NULL,
    "agent_id" TEXT NOT NULL,
    "wm_version" BIGINT NOT NULL DEFAULT 0,
    "snapshot" JSONB NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "wm_sessions_pkey" PRIMARY KEY ("tenant_id","session_id")
);

-- CreateTable
CREATE TABLE "wm_events" (
    "event_id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "session_id" TEXT NOT NULL,
    "seq" INTEGER NOT NULL,
    "type" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "wm_events_pkey" PRIMARY KEY ("event_id")
);

-- CreateTable
CREATE TABLE "outbox" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "topic" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "outbox_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "wm_sessions_tenant_id_idx" ON "wm_sessions"("tenant_id");

-- CreateIndex
CREATE INDEX "wm_sessions_tenant_id_agent_id_idx" ON "wm_sessions"("tenant_id", "agent_id");

-- CreateIndex
CREATE INDEX "wm_events_tenant_id_session_id_seq_idx" ON "wm_events"("tenant_id", "session_id", "seq");

-- CreateIndex
CREATE INDEX "outbox_tenant_id_topic_idx" ON "outbox"("tenant_id", "topic");
