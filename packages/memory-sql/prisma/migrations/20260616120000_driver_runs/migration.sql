-- CreateTable
CREATE TABLE "driver_runs" (
    "id" TEXT NOT NULL,
    "provider" TEXT NOT NULL DEFAULT 'hatchet',
    "provider_run_id" TEXT,
    "provider_task_run_id" TEXT,
    "tenant_id" TEXT NOT NULL,
    "agent_id" TEXT,
    "task_id" TEXT,
    "token" TEXT,
    "trace_id" TEXT,
    "span_id" TEXT,
    "idempotency_key" TEXT,
    "operation" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "outbox_row_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "driver_runs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "driver_runs_tenant_id_task_id_idx" ON "driver_runs"("tenant_id", "task_id");

-- CreateIndex
CREATE INDEX "driver_runs_provider_run_id_idx" ON "driver_runs"("provider_run_id");
