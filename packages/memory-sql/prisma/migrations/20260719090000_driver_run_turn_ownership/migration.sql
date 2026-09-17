ALTER TABLE "driver_runs"
    ADD COLUMN "claim_id" TEXT,
    ADD COLUMN "turn_fence" TEXT,
    ADD COLUMN "claimed_generation" TEXT,
    ADD COLUMN "turn_disposition" TEXT,
    ADD COLUMN "attempt_seq" INTEGER,
    ADD COLUMN "root_run_key" TEXT;

ALTER TABLE "turn_runs"
    DROP CONSTRAINT IF EXISTS "turn_runs_tenant_id_task_id_turn_seq_key",
    ALTER COLUMN "turn_seq" DROP NOT NULL,
    ADD COLUMN "attempt_key" TEXT,
    ADD COLUMN "attempt_seq" INTEGER,
    ADD COLUMN "disposition" TEXT,
    ADD COLUMN "claim_id" TEXT,
    ADD COLUMN "turn_fence" TEXT,
    ADD COLUMN "claimed_generation" TEXT,
    ADD COLUMN "authoritative_terminal" BOOLEAN NOT NULL DEFAULT false;

UPDATE "turn_runs" SET "attempt_key" = "id" WHERE "attempt_key" IS NULL;
ALTER TABLE "turn_runs" ALTER COLUMN "attempt_key" SET NOT NULL;
CREATE UNIQUE INDEX "turn_runs_tenant_id_task_id_attempt_key_key"
    ON "turn_runs"("tenant_id", "task_id", "attempt_key");
CREATE INDEX "turn_runs_tenant_id_task_id_turn_seq_idx"
    ON "turn_runs"("tenant_id", "task_id", "turn_seq");

CREATE INDEX "driver_runs_tenant_id_task_id_status_idx"
    ON "driver_runs"("tenant_id", "task_id", "status");

CREATE INDEX "driver_runs_tenant_id_root_task_id_status_idx"
    ON "driver_runs"("tenant_id", "root_task_id", "status");

CREATE INDEX "wm_sessions_turn_dispatch_intent_idx"
    ON "wm_sessions"("updated_at", "tenant_id", "session_id")
    WHERE snapshot #> '{meta,turnCoordinator,dispatchIntent}' IS NOT NULL
      AND snapshot #> '{meta,turnCoordinator,active}' IS NULL;
