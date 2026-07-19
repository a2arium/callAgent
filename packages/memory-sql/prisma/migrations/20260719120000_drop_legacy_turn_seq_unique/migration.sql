-- The original turn-run uniqueness was created as an index, not a table
-- constraint. The preceding ownership migration's DROP CONSTRAINT therefore
-- did not remove it on already-migrated databases.
DROP INDEX IF EXISTS "turn_runs_tenant_id_task_id_turn_seq_key";
