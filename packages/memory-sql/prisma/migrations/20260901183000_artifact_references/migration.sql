CREATE TABLE "artifact_references" (
    "tenant_id" TEXT NOT NULL,
    "artifact_id" TEXT NOT NULL,
    "owner_id" TEXT NOT NULL,
    "cache_entry_id" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "artifact_references_pkey" PRIMARY KEY ("tenant_id", "artifact_id", "owner_id"),
    CONSTRAINT "artifact_references_cache_entry_id_fkey"
        FOREIGN KEY ("cache_entry_id") REFERENCES "agent_result_cache"("id")
        ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE INDEX "artifact_references_tenant_id_owner_id_idx"
    ON "artifact_references"("tenant_id", "owner_id");
CREATE INDEX "artifact_references_cache_entry_id_idx"
    ON "artifact_references"("cache_entry_id");
