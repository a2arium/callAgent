CREATE INDEX "driver_runs_tenant_id_created_at_idx"
    ON "driver_runs" ("tenant_id", "created_at");

CREATE INDEX "driver_runs_tenant_id_agent_id_created_at_idx"
    ON "driver_runs" ("tenant_id", "agent_id", "created_at");

CREATE INDEX "driver_runs_tenant_id_status_created_at_idx"
    ON "driver_runs" ("tenant_id", "status", "created_at");
