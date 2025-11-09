import { PrismaClient, Prisma } from '@prisma/client';
import { logger } from '@a2arium/callagent-utils';

export type SessionSnapshot = {
    wmVersion: bigint;
    snapshot: Record<string, unknown>;
    agentId: string;
    updatedAt: string;
};

export class WorkingMemorySessionStore {
    private readonly prisma: PrismaClient;
    private readonly ownsPrisma: boolean;
    private readonly log = logger.createLogger({ prefix: 'WMSessionStore' });
    private connecting: Promise<void> | null = null;

    constructor(prisma?: PrismaClient) {
        if (prisma) {
            this.prisma = prisma;
            this.ownsPrisma = false;
        } else {
            this.prisma = new PrismaClient();
            this.ownsPrisma = true;
        }
    }

    private async ensureConnected(): Promise<void> {
        if (this.connecting) {
            await this.connecting;
            return;
        }
        this.connecting = this.prisma.$connect().catch((err) => {
            // Reset so a later call can retry
            this.connecting = null;
            throw err;
        });
        try {
            await this.connecting;
        } finally {
            this.connecting = null;
        }
    }

    private async runWithReconnect<T>(operation: () => Promise<T>): Promise<T> {
        try {
            return await operation();
        } catch (error) {
            if (error instanceof Error && error.message.includes('Engine is not yet connected')) {
                await this.prisma.$connect();
                return await operation();
            }
            throw error;
        }
    }

    async disconnect(): Promise<void> {
        if (this.ownsPrisma) await this.prisma.$disconnect();
    }

    // Back-compat alias for runner clean shutdown
    async close(): Promise<void> {
        await this.disconnect();
    }

    async getSessionSnapshot(tenantId: string, sessionId: string): Promise<SessionSnapshot | null> {
        await this.ensureConnected();
        const rec = await this.runWithReconnect(() => this.prisma.wMSession.findUnique({
            where: { tenantId_sessionId: { tenantId, sessionId } }
        }));
        if (!rec) return null;
        return {
            wmVersion: rec.wmVersion,
            snapshot: (rec.snapshot as unknown) as Record<string, unknown>,
            agentId: rec.agentId,
            updatedAt: rec.updatedAt.toISOString()
        };
    }

    /**
     * Atomic compare-and-set snapshot.
     * Throws Error('CAS_MISMATCH') if expected != current.
     */
    async writeSnapshotCAS(params: {
        tenantId: string;
        sessionId: string;
        agentId: string;
        expectedWmVersion: bigint;
        snapshot: Record<string, unknown>;
    }): Promise<{ newVersion: bigint }> {
        const { tenantId, sessionId, agentId, expectedWmVersion, snapshot } = params;

        await this.ensureConnected();
        return await this.runWithReconnect(() => this.prisma.$transaction(async (tx) => {
            const existing = await tx.wMSession.findUnique({
                where: { tenantId_sessionId: { tenantId, sessionId } },
                select: { wmVersion: true }
            });

            const currentVersion = existing?.wmVersion ?? BigInt(0);
            if (currentVersion !== expectedWmVersion) {
                this.log.debug?.('CAS mismatch on writeSnapshotCAS (will retry upstream)', {
                    tenantId,
                    sessionId,
                    expectedWmVersion: expectedWmVersion.toString(),
                    currentVersion: currentVersion.toString()
                });
                throw new Error('CAS_MISMATCH');
            }

            const newVersion = currentVersion + BigInt(1);
            await tx.wMSession.upsert({
                where: { tenantId_sessionId: { tenantId, sessionId } },
                update: { snapshot: snapshot as unknown as any, wmVersion: newVersion },
                create: { tenantId, sessionId, agentId, snapshot: snapshot as unknown as any, wmVersion: newVersion }
            });

            return { newVersion };
        }));
    }

    /**
     * Append an event with sequential seq per (tenantId, sessionId).
     */
    async appendEvent(params: {
        tenantId: string;
        sessionId: string;
        type: string;
        payload: Record<string, unknown>;
    }): Promise<{ eventId: string; seq: number }> {
        const { tenantId, sessionId, type, payload } = params;

        await this.ensureConnected();
        return await this.runWithReconnect(() => this.prisma.$transaction(async (tx) => {
            const last = await tx.wMEvent.findFirst({
                where: { tenantId, sessionId },
                orderBy: { seq: 'desc' },
                select: { seq: true }
            });
            const nextSeq = (last?.seq ?? 0) + 1;
            const ev = await tx.wMEvent.create({
                data: { tenantId, sessionId, seq: nextSeq, type, payload: payload as unknown as any }
            });
            return { eventId: ev.eventId, seq: ev.seq };
        }));
    }

    async listEventsSince(params: { tenantId: string; sessionId: string; sinceSeq: number }): Promise<Array<{ eventId: string; seq: number; type: string; payload: Record<string, unknown>; createdAt: string }>> {
        const { tenantId, sessionId, sinceSeq } = params;
        const rows = await this.prisma.wMEvent.findMany({
            where: { tenantId, sessionId, seq: { gt: sinceSeq } },
            orderBy: { seq: 'asc' }
        });
        return rows.map((r: any) => ({ eventId: r.eventId, seq: r.seq, type: r.type, payload: r.payload as any, createdAt: r.createdAt.toISOString() }));
    }

    async enqueueOutbox(params: {
        tenantId: string;
        topic: string;
        key: string;
        payload: Record<string, unknown>;
    }): Promise<void> {
        const { tenantId, topic, key, payload } = params;
        await this.ensureConnected();
        await this.runWithReconnect(() => this.prisma.outbox.create({ data: { tenantId, topic, key, payload: payload as unknown as any } }));
    }
}


