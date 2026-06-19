-- Durable operator graph fields for provider run rows.
ALTER TABLE "driver_runs" ADD COLUMN "root_task_id" TEXT;
ALTER TABLE "driver_runs" ADD COLUMN "parent_task_id" TEXT;
ALTER TABLE "driver_runs" ADD COLUMN "parent_agent_id" TEXT;
ALTER TABLE "driver_runs" ADD COLUMN "child_task_id" TEXT;
ALTER TABLE "driver_runs" ADD COLUMN "child_agent_id" TEXT;
ALTER TABLE "driver_runs" ADD COLUMN "edge_token" TEXT;
ALTER TABLE "driver_runs" ADD COLUMN "edge_kind" TEXT;
ALTER TABLE "driver_runs" ADD COLUMN "turn_seq" INTEGER;
ALTER TABLE "driver_runs" ADD COLUMN "boundary_kind" TEXT;
ALTER TABLE "driver_runs" ADD COLUMN "turn_trace_id" TEXT;

CREATE INDEX "driver_runs_tenant_id_root_task_id_idx" ON "driver_runs"("tenant_id", "root_task_id");
