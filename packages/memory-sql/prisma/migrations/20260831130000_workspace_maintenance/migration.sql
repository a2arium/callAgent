-- Workspace-owned maintenance uses tenant-scoped expiry scans and a durable lease.
CREATE INDEX "agent_result_cache_tenant_id_expires_at_idx"
ON "agent_result_cache"("tenant_id", "expires_at");

CREATE TABLE "maintenance_leases" (
    "tenant_id" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "holder_id" TEXT NOT NULL,
    "lease_until" TIMESTAMP(3) NOT NULL,
    "updated_at" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "maintenance_leases_pkey" PRIMARY KEY ("tenant_id", "key")
);

CREATE INDEX "maintenance_leases_lease_until_idx" ON "maintenance_leases"("lease_until");
