CREATE TABLE "agent_runs" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "task_id" TEXT NOT NULL,
    "root_task_id" TEXT NOT NULL,
    "agent_id" TEXT,
    "operation" TEXT NOT NULL DEFAULT 'agent.run',
    "scope" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "attention" TEXT,
    "parent_task_id" TEXT,
    "parent_agent_id" TEXT,
    "parent_turn_seq" INTEGER,
    "child_count" INTEGER NOT NULL DEFAULT 0,
    "turn_count" INTEGER NOT NULL DEFAULT 0,
    "llm_call_count" INTEGER NOT NULL DEFAULT 0,
    "memory_op_count" INTEGER NOT NULL DEFAULT 0,
    "known_cost_usd" DECIMAL(18,6),
    "started_at" TIMESTAMP(3),
    "terminal_at" TIMESTAMP(3),
    "duration_ms" INTEGER,
    "last_boundary_kind" TEXT,
    "waiting_reason" TEXT,
    "terminal_code" TEXT,
    "terminal_message" TEXT,
    "cancel_reason" TEXT,
    "output_state" TEXT NOT NULL DEFAULT 'not_captured',
    "output_artifact_id" TEXT,
    "trace_id" TEXT,
    "provider_run_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "agent_runs_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "agent_run_edges" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "root_task_id" TEXT NOT NULL,
    "parent_task_id" TEXT NOT NULL,
    "child_task_id" TEXT NOT NULL,
    "parent_turn_seq" INTEGER,
    "token" TEXT,
    "edge_kind" TEXT NOT NULL DEFAULT 'delegates_to',
    "status" TEXT NOT NULL,
    "terminal_code" TEXT,
    "terminal_message" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "resolved_at" TIMESTAMP(3),
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "agent_run_edges_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "turn_runs" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "task_id" TEXT NOT NULL,
    "root_task_id" TEXT NOT NULL,
    "agent_id" TEXT,
    "turn_seq" INTEGER NOT NULL,
    "status" TEXT NOT NULL,
    "started_at" TIMESTAMP(3),
    "completed_at" TIMESTAMP(3),
    "duration_ms" INTEGER,
    "from_state" TEXT,
    "to_state" TEXT,
    "transition_kind" TEXT,
    "boundary_kind" TEXT,
    "shield_outcome" TEXT,
    "execution_kind" TEXT,
    "output_produced" BOOLEAN NOT NULL DEFAULT false,
    "llm_call_count" INTEGER NOT NULL DEFAULT 0,
    "memory_op_count" INTEGER NOT NULL DEFAULT 0,
    "known_cost_usd" DECIMAL(18,6),
    "terminal_code" TEXT,
    "terminal_message" TEXT,
    "turn_trace_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "turn_runs_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "run_effects" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "root_task_id" TEXT NOT NULL,
    "task_id" TEXT NOT NULL,
    "turn_seq" INTEGER,
    "operation" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "idempotency_key" TEXT,
    "token" TEXT,
    "provider_run_id" TEXT,
    "artifact_id" TEXT,
    "summary" TEXT,
    "error_code" TEXT,
    "error_message" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "run_effects_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "operator_projection_cursors" (
    "tenant_id" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "cursor" TEXT NOT NULL,
    "processed_count" INTEGER NOT NULL DEFAULT 0,
    "mismatch_count" INTEGER NOT NULL DEFAULT 0,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "operator_projection_cursors_pkey" PRIMARY KEY ("tenant_id","source")
);

CREATE UNIQUE INDEX "agent_runs_tenant_id_task_id_key" ON "agent_runs"("tenant_id", "task_id");
CREATE INDEX "agent_runs_tenant_id_root_task_id_idx" ON "agent_runs"("tenant_id", "root_task_id");
CREATE INDEX "agent_runs_tenant_id_scope_updated_at_task_id_idx" ON "agent_runs"("tenant_id", "scope", "updated_at", "task_id");
CREATE INDEX "agent_runs_tenant_id_agent_id_updated_at_task_id_idx" ON "agent_runs"("tenant_id", "agent_id", "updated_at", "task_id");
CREATE INDEX "agent_runs_tenant_id_status_updated_at_task_id_idx" ON "agent_runs"("tenant_id", "status", "updated_at", "task_id");

CREATE UNIQUE INDEX "agent_run_edges_tenant_id_parent_task_id_child_task_id_token_key" ON "agent_run_edges"("tenant_id", "parent_task_id", "child_task_id", "token");
CREATE INDEX "agent_run_edges_tenant_id_root_task_id_parent_task_id_idx" ON "agent_run_edges"("tenant_id", "root_task_id", "parent_task_id");
CREATE INDEX "agent_run_edges_tenant_id_child_task_id_idx" ON "agent_run_edges"("tenant_id", "child_task_id");

CREATE UNIQUE INDEX "turn_runs_tenant_id_task_id_turn_seq_key" ON "turn_runs"("tenant_id", "task_id", "turn_seq");
CREATE INDEX "turn_runs_tenant_id_root_task_id_task_id_turn_seq_idx" ON "turn_runs"("tenant_id", "root_task_id", "task_id", "turn_seq");

CREATE UNIQUE INDEX "run_effects_idempotency_key_key" ON "run_effects"("idempotency_key");
CREATE INDEX "run_effects_tenant_id_root_task_id_operation_updated_at_idx" ON "run_effects"("tenant_id", "root_task_id", "operation", "updated_at");
CREATE INDEX "run_effects_tenant_id_task_id_turn_seq_operation_idx" ON "run_effects"("tenant_id", "task_id", "turn_seq", "operation");
