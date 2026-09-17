SET lock_timeout = '5s';
SET statement_timeout = '5min';

ALTER TABLE "agent_memory_store"
    ALTER COLUMN "tags" SET DEFAULT ARRAY[]::text[];

DO $$
DECLARE
    null_rows bigint;
BEGIN
    SELECT count(*) INTO null_rows
    FROM "agent_memory_store"
    WHERE "tags" IS NULL;

    IF null_rows > 10000 THEN
        RAISE EXCEPTION 'semantic tag null backfill requires operator batching (% rows exceed automatic threshold)', null_rows;
    END IF;

    UPDATE "agent_memory_store"
    SET "tags" = ARRAY[]::text[]
    WHERE "tags" IS NULL;
END $$;

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1
        FROM pg_constraint
        WHERE conname = 'agent_memory_store_tags_not_null_check'
          AND conrelid = 'agent_memory_store'::regclass
    ) THEN
        ALTER TABLE "agent_memory_store"
            ADD CONSTRAINT "agent_memory_store_tags_not_null_check"
            CHECK ("tags" IS NOT NULL) NOT VALID;
    END IF;
END $$;

ALTER TABLE "agent_memory_store"
    VALIDATE CONSTRAINT "agent_memory_store_tags_not_null_check";

ALTER TABLE "agent_memory_store"
    ALTER COLUMN "tags" SET NOT NULL;

ALTER TABLE "agent_memory_store"
    DROP CONSTRAINT IF EXISTS "agent_memory_store_tags_not_null_check";
