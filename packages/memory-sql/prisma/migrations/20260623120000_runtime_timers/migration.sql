CREATE TABLE "runtime_timers" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "task_id" TEXT NOT NULL,
    "agent_id" TEXT,
    "root_task_id" TEXT,
    "token" TEXT NOT NULL,
    "timer_id" TEXT NOT NULL,
    "due_at" TIMESTAMP(3) NOT NULL,
    "kind" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "idempotency_key" TEXT NOT NULL,
    "fire_lease_id" TEXT,
    "fire_lease_until" TIMESTAMP(3),
    "payload" JSONB,
    "provider_run_id" TEXT,
    "provider_task_run_id" TEXT,
    "error" JSONB,
    "fired_at" TIMESTAMP(3),
    "canceled_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "runtime_timers_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "runtime_timers_idempotency_key_key" ON "runtime_timers"("idempotency_key");
CREATE UNIQUE INDEX "runtime_timers_tenant_id_task_id_token_timer_id_key" ON "runtime_timers"("tenant_id", "task_id", "token", "timer_id");
CREATE INDEX "runtime_timers_tenant_id_status_due_at_timer_id_idx" ON "runtime_timers"("tenant_id", "status", "due_at", "timer_id");
CREATE INDEX "runtime_timers_tenant_id_task_id_token_idx" ON "runtime_timers"("tenant_id", "task_id", "token");
