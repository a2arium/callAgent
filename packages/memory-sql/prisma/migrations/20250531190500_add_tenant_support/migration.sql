/*
  Warnings:

  - The primary key for the `agent_memory_store` table will be changed. If it partially fails, the table could be left without primary key constraint.
  - A unique constraint covering the columns `[tenant_id,memory_key,field_path]` on the table `entity_alignment` will be added. If there are existing duplicate values, this will fail.
  - A unique constraint covering the columns `[tenant_id,entity_type,canonical_name]` on the table `entity_store` will be added. If there are existing duplicate values, this will fail.
  - Made the column `embedding` on table `entity_store` required. This step will fail if there are existing NULL values in that column.

*/
-- DropIndex
DROP INDEX "idx_memory_store_embedding";

-- DropIndex
DROP INDEX "entity_alignment_memory_key_field_path_key";

-- DropIndex
DROP INDEX "idx_entity_alignment_memory_key";

-- DropIndex
DROP INDEX "entity_store_entity_type_canonical_name_key";

-- DropIndex
DROP INDEX "idx_entity_store_embedding";

-- DropIndex
DROP INDEX "idx_entity_store_type";

-- AlterTable
ALTER TABLE "agent_memory_store" DROP CONSTRAINT "agent_memory_store_pkey",
ADD COLUMN     "tenant_id" TEXT NOT NULL DEFAULT 'default',
ALTER COLUMN "embedding" DROP DEFAULT,
ADD CONSTRAINT "agent_memory_store_pkey" PRIMARY KEY ("tenant_id", "key");

-- AlterTable
ALTER TABLE "entity_alignment" ADD COLUMN     "tenant_id" TEXT NOT NULL DEFAULT 'default';

-- AlterTable
ALTER TABLE "entity_store" ADD COLUMN     "tenant_id" TEXT NOT NULL DEFAULT 'default',
ALTER COLUMN "embedding" SET NOT NULL;

-- CreateIndex
CREATE INDEX "agent_memory_store_tenant_id_idx" ON "agent_memory_store"("tenant_id");

-- CreateIndex
CREATE INDEX "entity_alignment_tenant_id_idx" ON "entity_alignment"("tenant_id");

-- CreateIndex
CREATE INDEX "entity_alignment_tenant_id_memory_key_idx" ON "entity_alignment"("tenant_id", "memory_key");

-- CreateIndex
CREATE UNIQUE INDEX "entity_alignment_tenant_id_memory_key_field_path_key" ON "entity_alignment"("tenant_id", "memory_key", "field_path");

-- CreateIndex
CREATE INDEX "entity_store_tenant_id_idx" ON "entity_store"("tenant_id");

-- CreateIndex
CREATE INDEX "entity_store_tenant_id_entity_type_idx" ON "entity_store"("tenant_id", "entity_type");

-- CreateIndex
CREATE UNIQUE INDEX "entity_store_tenant_id_entity_type_canonical_name_key" ON "entity_store"("tenant_id", "entity_type", "canonical_name");
