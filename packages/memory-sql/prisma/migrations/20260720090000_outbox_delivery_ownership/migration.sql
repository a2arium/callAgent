ALTER TABLE "outbox"
    ADD COLUMN IF NOT EXISTS "delivery_scope" TEXT,
    ADD COLUMN IF NOT EXISTS "delivery_owner_id" TEXT,
    ADD COLUMN IF NOT EXISTS "dispatch_lease_id" TEXT,
    ADD COLUMN IF NOT EXISTS "dispatch_lease_until" TIMESTAMPTZ(3);

CREATE INDEX IF NOT EXISTS "outbox_delivery_scope_created_at_idx"
    ON "outbox"("delivery_scope", "created_at");

CREATE INDEX IF NOT EXISTS "outbox_shared_dispatch_due_idx"
    ON "outbox"("created_at", "dispatch_lease_until")
    WHERE "delivery_scope" = 'shared' OR "delivery_scope" IS NULL;
