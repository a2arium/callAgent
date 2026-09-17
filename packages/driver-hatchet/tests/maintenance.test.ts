import { describe, expect, it, jest } from '@jest/globals';
import { WorkspaceMaintenanceService } from '../src/maintenance.js';

function prisma(rows: Array<{ id: string; tenantId: string; expiresAt: Date }>) {
    const leases = new Map<string, { holderId: string; leaseUntil: Date }>();
    return {
        agentResultCache: {
            count: jest.fn(async ({ where }: any = {}) => rows.filter((row) =>
                (!where?.tenantId || row.tenantId === where.tenantId) &&
                (!where?.expiresAt?.lt || row.expiresAt < where.expiresAt.lt)).length),
            findMany: jest.fn(async ({ where, take }: any) => rows.filter((row) => row.tenantId === where.tenantId && row.expiresAt < where.expiresAt.lt).slice(0, take)),
            deleteMany: jest.fn(async ({ where }: any) => {
                const ids = new Set(where.id.in);
                let count = 0;
                for (let index = rows.length - 1; index >= 0; index -= 1) if (rows[index]!.tenantId === where.tenantId && ids.has(rows[index]!.id)) { rows.splice(index, 1); count += 1; }
                return { count };
            }),
        },
        maintenanceLease: {
            updateMany: jest.fn(async ({ where, data }: any) => {
                const key = `${where.tenantId}:${where.key}`;
                const lease = leases.get(key);
                if (!lease) return { count: 0 };
                if (where.holderId) {
                    if (lease.holderId !== where.holderId) return { count: 0 };
                } else if (!(lease.leaseUntil <= where.leaseUntil.lte)) return { count: 0 };
                leases.set(key, { holderId: data.holderId ?? lease.holderId, leaseUntil: data.leaseUntil });
                return { count: 1 };
            }),
            create: jest.fn(async ({ data }: any) => { leases.set(`${data.tenantId}:${data.key}`, { holderId: data.holderId, leaseUntil: data.leaseUntil }); }),
            deleteMany: jest.fn(async ({ where }: any) => { leases.delete(`${where.tenantId}:${where.key}`); return { count: 1 }; }),
        },
    };
}

describe('WorkspaceMaintenanceService', () => {
    it('deletes only expired entries for its tenant in bounded batches', async () => {
        const rows = [
            { id: 'expired-a', tenantId: 'a', expiresAt: new Date(Date.now() - 1_000) },
            { id: 'active-a', tenantId: 'a', expiresAt: new Date(Date.now() + 1_000) },
            { id: 'expired-b', tenantId: 'b', expiresAt: new Date(Date.now() - 1_000) },
        ];
        const service = new WorkspaceMaintenanceService(prisma(rows) as never, {
            CALLAGENT_MAINTENANCE_TENANT_ID: 'a', CALLAGENT_MAINTENANCE_BATCH_SIZE: '1', CALLAGENT_MAINTENANCE_INSTALLATION_ID: 'test',
        });
        const result = await service.run('expire');
        expect(result).toMatchObject({ deleted: 1, skipped: false });
        expect(rows.map((row) => row.id).sort()).toEqual(['active-a', 'expired-b']);
    });

    it('does not run manually from a non-owner workspace', async () => {
        const service = new WorkspaceMaintenanceService(prisma([]) as never, {
            CALLAGENT_MAINTENANCE_OWNER: 'false', CALLAGENT_MAINTENANCE_INSTALLATION_ID: 'test',
        });
        await expect(service.run('expire', { requireOwner: true })).resolves.toMatchObject({ skipped: true, reason: 'not-owner' });
    });
});
