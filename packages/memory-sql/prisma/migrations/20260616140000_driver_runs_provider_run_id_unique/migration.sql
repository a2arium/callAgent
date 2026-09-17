-- DropIndex
DROP INDEX IF EXISTS "driver_runs_provider_run_id_idx";

-- CreateIndex
CREATE UNIQUE INDEX "driver_runs_provider_run_id_key" ON "driver_runs"("provider_run_id");
