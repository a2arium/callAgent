import { afterAll, beforeAll, describe, expect, test } from '@jest/globals';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '@a2arium/callagent-memory-sql/generated';
import {
    WorkingMemorySessionStore,
    getSafePgConfig,
} from '@a2arium/callagent-memory-sql';
import { SessionManager } from '../src/orchestration/SessionManager.js';
import { reconcileSnapshotMutation } from '../src/orchestration/persistence/SnapshotRepository.js';
import { claimOutboxRow, deleteClaimedOutboxRow } from '../src/eventbus/outboxDispatch.js';

const databaseUrl = process.env.MEMORY_DATABASE_URL;
const describeIfPostgres = databaseUrl ? describe : describe.skip;

describeIfPostgres('working-memory CAS reconciliation on PostgreSQL', () => {
    const tenantId = `wm-cas-${Date.now()}`;
    const sessionId = `session-${Math.random().toString(36).slice(2)}`;
    let prismaA: InstanceType<typeof PrismaClient>;
    let prismaB: InstanceType<typeof PrismaClient>;
    let managerA: SessionManager;
    let managerB: SessionManager;

    beforeAll(async () => {
        prismaA = new PrismaClient({ adapter: new PrismaPg(getSafePgConfig(databaseUrl!)) });
        prismaB = new PrismaClient({ adapter: new PrismaPg(getSafePgConfig(databaseUrl!)) });
        managerA = new SessionManager(new WorkingMemorySessionStore(prismaA));
        managerB = new SessionManager(new WorkingMemorySessionStore(prismaB));
        await managerA.saveSnapshot({
            tenantId,
            sessionId,
            agentId: 'parent',
            expectedWmVersion: BigInt(0),
            snapshot: { seeded: true },
        });
    });

    afterAll(async () => {
        await prismaA?.outbox.deleteMany({ where: { tenantId } });
        await prismaA?.wMSession.deleteMany({ where: { tenantId, sessionId } });
        await Promise.all([prismaA?.$disconnect(), prismaB?.$disconnect()]);
    });

    test('one stale writer reloads and commits without losing either logical mutation', async () => {
        let arrivals = 0;
        let release!: () => void;
        const barrier = new Promise<void>((resolve) => { release = resolve; });
        const wrapWithFirstLoadBarrier = (manager: SessionManager) => {
            let firstLoad = true;
            return {
                load: async (tenant: string, session: string) => {
                    const loaded = await manager.load(tenant, session);
                    if (firstLoad) {
                        firstLoad = false;
                        arrivals += 1;
                        if (arrivals === 2) release();
                        await barrier;
                    }
                    return loaded;
                },
                saveSnapshot: manager.saveSnapshot.bind(manager),
            };
        };

        const [left, right] = await Promise.all([
            reconcileSnapshotMutation({
                session: wrapWithFirstLoadBarrier(managerA),
                tenantId,
                sessionId,
                operation: 'postgres.race.left',
                random: () => 0,
                mutate: ({ snapshot }) => ({
                    kind: 'write', snapshot: { ...snapshot, left: true }, value: undefined,
                }),
            }),
            reconcileSnapshotMutation({
                session: wrapWithFirstLoadBarrier(managerB),
                tenantId,
                sessionId,
                operation: 'postgres.race.right',
                random: () => 0,
                mutate: ({ snapshot }) => ({
                    kind: 'write', snapshot: { ...snapshot, right: true }, value: undefined,
                }),
            }),
        ]);

        expect([left.attempts, right.attempts].sort()).toEqual([1, 2]);
        expect((await managerA.load(tenantId, sessionId))?.snapshot).toEqual({
            seeded: true,
            left: true,
            right: true,
        });
    });

    test('storage mutation time is UTC-correct under a non-UTC PostgreSQL timezone', async () => {
        const before = Date.now();
        const loaded = await managerA.loadForMutation(tenantId, sessionId);
        const after = Date.now();
        const storageMs = Date.parse(loaded!.storageNow!);
        expect(storageMs).toBeGreaterThanOrEqual(before - 1_000);
        expect(storageMs).toBeLessThanOrEqual(after + 1_000);
    });

    test('two shared dispatchers cannot own the same outbox lease', async () => {
        managerA.configureOutboxDelivery({ scope: 'shared' });
        const enqueued = await managerA.enqueueOutbox(
            tenantId,
            'task.status',
            sessionId,
            { taskId: sessionId, status: { state: 'completed' }, final: true },
            undefined,
            `${tenantId}:leased-row`
        );
        if (!enqueued) throw new Error('outbox row missing');
        const [left, right] = await Promise.all([
            claimOutboxRow({ prisma: prismaA as never, id: enqueued.id, leaseId: 'lease-left', scope: 'shared' }),
            claimOutboxRow({ prisma: prismaB as never, id: enqueued.id, leaseId: 'lease-right', scope: 'shared' }),
        ]);
        expect([left.disposition, right.disposition].filter((value) => value === 'claimed')).toHaveLength(1);
        const winner = left.disposition === 'claimed' ? 'lease-left' : 'lease-right';
        await expect(deleteClaimedOutboxRow({
            prisma: prismaA as never,
            id: enqueued.id,
            leaseId: winner,
        })).resolves.toBe(true);
    });
});
