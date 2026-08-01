ALTER TABLE "agent_runs"
    ADD COLUMN "origin_kind" TEXT,
    ADD COLUMN "schedule_id" TEXT,
    ADD COLUMN "schedule_occurrence_id" TEXT,
    ADD COLUMN "submitted_by_task_id" TEXT,
    ADD COLUMN "scheduled_for" TIMESTAMP(3);

CREATE INDEX "agent_runs_tenant_id_schedule_id_updated_at_task_id_idx"
    ON "agent_runs"("tenant_id", "schedule_id", "updated_at", "task_id");
