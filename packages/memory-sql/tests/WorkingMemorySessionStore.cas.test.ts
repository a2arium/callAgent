import { jest } from '@jest/globals';
import { isWorkingMemoryVersionConflict } from '@a2arium/callagent-types';
import { WorkingMemorySessionStore } from '../src/WorkingMemorySessionStore.js';

function createPrisma() {
    const prisma: any = {
        $connect: jest.fn(async () => undefined),
        $queryRaw: jest.fn(),
        wMSession: {
            updateMany: jest.fn(),
            create: jest.fn(),
            findUnique: jest.fn(),
        },
    };
    prisma.$transaction = jest.fn(async (callback: (tx: typeof prisma) => unknown) => callback(prisma));
    return prisma;
}

const params = {
    tenantId: 'tenant',
    sessionId: 'session',
    agentId: 'agent',
    expectedWmVersion: BigInt(3),
    snapshot: { next: true },
};

describe('WorkingMemorySessionStore.writeSnapshotCAS', () => {
    test('loads an authoritative PostgreSQL timestamp with mutation snapshots', async () => {
        const prisma = createPrisma();
        prisma.$queryRaw.mockResolvedValue([{ storageNow: new Date('2026-07-19T10:00:00.000Z') }]);
        prisma.wMSession.findUnique.mockResolvedValue({
            wmVersion: 4n,
            snapshot: { active: true },
            agentId: 'agent',
            updatedAt: new Date('2026-07-19T09:59:00.000Z'),
        });
        const store = new WorkingMemorySessionStore(prisma as never);

        await expect(store.getSessionSnapshotForMutation('tenant', 'session')).resolves.toEqual({
            wmVersion: 4n,
            snapshot: { active: true },
            agentId: 'agent',
            updatedAt: '2026-07-19T09:59:00.000Z',
            storageNow: '2026-07-19T10:00:00.000Z',
        });
        expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    });

    test('uses a version-qualified atomic update and increments the version', async () => {
        const prisma = createPrisma();
        prisma.wMSession.updateMany.mockResolvedValue({ count: 1 });
        const store = new WorkingMemorySessionStore(prisma as never);

        await expect(store.writeSnapshotCAS(params)).resolves.toEqual({ newVersion: BigInt(4) });
        expect(prisma.wMSession.updateMany).toHaveBeenCalledWith({
            where: { tenantId: 'tenant', sessionId: 'session', wmVersion: BigInt(3) },
            data: { snapshot: { next: true }, wmVersion: { increment: BigInt(1) } },
        });
        expect(prisma.wMSession.create).not.toHaveBeenCalled();
    });

    test('creates version one when expected version zero has no row', async () => {
        const prisma = createPrisma();
        prisma.wMSession.updateMany.mockResolvedValue({ count: 0 });
        prisma.wMSession.create.mockResolvedValue({});
        const store = new WorkingMemorySessionStore(prisma as never);

        await expect(store.writeSnapshotCAS({ ...params, expectedWmVersion: BigInt(0) }))
            .resolves.toEqual({ newVersion: BigInt(1) });
        expect(prisma.wMSession.create).toHaveBeenCalledWith({
            data: expect.objectContaining({ wmVersion: BigInt(1), agentId: 'agent' }),
        });
    });

    test('translates a concurrent create P2002 into a typed conflict with diagnostics', async () => {
        const prisma = createPrisma();
        prisma.wMSession.updateMany.mockResolvedValue({ count: 0 });
        prisma.wMSession.create.mockRejectedValue({ code: 'P2002' });
        prisma.wMSession.findUnique.mockResolvedValue({ wmVersion: BigInt(1) });
        const store = new WorkingMemorySessionStore(prisma as never);

        let caught: unknown;
        try {
            await store.writeSnapshotCAS({ ...params, expectedWmVersion: BigInt(0) });
        } catch (error) {
            caught = error;
        }
        expect(isWorkingMemoryVersionConflict(caught)).toBe(true);
        expect(caught).toMatchObject({
            code: 'WM_VERSION_CONFLICT',
            conflict: { expectedWmVersion: '0', actualWmVersion: '1' },
        });
    });

    test('reports a stale update as a typed conflict and does not change agentId', async () => {
        const prisma = createPrisma();
        prisma.wMSession.updateMany.mockResolvedValue({ count: 0 });
        prisma.wMSession.findUnique.mockResolvedValue({ wmVersion: BigInt(9) });
        const store = new WorkingMemorySessionStore(prisma as never);

        await expect(store.writeSnapshotCAS(params)).rejects.toMatchObject({
            code: 'WM_VERSION_CONFLICT',
            conflict: { expectedWmVersion: '3', actualWmVersion: '9' },
        });
        const update = prisma.wMSession.updateMany.mock.calls[0]?.[0] as any;
        expect(update.data.agentId).toBeUndefined();
    });
});
