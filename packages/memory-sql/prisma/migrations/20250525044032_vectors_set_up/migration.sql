-- AlterTable
ALTER TABLE "agent_memory_store" ADD COLUMN     "embedding" REAL[] DEFAULT ARRAY[]::REAL[];

-- CreateTable
CREATE TABLE "entity_store" (
    "id" TEXT NOT NULL,
    "entity_type" TEXT NOT NULL,
    "canonical_name" TEXT NOT NULL,
    "aliases" TEXT[],
    "embedding" REAL[],
    "metadata" JSONB NOT NULL DEFAULT '{}',
    "confidence" DOUBLE PRECISION NOT NULL DEFAULT 1.0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "entity_store_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "entity_alignment" (
    "id" TEXT NOT NULL,
    "memory_key" TEXT NOT NULL,
    "field_path" TEXT NOT NULL,
    "entity_id" TEXT NOT NULL,
    "original_value" TEXT NOT NULL,
    "confidence" TEXT NOT NULL,
    "aligned_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "entity_alignment_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "entity_store_entity_type_canonical_name_key" ON "entity_store"("entity_type", "canonical_name");

-- CreateIndex
CREATE UNIQUE INDEX "entity_alignment_memory_key_field_path_key" ON "entity_alignment"("memory_key", "field_path");

-- AddForeignKey
ALTER TABLE "entity_alignment" ADD CONSTRAINT "entity_alignment_entity_id_fkey" FOREIGN KEY ("entity_id") REFERENCES "entity_store"("id") ON DELETE CASCADE ON UPDATE CASCADE;
