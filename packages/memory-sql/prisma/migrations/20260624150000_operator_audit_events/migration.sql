CREATE TABLE "operator_audit_events" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "actor_type" TEXT NOT NULL,
    "actor_id" TEXT NOT NULL,
    "root_task_id" TEXT,
    "task_id" TEXT,
    "agent_id" TEXT,
    "reason" TEXT,
    "accepted" BOOLEAN NOT NULL,
    "result_status" TEXT,
    "error_code" TEXT,
    "child_propagation" TEXT,
    "metadata" JSONB,
    "requested_at" TIMESTAMP(3) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "operator_audit_events_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "operator_audit_events_tenant_id_created_at_idx" ON "operator_audit_events"("tenant_id", "created_at");
CREATE INDEX "operator_audit_events_tenant_id_action_created_at_idx" ON "operator_audit_events"("tenant_id", "action", "created_at");
CREATE INDEX "operator_audit_events_tenant_id_task_id_created_at_idx" ON "operator_audit_events"("tenant_id", "task_id", "created_at");
