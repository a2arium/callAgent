-- CreateTable
CREATE TABLE "agent_result_cache" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "agent_name" TEXT NOT NULL,
    "cache_key" TEXT NOT NULL,
    "result" JSONB NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expires_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "agent_result_cache_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "agent_result_cache_tenant_id_agent_name_cache_key_key" ON "agent_result_cache"("tenant_id", "agent_name", "cache_key");

-- CreateIndex
CREATE INDEX "agent_result_cache_tenant_id_agent_name_idx" ON "agent_result_cache"("tenant_id", "agent_name");

-- CreateIndex
CREATE INDEX "agent_result_cache_expires_at_idx" ON "agent_result_cache"("expires_at"); 