-- AlterTable
ALTER TABLE "agent_memory_store" ADD COLUMN     "blob_data" BYTEA,
ADD COLUMN     "blob_metadata" JSONB;

-- CreateIndex
CREATE INDEX "agent_memory_store_tenant_id_blob_data_idx" ON "agent_memory_store"("tenant_id", "blob_data");
