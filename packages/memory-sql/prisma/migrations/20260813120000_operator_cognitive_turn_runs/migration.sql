CREATE TABLE "cognitive_turn_runs" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "task_id" TEXT NOT NULL,
    "root_task_id" TEXT NOT NULL,
    "agent_id" TEXT,
    "identity_key" TEXT NOT NULL,
    "turn_id" TEXT,
    "cognition_turn_seq" INTEGER NOT NULL,
    "segment_seq" INTEGER,
    "attempt_key" TEXT,
    "claim_id" TEXT,
    "disposition" TEXT NOT NULL,
    "started_at" TIMESTAMP(3),
    "started_at_estimated" BOOLEAN NOT NULL DEFAULT false,
    "completed_at" TIMESTAMP(3),
    "duration_ms" INTEGER,
    "stage_before" TEXT,
    "stage_after" TEXT,
    "cognition" JSONB,
    "timings" JSONB,
    "usage" JSONB,
    "llm_calls" JSONB,
    "tool_calls" JSONB,
    "child_calls" JSONB,
    "llm_call_count" INTEGER NOT NULL DEFAULT 0,
    "memory_op_count" INTEGER NOT NULL DEFAULT 0,
    "tool_call_count" INTEGER NOT NULL DEFAULT 0,
    "child_call_count" INTEGER NOT NULL DEFAULT 0,
    "input_tokens" INTEGER NOT NULL DEFAULT 0,
    "output_tokens" INTEGER NOT NULL DEFAULT 0,
    "known_cost_usd" DECIMAL(18,6),
    "trace_id" TEXT,
    "span_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "cognitive_turn_runs_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "cognitive_turn_runs_tenant_id_task_id_identity_key_key" ON "cognitive_turn_runs"("tenant_id", "task_id", "identity_key");
CREATE INDEX "cognitive_turn_runs_tenant_id_task_id_cognition_turn_seq_idx" ON "cognitive_turn_runs"("tenant_id", "task_id", "cognition_turn_seq");
CREATE INDEX "cognitive_turn_runs_tenant_id_root_task_id_task_id_segment_idx" ON "cognitive_turn_runs"("tenant_id", "root_task_id", "task_id", "segment_seq");
CREATE INDEX "cognitive_turn_runs_tenant_id_task_id_attempt_key_idx" ON "cognitive_turn_runs"("tenant_id", "task_id", "attempt_key");
