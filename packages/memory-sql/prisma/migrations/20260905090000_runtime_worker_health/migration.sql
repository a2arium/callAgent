CREATE TABLE "runtime_worker_health" (
    "tenant_id" TEXT NOT NULL,
    "installation_id" TEXT NOT NULL,
    "instance_id" TEXT NOT NULL,
    "worker_name" TEXT NOT NULL,
    "state" TEXT NOT NULL,
    "generation" INTEGER NOT NULL DEFAULT 1,
    "workflow_hash" TEXT NOT NULL,
    "observed_at" TIMESTAMP(3) NOT NULL,
    "heartbeat_at" TIMESTAMP(3),
    "lease_until" TIMESTAMP(3) NOT NULL,
    "error_code" TEXT,
    "error_message" TEXT,
    "updated_at" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "runtime_worker_health_pkey" PRIMARY KEY ("tenant_id", "installation_id", "instance_id")
);
CREATE INDEX "runtime_worker_health_tenant_id_installation_id_lease_until_idx"
    ON "runtime_worker_health"("tenant_id", "installation_id", "lease_until");
CREATE INDEX "driver_runs_tenant_id_operation_status_updated_at_id_idx"
    ON "driver_runs"("tenant_id", "operation", "status", "updated_at", "id");
