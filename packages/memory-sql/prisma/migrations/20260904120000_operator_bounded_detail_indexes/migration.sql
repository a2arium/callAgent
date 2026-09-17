-- Keyset indexes for bounded Operator graph summaries and detail pages.
CREATE INDEX "wm_events_tenant_id_session_id_seq_event_id_idx"
    ON "wm_events"("tenant_id", "session_id", "seq", "event_id");
CREATE INDEX "driver_runs_tenant_id_task_id_created_at_id_idx"
    ON "driver_runs"("tenant_id", "task_id", "created_at", "id");
CREATE INDEX "turn_runs_tenant_id_task_id_turn_seq_id_idx"
    ON "turn_runs"("tenant_id", "task_id", "turn_seq", "id");
CREATE INDEX "cognitive_turn_runs_tenant_id_task_id_segment_seq_cognition_turn_seq_id_idx"
    ON "cognitive_turn_runs"("tenant_id", "task_id", "segment_seq", "cognition_turn_seq", "id");
CREATE INDEX "run_effects_tenant_id_task_id_updated_at_id_idx"
    ON "run_effects"("tenant_id", "task_id", "updated_at", "id");
