import { PrismaClient } from '@prisma/client';

describe('Prisma mock sanity', () => {
    it('stores data in memory and can be reset', async () => {
        const prisma = new PrismaClient() as any;

        await prisma.outbox.create({
            data: {
                id: 'mock-1',
                tenantId: 'tenant-1',
                topic: 'task.status',
                key: 'test-key',
                payload: { ok: true },
                createdAt: new Date()
            }
        });

        const rows = await prisma.outbox.findMany({ where: { tenantId: 'tenant-1' } });
        expect(rows).toHaveLength(1);
        expect(rows[0].key).toBe('test-key');
    });
});

