CREATE TABLE "run_progress" (
    "tenant_id" TEXT NOT NULL, "task_id" TEXT NOT NULL, "root_task_id" TEXT NOT NULL,
    "agent_id" TEXT NOT NULL, "schema_version" TEXT NOT NULL, "snapshot" JSONB NOT NULL,
    "revision" BIGINT NOT NULL DEFAULT 1, "claim_id" TEXT NOT NULL, "turn_fence" TEXT NOT NULL,
    "claimed_generation" TEXT NOT NULL, "turn_seq" INTEGER NOT NULL,
    "reported_at" TIMESTAMPTZ(3) NOT NULL, "terminal_state" TEXT, "terminal_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "run_progress_pkey" PRIMARY KEY ("tenant_id", "task_id")
);
CREATE INDEX "run_progress_tenant_id_root_task_id_updated_at_idx"
ON "run_progress"("tenant_id", "root_task_id", "updated_at");
