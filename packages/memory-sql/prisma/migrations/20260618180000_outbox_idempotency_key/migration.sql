-- Add a deterministic effect key for segment-produced outbox rows.
-- PostgreSQL allows multiple NULLs in a unique index, so legacy/non-segment
-- rows can continue to omit the key while retried segment effects dedupe.
ALTER TABLE "outbox" ADD COLUMN "idempotency_key" TEXT;

CREATE UNIQUE INDEX "outbox_idempotency_key_key" ON "outbox"("idempotency_key");
