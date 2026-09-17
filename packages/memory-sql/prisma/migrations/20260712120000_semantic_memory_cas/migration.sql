-- Sequence-backed generations prevent a stale CAS token from becoming valid
-- again after a semantic-memory row is deleted and recreated.
CREATE SEQUENCE "agent_memory_store_version_seq" AS BIGINT;

ALTER TABLE "agent_memory_store" ADD COLUMN "version" BIGINT;

UPDATE "agent_memory_store"
SET "version" = nextval('"agent_memory_store_version_seq"');

ALTER TABLE "agent_memory_store"
    ALTER COLUMN "version" SET DEFAULT nextval('"agent_memory_store_version_seq"'),
    ALTER COLUMN "version" SET NOT NULL;

ALTER SEQUENCE "agent_memory_store_version_seq"
    OWNED BY "agent_memory_store"."version";

CREATE FUNCTION "agent_memory_store_bump_version"()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
    NEW."version" := nextval('"agent_memory_store_version_seq"');
    RETURN NEW;
END;
$$;

CREATE TRIGGER "agent_memory_store_bump_version"
BEFORE UPDATE ON "agent_memory_store"
FOR EACH ROW
EXECUTE FUNCTION "agent_memory_store_bump_version"();
