-- Older projections could leave a logical run marked running after its
-- authoritative committed turn reached an await boundary.  New projections
-- write waiting directly; this migration repairs existing rows without
-- changing terminal runs.
WITH latest_turn AS (
    SELECT DISTINCT ON (tenant_id, task_id)
        tenant_id,
        task_id,
        boundary_kind,
        completed_at
    FROM turn_runs
    WHERE disposition = 'executed'
      AND boundary_kind IN ('await_input', 'await_tool', 'await_child', 'await_event')
    ORDER BY tenant_id, task_id, turn_seq DESC NULLS LAST, completed_at DESC NULLS LAST, id DESC
)
UPDATE agent_runs AS run
SET status = 'waiting',
    updated_at = GREATEST(run.updated_at, COALESCE(latest_turn.completed_at, run.updated_at))
FROM latest_turn
WHERE run.tenant_id = latest_turn.tenant_id
  AND run.task_id = latest_turn.task_id
  AND run.status IN ('unknown', 'queued', 'running', 'waiting')
  AND run.terminal_at IS NULL;
