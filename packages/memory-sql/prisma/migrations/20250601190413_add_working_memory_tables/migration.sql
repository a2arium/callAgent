-- CreateTable
CREATE TABLE "working_memory_sessions" (
    "tenant_id" TEXT NOT NULL,
    "agent_id" TEXT NOT NULL,
    "current_goal" TEXT,
    "goal_timestamp" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "working_memory_sessions_pkey" PRIMARY KEY ("tenant_id","agent_id")
);

-- CreateTable
CREATE TABLE "working_memory_thoughts" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "agent_id" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "type" TEXT NOT NULL DEFAULT 'thought',
    "timestamp" TIMESTAMP(3) NOT NULL,
    "processing_metadata" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "working_memory_thoughts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "working_memory_decisions" (
    "tenant_id" TEXT NOT NULL,
    "agent_id" TEXT NOT NULL,
    "decision_key" TEXT NOT NULL,
    "decision" TEXT NOT NULL,
    "reasoning" TEXT,
    "timestamp" TIMESTAMP(3) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "working_memory_decisions_pkey" PRIMARY KEY ("tenant_id","agent_id","decision_key")
);

-- CreateTable
CREATE TABLE "working_memory_variables" (
    "tenant_id" TEXT NOT NULL,
    "agent_id" TEXT NOT NULL,
    "variable_key" TEXT NOT NULL,
    "variable_value" JSONB NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "working_memory_variables_pkey" PRIMARY KEY ("tenant_id","agent_id","variable_key")
);

-- CreateIndex
CREATE INDEX "working_memory_sessions_tenant_id_idx" ON "working_memory_sessions"("tenant_id");

-- CreateIndex
CREATE INDEX "working_memory_thoughts_tenant_id_agent_id_timestamp_idx" ON "working_memory_thoughts"("tenant_id", "agent_id", "timestamp");

-- CreateIndex
CREATE INDEX "working_memory_thoughts_tenant_id_idx" ON "working_memory_thoughts"("tenant_id");

-- CreateIndex
CREATE INDEX "working_memory_decisions_tenant_id_idx" ON "working_memory_decisions"("tenant_id");

-- CreateIndex
CREATE INDEX "working_memory_decisions_tenant_id_agent_id_idx" ON "working_memory_decisions"("tenant_id", "agent_id");

-- CreateIndex
CREATE INDEX "working_memory_variables_tenant_id_idx" ON "working_memory_variables"("tenant_id");

-- CreateIndex
CREATE INDEX "working_memory_variables_tenant_id_agent_id_idx" ON "working_memory_variables"("tenant_id", "agent_id");
